import type {
  InvoiceFact,
  OrderLineFact,
  OrderLookupResult,
  OrderProvider,
  OrderRecord,
  OrderScopeRule,
  ParcelFact,
  ReferenceQuery,
  ShipmentFact,
} from "../../core/contracts.ts";
import { assertAllowedEndpoint, HttpError, requestJson } from "../http.ts";

/**
 * Read-only weclapp REST API v2 adapter (sole OrderProvider in v1).
 *
 * Field names follow the official v2 OpenAPI specification
 * (https://www.weclapp.com/api/openapi_v2.yaml, reviewed 2026-10-21 via the
 * generated v2 model documentation): salesOrder.orderNumber /
 * orderNumberAtCustomer / orderItems / salesChannel / ecommerceOrder,
 * shipment.parcels[].trackingId / trackingUrl (packageTracking* is deprecated),
 * shipment.shipmentItems[].salesOrderItemId, shipment.mainSalesOrderId and
 * salesInvoice.salesOrderId. The exact mapping of marketplace order numbers to
 * these fields must be confirmed against the operator's tenant (M0 data check).
 *
 * The adapter only issues GET requests. It never creates, rotates or replaces
 * the API token: per weclapp documentation, generating a new token can
 * invalidate the user's previous tokens and break existing integrations.
 */
export interface WeclappConfig {
  /** e.g. https://<tenant>.weclapp.com/webapp/api/v2 */
  baseUrl: string;
  apiToken: string;
  searchFields: ReadonlyArray<string>;
  timeoutMs?: number;
  allowTestEndpoints?: boolean;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;

const SEARCHABLE = new Set(["orderNumberAtCustomer", "orderNumber", "ecommerceOrder.ecommerceId"]);

function str(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** weclapp timestamps are epoch milliseconds. */
function isoDate(value: unknown): string | undefined {
  const n = num(value);
  return n === undefined ? undefined : new Date(n).toISOString();
}

function arr(value: unknown): Json[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Json[]) : [];
}

export function validateWeclappBaseUrl(baseUrl: string, allowTestEndpoints: boolean): string {
  const url = assertAllowedEndpoint(baseUrl, allowTestEndpoints, (u) => u.hostname.endsWith(".weclapp.com"));
  const normalized = url.toString().replace(/\/+$/, "");
  if (!allowTestEndpoints && !normalized.endsWith("/webapp/api/v2")) {
    throw new Error("Die weclapp-URL muss auf /webapp/api/v2 enden (REST API v2).");
  }
  return normalized;
}

export function scopeMatches(order: Json, scope: OrderScopeRule): boolean {
  switch (scope.field) {
    case "none":
      return true;
    case "salesChannel":
      return str(order.salesChannel) === scope.value;
    case "customerId":
      return str(order.customerId) === scope.value;
    case "ecommerceConnectionId":
      return str((order.ecommerceOrder as Json | undefined)?.externalConnectionId) === scope.value;
    case "tag":
      return Array.isArray(order.tags) && order.tags.map(String).includes(scope.value);
  }
}

function mapParcels(shipment: Json): ParcelFact[] {
  const parcels: ParcelFact[] = arr(shipment.parcels).map((p) => ({
    id: str(p.id),
    trackingId: str(p.trackingId),
    trackingUrl: str(p.trackingUrl),
    carrierId: str(p.shippingCarrierId),
    reference: str(p.reference),
    source: "parcels" as const,
  }));
  // Deprecated single-package fields are only used when no parcel list exists,
  // and are labelled as such. Several parcels are never collapsed into one.
  if (parcels.length === 0 && (str(shipment.packageTrackingNumber) || str(shipment.packageTrackingUrl))) {
    parcels.push({
      trackingId: str(shipment.packageTrackingNumber),
      trackingUrl: str(shipment.packageTrackingUrl),
      carrierId: str(shipment.shippingCarrierId),
      source: "legacy_package_tracking",
    });
  }
  return parcels.filter((p) => p.trackingId || p.trackingUrl || p.id);
}

export function mapShipment(shipment: Json, linesById: Map<string, OrderLineFact>): ShipmentFact {
  const history = arr(shipment.statusHistory)
    .map((h) => ({ status: str(h.status) ?? "UNKNOWN", at: isoDate(h.statusDate) }))
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const status = str(shipment.status);
  const statusAt = [...history].reverse().find((h) => h.status === status)?.at;
  return {
    id: String(shipment.id),
    shipmentNumber: str(shipment.shipmentNumber),
    erpStatus: status,
    erpStatusAt: statusAt,
    statusHistory: history,
    shippingDate: isoDate(shipment.shippingDate),
    deliveryDate: isoDate(shipment.deliveryDate),
    items: arr(shipment.shipmentItems).map((item) => {
      const lineId = str(item.salesOrderItemId);
      return {
        orderLineId: lineId,
        title: str(item.title) ?? (lineId ? linesById.get(lineId)?.title : undefined),
        quantity: num(item.quantity) ?? 0,
      };
    }),
    parcels: mapParcels(shipment),
  };
}

export function mapOrder(order: Json, shipments: Json[], invoices: Json[], retrievedAt: string): OrderRecord {
  const lines: OrderLineFact[] = arr(order.orderItems).map((item, i) => ({
    id: String(item.id ?? `line-${i + 1}`),
    position: num(item.positionNumber),
    title: str(item.title) ?? str(item.description) ?? "Artikel",
    articleId: str(item.articleId),
    quantity: num(item.quantity) ?? 0,
    shippedQuantity: num(item.shippedQuantity),
    returnedQuantity: num(item.returnedQuantity),
  }));
  const linesById = new Map(lines.map((l) => [l.id, l]));
  const invoiceFacts: InvoiceFact[] = invoices.map((inv) => ({
    id: String(inv.id),
    invoiceNumber: str(inv.invoiceNumber),
    invoiceDate: isoDate(inv.invoiceDate),
    status: str(inv.status),
    paymentStatus: str(inv.paymentStatus),
  }));
  return {
    provider: "weclapp",
    id: String(order.id),
    orderNumber: str(order.orderNumber),
    orderNumberAtCustomer: str(order.orderNumberAtCustomer),
    orderDate: isoDate(order.orderDate),
    status: str(order.status),
    salesChannel: str(order.salesChannel),
    ecommerceConnectionId: str((order.ecommerceOrder as Json | undefined)?.externalConnectionId),
    customerId: str(order.customerId),
    tags: Array.isArray(order.tags) ? order.tags.map(String) : [],
    lines,
    shipments: shipments
      .map((s) => mapShipment(s, linesById))
      .sort((a, b) => (a.shippingDate ?? a.shipmentNumber ?? "").localeCompare(b.shippingDate ?? b.shipmentNumber ?? "")),
    invoices: invoiceFacts,
    retrievedAt,
  };
}

function belongsToOrder(shipment: Json, orderId: string): boolean {
  return str(shipment.mainSalesOrderId) === orderId || arr(shipment.salesOrders).some((o) => str(o.id) === orderId);
}

/** Sales orders an invoice or shipment belongs to. */
function orderIdsOf(record: Json): string[] {
  return [str(record.salesOrderId), str(record.mainSalesOrderId), ...arr(record.salesOrders).map((o) => str(o.id))].filter((id): id is string => !!id);
}

export class WeclappOrderProvider implements OrderProvider {
  readonly kind = "weclapp" as const;
  readonly #config: WeclappConfig;
  readonly #baseUrl: string;

