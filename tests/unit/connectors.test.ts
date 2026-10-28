import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GraphMailChannel, OUTBOX_HEADER } from "../../packages/connectors/microsoft/graph-mail.ts";
import { WeclappOrderProvider } from "../../packages/connectors/weclapp/adapter.ts";
import { DEMO, demoWeclappData } from "../../packages/testing/demo-data.ts";
import { startFakeGraph, type FakeGraph } from "../../packages/testing/fake-graph.ts";
import { startFakeWeclapp, type FakeWeclapp } from "../../packages/testing/fake-weclapp.ts";

const scope = (value: string) => ({ field: "salesChannel" as const, value });
const order = (value: string) => ({ value, kind: "order" as const });

describe("weclapp adapter with filters the tenant rejects", () => {
  it("skips a rejected filter instead of failing the lookup, and names it when nothing else is left", async () => {
    const fake = await startFakeWeclapp(demoWeclappData(), { token: DEMO.weclappToken, rejectFilters: ["salesOrder.orderNumberAtCustomer-eq", "salesInvoice.salesOrderId-eq"] });
    try {
      const provider = new WeclappOrderProvider({ baseUrl: fake.baseUrl, apiToken: DEMO.weclappToken, searchFields: ["orderNumberAtCustomer", "orderNumber"], allowTestEndpoints: true });
      const viaOrderNumber = await provider.findOrders([order("AU-10003")], { field: "none", value: "" });
      assert.equal(viaOrderNumber.status, "unique", "orderNumber still works, invoices are just missing");
      if (viaOrderNumber.status === "unique") assert.equal(viaOrderNumber.order.invoices.length, 0);

      const only = new WeclappOrderProvider({ baseUrl: fake.baseUrl, apiToken: DEMO.weclappToken, searchFields: ["orderNumberAtCustomer"], allowTestEndpoints: true });
      const none = await only.findOrders([order("302-1234567-7654321")], { field: "none", value: "" });
      assert.equal(none.status, "error");
      if (none.status === "error") assert.match(none.error, /orderNumberAtCustomer-eq/);
    } finally {
      await fake.close();
    }
  });
});

describe("weclapp adapter (contract against test double)", () => {
  let fake: FakeWeclapp;
  let provider: WeclappOrderProvider;
  before(async () => {
    fake = await startFakeWeclapp(demoWeclappData(), { token: DEMO.weclappToken });
    provider = new WeclappOrderProvider({ baseUrl: fake.baseUrl, apiToken: DEMO.weclappToken, searchFields: ["orderNumberAtCustomer", "orderNumber"], allowTestEndpoints: true });
  });
  after(() => fake.close());

  it("finds a unique order with all shipments and parcels", async () => {
    const result = await provider.findOrders([order("302-1234567-7654321")], scope(DEMO.channels.amazon));
    assert.equal(result.status, "unique");
    if (result.status !== "unique") return;
    assert.equal(result.order.shipments.length, 2);
    assert.equal(result.order.shipments[0]!.parcels.length, 2);
    assert.equal(result.order.shipments[1]!.parcels.length, 0);
    assert.ok(fake.requests.every((r) => r.startsWith("GET ")), "adapter only reads");
  });

  it("separates identical order numbers of different seller accounts", async () => {
    const shop = await provider.findOrders([order("1001")], scope(DEMO.channels.shopify));
    const ebay = await provider.findOrders([order("1001")], scope(DEMO.channels.ebay));
    assert.equal(shop.status, "unique");
    assert.equal(ebay.status, "unique");
    if (shop.status === "unique" && ebay.status === "unique") assert.notEqual(shop.order.id, ebay.order.id);
  });

  it("reports ambiguity instead of guessing", async () => {
    const result = await provider.findOrders([order("12-34567-89012")], scope(DEMO.channels.ebay));
    assert.equal(result.status, "ambiguous");
    if (result.status === "ambiguous") assert.equal(result.candidates.length, 2);
  });

  it("reports out-of-scope hits as missing for this account", async () => {
    const result = await provider.findOrders([order("302-1234567-7654321")], scope(DEMO.channels.ebay));
    assert.equal(result.status, "missing");
  });

  it("uses legacy single tracking field when parcels are absent", async () => {
    const result = await provider.findOrders([order("1001")], scope(DEMO.channels.shopify));
    assert.equal(result.status, "unique");
    if (result.status === "unique") assert.equal(result.order.shipments[0]!.parcels[0]!.source, "legacy_package_tracking");
  });

  it("finds the order by invoice number and by parcel number, without AI", async () => {
    const byInvoice = await provider.findOrders([{ value: "RE-9001", kind: "invoice" }], scope(DEMO.channels.amazon));
    assert.equal(byInvoice.status, "unique");
    if (byInvoice.status === "unique") {
      assert.equal(byInvoice.order.id, "so-amz-1");
      assert.equal(byInvoice.matchedBy, "Rechnungsnummer=RE-9001");
    }
    const byParcel = await provider.findOrders([{ value: "DEMO00012346", kind: "tracking" }], scope(DEMO.channels.amazon));
    assert.equal(byParcel.status, "unique");
    if (byParcel.status === "unique") assert.equal(byParcel.order.id, "so-amz-1");
    const byLegacy = await provider.findOrders([{ value: "DEMOLEGACY1", kind: "tracking" }], scope(DEMO.channels.shopify));
    assert.equal(byLegacy.status, "unique");
    if (byLegacy.status === "unique") assert.equal(byLegacy.order.id, "so-shop-1");
  });

  it("keeps the seller-account scope and exactness for invoice and parcel numbers", async () => {
    assert.equal((await provider.findOrders([{ value: "RE-9001", kind: "invoice" }], scope(DEMO.channels.ebay))).status, "missing");
    assert.equal((await provider.findOrders([{ value: "RE-900", kind: "invoice" }], scope(DEMO.channels.amazon))).status, "missing");
    assert.equal((await provider.findOrders([{ value: "DEMO0001234", kind: "tracking" }], scope(DEMO.channels.amazon))).status, "missing");
    // An order number is not searched as an invoice number and vice versa.
    assert.equal((await provider.findOrders([{ value: "RE-9001", kind: "order" }], scope(DEMO.channels.amazon))).status, "missing");
  });

  it("surfaces a wrong token as an error", async () => {
    const bad = new WeclappOrderProvider({ baseUrl: fake.baseUrl, apiToken: "wrong", searchFields: ["orderNumber"], allowTestEndpoints: true });
    const result = await bad.findOrders([order("AU-10001")], scope(DEMO.channels.amazon));
    assert.equal(result.status, "error");
  });

  it("rejects non-weclapp hosts unless test endpoints are allowed", () => {
    assert.throws(() => new WeclappOrderProvider({ baseUrl: "http://127.0.0.1:1/webapp/api/v2", apiToken: "x", searchFields: ["orderNumber"] }));
    assert.throws(() => new WeclappOrderProvider({ baseUrl: "https://evil.example.com/webapp/api/v2", apiToken: "x", searchFields: ["orderNumber"] }));
  });
});

