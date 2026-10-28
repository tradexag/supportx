export class HttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  /** True when the request may have reached the provider (timeout/reset after sending). */
  readonly uncertain: boolean;

  constructor(message: string, status: number, retryable: boolean, uncertain = false) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
}

/**
 * Only official provider hosts are accepted for live connections. Local test
 * endpoints (demo fakes, contract tests) need ALLOW_TEST_ENDPOINTS=true; this
 * keeps a configured URL from redirecting credentials to an arbitrary host.
 */
export function assertAllowedEndpoint(raw: string, allowTestEndpoints: boolean, isOfficial: (url: URL) => boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Ungültige URL: ${raw}`);
  }
  if (allowTestEndpoints && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return url;
  if (url.protocol !== "https:" || !isOfficial(url)) {
    throw new Error(`Nicht erlaubter Endpunkt: ${url.origin}. Nur offizielle HTTPS-Endpunkte des Anbieters sind zulässig.`);
  }
  return url;
}

export interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** A string is sent as JSON unless a Content-Type header is given; FormData as multipart. */
  body?: string | FormData;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

function describeStatus(status: number): string {
  if (status === 401) return "Zugang abgelehnt (401): Zugangsdaten ungültig oder abgelaufen.";
  if (status === 403) return "Keine Berechtigung (403) für diese Ressource.";
  if (status === 404) return "Ressource nicht gefunden (404).";
  if (status === 410) return "Ressource nicht mehr verfügbar (410).";
  if (status === 429) return "Ratenlimit erreicht (429).";
  return `HTTP ${status}`;
}

/** JSON request with timeout and a classification of failures for retry decisions. */
export async function requestJson(url: URL | string, options: RequestOptions): Promise<unknown> {
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: options.method,
      headers: { ...(typeof options.body === "string" && options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    const name = (error as Error).name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    // For a non-GET request we cannot know whether the provider executed it.
    const uncertain = options.method !== "GET";
    throw new HttpError(timedOut ? `Zeitüberschreitung nach ${options.timeoutMs} ms` : `Verbindungsfehler: ${(error as Error).message}`, 0, true, uncertain);
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = "";
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } | string; message?: string; errors?: unknown };
      detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? "";
      // Validation errors often list the offending fields separately (e.g. Kaufland: errors[]).
      const fields = Array.isArray(parsed.errors)
        ? parsed.errors.map((e) => (typeof e === "string" ? e : [e?.property ?? e?.field ?? e?.path, e?.message].filter((v) => typeof v === "string" && v).join(": "))).filter(Boolean).slice(0, 3)
        : [];
      if (fields.length) detail = [detail, fields.join("; ")].filter(Boolean).join(": ");
    } catch {
      detail = text.slice(0, 200);
    }
    const retryable = response.status === 429 || response.status >= 500;
    // A 5xx after a POST may still have been executed by the provider.
    const uncertain = options.method !== "GET" && response.status >= 500;
    throw new HttpError(`${describeStatus(response.status)}${detail ? ` – ${detail}` : ""}`, response.status, retryable, uncertain);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError("Antwort ist kein gültiges JSON.", response.status, false);
  }
}

/** GET a file (binary body). Same failure classification as requestJson; size capped. */
export async function requestBinary(url: URL | string, options: Omit<RequestOptions, "method" | "body"> & { maxBytes: number }): Promise<{ data: Buffer; contentType: string; fileName?: string }> {
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, { method: "GET", headers: options.headers, signal: AbortSignal.timeout(options.timeoutMs), redirect: "error" });
  } catch (error) {
    const name = (error as Error).name;
    throw new HttpError(name === "TimeoutError" || name === "AbortError" ? `Zeitüberschreitung nach ${options.timeoutMs} ms` : `Verbindungsfehler: ${(error as Error).message}`, 0, true);
  }
  if (!response.ok) throw new HttpError(describeStatus(response.status), response.status, response.status === 429 || response.status >= 500);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > options.maxBytes) throw new HttpError("Datei ist zu groß.", 413, false);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > options.maxBytes) throw new HttpError("Datei ist zu groß.", 413, false);
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  return { data, contentType: (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase(), fileName: fileName ? decodeURIComponent(fileName) : undefined };
}