  constructor(config: WeclappConfig) {
    this.#config = config;
    this.#baseUrl = validateWeclappBaseUrl(config.baseUrl, config.allowTestEndpoints ?? false);
    const unsupported = config.searchFields.filter((f) => !SEARCHABLE.has(f));
    if (unsupported.length > 0) throw new Error(`Nicht unterstützte weclapp-Suchfelder: ${unsupported.join(", ")}`);
  }

  async #get(resource: string, params: Record<string, string>): Promise<Json[]> {
    const url = new URL(`${this.#baseUrl}/${resource}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const body = await requestJson(url, {
      method: "GET",
      headers: { AuthenticationToken: this.#config.apiToken, Accept: "application/json" },
      timeoutMs: this.#config.timeoutMs ?? 15_000,
      fetchImpl: this.#config.fetchImpl,
    });
    const result = (body as Json | null)?.result;
    if (!Array.isArray(result)) throw new HttpError("Unerwartete weclapp-Antwort (kein result-Array).", 0, false);
    return result as Json[];
  }

  async #enrich(order: Json): Promise<OrderRecord> {
    const id = String(order.id);
    const [shipments, invoices] = await Promise.all([
      this.#get("shipment", { "mainSalesOrderId-eq": id, pageSize: "100" }),
      this.#get("salesInvoice", { "salesOrderId-eq": id, pageSize: "100" }),
    ]);
    return mapOrder(order, shipments.filter((s) => belongsToOrder(s, id)), invoices, new Date().toISOString());
  }

  /**
   * Exact lookups only: order numbers in the configured salesOrder fields,
   * invoice numbers in salesInvoice.invoiceNumber, parcel numbers in the
   * shipment's parcels. Every hit is compared again on the returned record.
   */
  async findOrders(references: ReadonlyArray<ReferenceQuery>, scope: OrderScopeRule): Promise<OrderLookupResult> {
    if (references.length === 0) return { status: "missing", triedReferences: [] };
    try {
      const found = new Map<string, { order: Json; matchedBy: string }>();
      let outOfScope = 0;
      const consider = (row: Json, matchedBy: string) => {
        if (!scopeMatches(row, scope)) {
          outOfScope++;
          return;
        }
        const id = String(row.id);
        if (!found.has(id)) found.set(id, { order: row, matchedBy });
      };
      const viaOrderIds = async (orderIds: Iterable<string>, matchedBy: string) => {
        for (const orderId of new Set(orderIds)) {
          const row = (await this.#get("salesOrder", { "id-eq": orderId, pageSize: "1" })).find((r) => String(r.id) === orderId);
          if (row) consider(row, matchedBy);
        }
      };
      for (const { value, kind } of references) {
        if (kind === "order") {
          for (const field of this.#config.searchFields) {
            const rows = await this.#get("salesOrder", { [`${field}-eq`]: value, pageSize: "20" });
            for (const row of rows) {
              // Exact comparison on the returned record; never trust a fuzzy server match.
              const actual = field === "ecommerceOrder.ecommerceId" ? str((row.ecommerceOrder as Json | undefined)?.ecommerceId) : str(row[field]);
              if (actual === value) consider(row, `${field}=${value}`);
            }
          }
        } else if (kind === "invoice") {
          const invoices = (await this.#get("salesInvoice", { "invoiceNumber-eq": value, pageSize: "20" })).filter((inv) => str(inv.invoiceNumber) === value);
          await viaOrderIds(invoices.flatMap(orderIdsOf), `Rechnungsnummer=${value}`);
        } else {
          const shipments = await this.#shipmentsByTracking(value);
          await viaOrderIds(shipments.flatMap(orderIdsOf), `Sendungsnummer=${value}`);
        }
      }
      if (found.size === 0) {
        return { status: "missing", triedReferences: [...new Set(references.map((r) => r.value))], ...(outOfScope > 0 ? { outOfScopeMatches: outOfScope } : {}) };
      }
      if (found.size > 1) {
        return {
          status: "ambiguous",
          candidates: [...found.values()].map(({ order, matchedBy }) => ({ id: String(order.id), orderNumber: str(order.orderNumber), matchedBy })),
        };
      }
      const [{ order, matchedBy }] = [...found.values()] as [{ order: Json; matchedBy: string }];
      return { status: "unique", order: await this.#enrich(order), matchedBy };
    } catch (error) {
      return toLookupError(error);
    }
  }

  /**
   * Parcel numbers live in shipment.parcels[].trackingId (older tenants:
   * packageTrackingNumber). A filter the tenant does not accept (HTTP 400) is
   * skipped, the other one still runs.
   */
  async #shipmentsByTracking(trackingId: string): Promise<Json[]> {
    const rows: Json[] = [];
    for (const filter of ["parcels.trackingId-eq", "packageTrackingNumber-eq"]) {
      try {
        rows.push(...(await this.#get("shipment", { [filter]: trackingId, pageSize: "20" })));
      } catch (error) {
        if (error instanceof HttpError && error.status === 400) continue;
        throw error;
      }
    }
    const norm = (v: string | undefined) => v?.replace(/\s+/g, "").toUpperCase();
    const wanted = norm(trackingId);
    const seen = new Set<string>();
    return rows.filter((s) => {
      const hit = arr(s.parcels).some((p) => norm(str(p.trackingId)) === wanted) || norm(str(s.packageTrackingNumber)) === wanted;
      if (!hit || seen.has(String(s.id))) return false;
      seen.add(String(s.id));
      return true;
    });
  }

  async getOrder(orderId: string, scope: OrderScopeRule): Promise<OrderLookupResult> {
    try {
      const rows = await this.#get("salesOrder", { "id-eq": orderId, pageSize: "1" });
      const row = rows.find((r) => String(r.id) === orderId);
      if (!row || !scopeMatches(row, scope)) return { status: "missing", triedReferences: [orderId] };
      return { status: "unique", order: await this.#enrich(row), matchedBy: `id=${orderId}` };
    } catch (error) {
      return toLookupError(error);
    }
  }

  async checkAccess(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.#get("salesOrder", { pageSize: "1" });
      return { ok: true, detail: "Lesender Zugriff auf salesOrder erfolgreich." };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}

function toLookupError(error: unknown): OrderLookupResult {
  if (error instanceof HttpError) return { status: "error", error: error.message, retryable: error.retryable };
  return { status: "error", error: (error as Error).message, retryable: true };
}
