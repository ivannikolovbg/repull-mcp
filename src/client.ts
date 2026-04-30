/**
 * Minimal typed-ish HTTP client for api.repull.dev.
 *
 * We deliberately do NOT depend on the in-flight `@repull/sdk` package — this
 * MCP server is standalone. It calls the public REST surface directly.
 */

export interface RepullClientOptions {
  apiKey: string;
  baseUrl: string;
  userAgent: string;
}

export interface RequestOptions {
  query?: Record<string, unknown> | undefined;
  body?: unknown;
}

export class RepullApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly requestId?: string,
    public readonly raw?: unknown
  ) {
    super(message);
    this.name = "RepullApiError";
  }
}

export interface RepullClient {
  get(path: string, opts?: RequestOptions): Promise<unknown>;
  post(path: string, opts?: RequestOptions): Promise<unknown>;
}

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

  async function request(
    method: "GET" | "POST",
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

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body });
    } catch (err) {
      throw new RepullApiError(
        0,
        `Network error contacting Repull API: ${err instanceof Error ? err.message : String(err)}`
      );
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
      const errObj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
      const errSection = errObj?.error && typeof errObj.error === "object"
        ? (errObj.error as Record<string, unknown>)
        : errObj;
      const message =
        (errSection && typeof errSection.message === "string" && errSection.message) ||
        (errObj && typeof errObj.message === "string" && errObj.message) ||
        text ||
        res.statusText ||
        `HTTP ${res.status}`;
      const code =
        errSection && typeof errSection.code === "string" ? errSection.code : undefined;
      throw new RepullApiError(res.status, message, code, requestId, parsed ?? text);
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
  };
}
