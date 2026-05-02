/**
 * Minimal typed-ish HTTP client for api.repull.dev.
 *
 * We deliberately do NOT depend on the in-flight `@repull/sdk` package — this
 * MCP server is standalone. It calls the public REST surface directly.
 *
 * Error handling: when the API returns a structured error envelope of the form
 *   `{ "error": { "code", "message", "docs_url", "field", "fix", ... } }`
 * we preserve every field on the thrown `RepullApiError` so callers can surface
 * the full envelope back to an LLM agent. This is critical: agents read `fix`
 * and `docs_url` to self-correct without bouncing the question back to a human.
 */

export interface RepullClientOptions {
  apiKey: string;
  baseUrl: string;
  userAgent: string;
}

export interface RequestOptions {
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  /** Sent as the `Idempotency-Key` header on mutating requests. */
  idempotencyKey?: string | undefined;
}

/**
 * Structured error from the Repull API. Mirrors the API's error envelope so
 * agents can read `fix` / `docs_url` programmatically.
 */
export class RepullApiError extends Error {
  /** HTTP status code. `0` for transport-level errors (DNS, network, etc.). */
  public readonly status: number;
  /** Stable error code (e.g. `unauthorized`, `not_found`, `invalid_param`). */
  public readonly code: string | undefined;
  /** Suggested user-facing fix, when the API includes one. */
  public readonly fix: string | undefined;
  /** Link to a /docs page that explains the error and remediation. */
  public readonly docsUrl: string | undefined;
  /** For 422 validation errors, the offending field name. */
  public readonly field: string | undefined;
  /** Optional example of correct usage (param value, body shape, etc.). */
  public readonly example: string | undefined;
  /** Server-side request ID, useful for support tickets. */
  public readonly requestId: string | undefined;
  /** The full parsed error body from the API, kept verbatim. */
  public readonly envelope: Record<string, unknown> | undefined;
  /** Raw body — only populated when the API returned non-JSON. */
  public readonly raw: unknown;

  constructor(init: {
    status: number;
    message: string;
    code?: string | undefined;
    fix?: string | undefined;
    docsUrl?: string | undefined;
    field?: string | undefined;
    example?: string | undefined;
    requestId?: string | undefined;
    envelope?: Record<string, unknown> | undefined;
    raw?: unknown;
  }) {
    super(init.message);
    this.name = "RepullApiError";
    this.status = init.status;
    this.code = init.code;
    this.fix = init.fix;
    this.docsUrl = init.docsUrl;
    this.field = init.field;
    this.example = init.example;
    this.requestId = init.requestId;
    this.envelope = init.envelope;
    this.raw = init.raw;
  }

  /**
   * Returns the JSON shape we send back to the MCP client. Mirrors the API
   * envelope exactly so an agent reading the tool result sees the same fields
   * it would see from a direct HTTP call.
   */
  toMcpPayload(): Record<string, unknown> {
    const error: Record<string, unknown> = {
      status: this.status,
      message: this.message,
    };
    if (this.code !== undefined) error.code = this.code;
    if (this.fix !== undefined) error.fix = this.fix;
    if (this.docsUrl !== undefined) error.docs_url = this.docsUrl;
    if (this.field !== undefined) error.field = this.field;
    if (this.example !== undefined) error.example = this.example;
    if (this.requestId !== undefined) error.request_id = this.requestId;
    return { error };
  }
}

export interface RepullClient {
  get(path: string, opts?: RequestOptions): Promise<unknown>;
  post(path: string, opts?: RequestOptions): Promise<unknown>;
  patch(path: string, opts?: RequestOptions): Promise<unknown>;
  put(path: string, opts?: RequestOptions): Promise<unknown>;
  delete(path: string, opts?: RequestOptions): Promise<unknown>;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export function createRepullClient(opts: RepullClientOptions): RepullClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");

  function buildUrl(path: string, query: RequestOptions["query"]): string {
    const url = new URL(`${baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  function pickString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
    if (!obj) return undefined;
    const v = obj[key];
    return typeof v === "string" ? v : undefined;
  }

  async function request(
    method: Method,
    path: string,
    options: RequestOptions = {}
  ): Promise<unknown> {
    const url = buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: "application/json",
      "User-Agent": opts.userAgent,
    };
    let body: string | undefined;
    if (options.body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    if (options.idempotencyKey && method !== "GET") {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body });
    } catch (err) {
      throw new RepullApiError({
        status: 0,
        message: `Network error contacting Repull API: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const requestId = res.headers.get("x-request-id") ?? undefined;
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Leave as raw text — surfaced in the error path below.
      }
    }

    if (!res.ok) {
      const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
      // The API uses `{ error: { code, message, docs_url, field, fix, ... } }`.
      // Some legacy paths return a flat `{ message, code }`. Handle both.
      const envelope = root?.error && typeof root.error === "object"
        ? (root.error as Record<string, unknown>)
        : root;

      const message =
        pickString(envelope, "message") ||
        pickString(root, "message") ||
        text ||
        res.statusText ||
        `HTTP ${res.status}`;

      throw new RepullApiError({
        status: res.status,
        message,
        code: pickString(envelope, "code"),
        fix: pickString(envelope, "fix"),
        docsUrl: pickString(envelope, "docs_url") || pickString(envelope, "docsUrl"),
        field: pickString(envelope, "field"),
        example: pickString(envelope, "example"),
        requestId,
        envelope: envelope as Record<string, unknown> | undefined,
        raw: parsed ?? text,
      });
    }

    return parsed;
  }

  return {
    get(path, options) {
      return request("GET", path, options);
    },
    post(path, options) {
      return request("POST", path, options);
    },
    patch(path, options) {
      return request("PATCH", path, options);
    },
    put(path, options) {
      return request("PUT", path, options);
    },
    delete(path, options) {
      return request("DELETE", path, options);
    },
  };
}