describe("Microsoft Graph mail adapter (contract against test double)", () => {
  let graph: FakeGraph;
  const channel = (timeoutMs = 2000) =>
    new GraphMailChannel({
      tenantId: "00000000-0000-0000-0000-000000000000", clientId: "client", clientSecret: DEMO.graphSecret, mailbox: DEMO.mailbox,
      graphBaseUrl: graph.graphBaseUrl, authorityHost: graph.authorityHost, allowTestEndpoints: true, timeoutMs,
    });
  before(async () => {
    graph = await startFakeGraph({ mailbox: DEMO.mailbox, clientSecret: DEMO.graphSecret, pageSize: 2, hangMs: 600 });
    for (let i = 0; i < 5; i++) graph.addInbound({ from: `k${i}@kunde.example.invalid`, subject: `Bestellung #${1000 + i}`, body: "Hallo" });
  });
  after(() => graph.close());

  it("pages through delta and resumes from the stored cursor", async () => {
    const first = await channel().sync({});
    assert.equal(first.messages.filter((m) => m.direction === "inbound").length, 5);
    const again = await channel().sync(first.cursors);
    assert.equal(again.messages.length, 0);
    graph.addInbound({ from: "neu@kunde.example.invalid", subject: "Neu", body: "Text" });
    const next = await channel().sync(again.cursors);
    assert.equal(next.messages.length, 1);
  });

  it("restarts the sync when the delta token expired", async () => {
    const state = await channel().sync({});
    graph.expireDeltaTokens();
    const reset = await channel().sync(state.cursors);
    assert.equal(reset.cursorReset, true);
    assert.ok(reset.messages.length >= 6, "full resync delivers everything again; ingestion dedupes");
  });

  it("sends a reply with the outbox marker and finds it during reconciliation", async () => {
    const inbound = graph.messages.find((m) => m.folder === "inbox")!;
    const since = new Date(Date.now() - 1000);
    const outcome = await channel().sendReply({ inReplyToExternalId: inbound.id, externalThreadKey: "", bodyText: "Danke", outboxMarker: "ob-1" });
    assert.equal(outcome.state, "provider_accepted");
    assert.ok(graph.replies.at(-1)!.headers.some((h) => h.name === OUTBOX_HEADER && h.value === "ob-1"));
    const found = await channel().reconcileReply("ob-1", since, inbound.conversationId);
    assert.equal(found.state, "found");
  });

  it("reports a timeout as uncertain, never as failed", async () => {
    const inbound = graph.messages.find((m) => m.folder === "inbox")!;
    graph.setReplyFault("timeout_after_send");
    const outcome = await channel(200).sendReply({ inReplyToExternalId: inbound.id, externalThreadKey: "", bodyText: "Danke", outboxMarker: "ob-2" });
    assert.equal(outcome.state, "uncertain");
  });

  it("reports a 400 as a definite, non-retryable rejection", async () => {
    const inbound = graph.messages.find((m) => m.folder === "inbox")!;
    graph.setReplyFault("reject_400");
    const outcome = await channel().sendReply({ inReplyToExternalId: inbound.id, externalThreadKey: "", bodyText: "Danke", outboxMarker: "ob-3" });
    assert.deepEqual([outcome.state, outcome.state === "rejected" && outcome.retryable], ["rejected", false]);
  });

  it("explains a missing send right (403) instead of 'access denied'", async () => {
    const inbound = graph.messages.find((m) => m.folder === "inbox")!;
    graph.setReplyFault("reject_403");
    const outcome = await channel().sendReply({ inReplyToExternalId: inbound.id, externalThreadKey: "", bodyText: "Danke", outboxMarker: "ob-4" });
    assert.equal(outcome.state, "rejected");
    assert.match(outcome.state === "rejected" ? outcome.error : "", /Application Mail\.Send.*nichts verschickt/s);
  });

  it("fails the access check with a wrong client secret", async () => {
    const bad = new GraphMailChannel({ tenantId: "00000000-0000-0000-0000-000000000000", clientId: "c", clientSecret: "wrong", mailbox: DEMO.mailbox, graphBaseUrl: graph.graphBaseUrl, authorityHost: graph.authorityHost, allowTestEndpoints: true });
    assert.equal((await bad.checkAccess()).ok, false);
  });
});
