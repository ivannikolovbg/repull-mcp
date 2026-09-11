#!/usr/bin/env node
/**
 * @repull/mcp — Model Context Protocol server for the Repull API.
 *
 * Exposes a curated set of tools (discovery, introspection, reads, the
 * "start a Connect flow" entry points, and Studio) over stdio so MCP clients
 * (Claude Desktop, Cursor, Continue, etc.) can talk to api.repull.dev. A
 * small set of write tools (reservations.create/update, guests.create,
 * messaging.send) exist but are NOT registered by default — see
 * `REPULL_MCP_ENABLE_WRITES` / `parseWriteScopes()` / `registerWriteTools()`.
 *
 * Auth: requires the `REPULL_API_KEY` environment variable.
 *
 * Design notes for agents reading this file:
 *   - Tools mirror REST endpoints 1:1 — easy to reason about and to map errors.
 *   - Errors are surfaced as the full API envelope ({ error: { code, message,
 *     fix, docs_url, field, ... } }) so an agent can read `fix` and self-correct.
 *   - List tools accept the API's native `cursor` (opaque string) for paging;
 *     the MCP does NOT auto-paginate, because LLMs do better when they decide
 *     when to fetch the next page.
 *   - Mutating tools (connect-session creators, always on; reservations /
 *     guests / messaging writes, opt-in) accept an `idempotency_key`
 *     parameter that becomes the `Idempotency-Key` header.
 */

import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRepullClient, RepullApiError, type RepullClient } from "./client.js";
import { registerStudioTools } from "./studio.js";
import { resolvePath, TOOL_PATHS } from "./openapi-paths.js";

const PACKAGE_NAME = "@repull/mcp";
const PACKAGE_VERSION = "0.2.3";

/** Where the public OpenAPI spec lives. */
const OPENAPI_URL = "https://api.repull.dev/openapi.json";
/** Where the public docs API lives. Single-doc reads need the canonical Next host. */
const DOCS_API_BASE = "https://app.vanio.ai";

function getApiKey(): string {
  const key = process.env.REPULL_API_KEY;
  if (!key) {
    process.stderr.write(
      `[${PACKAGE_NAME}] REPULL_API_KEY environment variable is required.\n` +
        `Get an API key at https://repull.dev/dashboard and pass it in your MCP client config.\n`
    );
    process.exit(1);
  }
  return key;
}

function getBaseUrl(): string {
  // `REPULL_API_URL` is the canonical name across the Repull SDK ecosystem;
  // `REPULL_API_BASE_URL` is the legacy name kept for backwards compatibility.
  return (
    process.env.REPULL_API_URL ??
    process.env.REPULL_API_BASE_URL ??
    "https://api.repull.dev"
  );
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function jsonText(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value as JsonValue, null, 2),
      },
    ],
  };
}

/**
 * Format a tool error so the agent sees the full Repull error envelope.
 * Critical: we expose `code`, `fix`, `docs_url`, `field` verbatim — agents
 * read these fields to self-correct without bouncing back to a human.
 */
function errorText(err: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  let payload: unknown;
  if (err instanceof RepullApiError) {
    payload = err.toMcpPayload();
  } else if (err instanceof Error) {
    payload = { error: { status: 0, message: err.message } };
  } else {
    payload = { error: { status: 0, message: String(err) } };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/** Strip undefined values so we don't send literal "undefined" in the query string. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write-tool gating. Mutating tools (reservations.create/update,
// guests.create, messaging.send) are opt-in via REPULL_MCP_ENABLE_WRITES —
// a comma-separated list of `domain:action` scopes. Default install (no env
// var) stays 100% read-only. See the README's "Write tools (opt-in)" section.
// ---------------------------------------------------------------------------

/** Every write scope a tool can be gated behind, mapped to the tool it unlocks. */
export const WRITE_SCOPE_TOOLS = {
  "reservations:create": "repull_create_reservation",
  "reservations:update": "repull_update_reservation",
  "guests:create": "repull_create_guest",
  "messaging:send": "repull_send_conversation_message",
} as const satisfies Record<string, string>;

export type WriteScope = keyof typeof WRITE_SCOPE_TOOLS;

const WRITE_SCOPES: readonly WriteScope[] = Object.keys(WRITE_SCOPE_TOOLS) as WriteScope[];

/** Tokens that mean "enable every write scope", checked case-insensitively. */
const WILDCARD_TOKENS = new Set(["*", "all"]);

export interface ParsedWriteScopes {
  /** The set of write scopes to actually register tools for. */
  enabled: Set<WriteScope>;
  /** Raw tokens from the env var that didn't match a known scope or wildcard. */
  unknown: string[];
}

/**
 * Parses `REPULL_MCP_ENABLE_WRITES` into a set of enabled write scopes.
 *
 * Forgiving of whitespace and case. Comma-separated. `*` or `all` (either
 * case) enables every write scope — documented in the README precisely
 * because it is a blunt instrument: it is easy to reason about ("this
 * install allows every write we currently ship") in a way that a silently
 * growing allowlist is not, but it also means a future write tool added to
 * WRITE_SCOPE_TOOLS is enabled by existing `*` configs without a re-opt-in.
 * Unrecognised tokens are reported in `unknown` — never silently accepted —
 * so the caller can warn to stderr and name the valid scopes.
 */
export function parseWriteScopes(raw: string | undefined | null): ParsedWriteScopes {
  const enabled = new Set<WriteScope>();
  const unknown: string[] = [];

  if (!raw) return { enabled, unknown };

  const tokens = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  for (const token of tokens) {
    if (WILDCARD_TOKENS.has(token)) {
      for (const scope of WRITE_SCOPES) enabled.add(scope);
      continue;
    }
    if ((WRITE_SCOPES as readonly string[]).includes(token)) {
      enabled.add(token as WriteScope);
      continue;
    }
    unknown.push(token);
  }

  return { enabled, unknown };
}

// ---------------------------------------------------------------------------
// Lightweight, in-process caches for discovery tools.
// OpenAPI changes rarely (per release); refetch every ~5 minutes is plenty.
// ---------------------------------------------------------------------------

let openApiCache: { fetchedAt: number; spec: Record<string, unknown> } | undefined;
const OPENAPI_TTL_MS = 5 * 60 * 1000;

async function fetchOpenApi(userAgent: string): Promise<Record<string, unknown>> {
  if (openApiCache && Date.now() - openApiCache.fetchedAt < OPENAPI_TTL_MS) {
    return openApiCache.spec;
  }
  const res = await fetch(OPENAPI_URL, {
    headers: { Accept: "application/json", "User-Agent": userAgent },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch OpenAPI spec (${res.status} ${res.statusText})`);
  }
  const spec = (await res.json()) as Record<string, unknown>;
  openApiCache = { fetchedAt: Date.now(), spec };
  return spec;
}

interface EndpointSummary {
  method: string;
  path: string;
  operationId: string | undefined;
  tag: string | undefined;
  summary: string | undefined;
  description: string | undefined;
}

function summarizeOpenApi(spec: Record<string, unknown>, opts: { tag?: string | undefined; search?: string | undefined }): EndpointSummary[] {
  const paths = (spec.paths as Record<string, Record<string, Record<string, unknown>>> | undefined) ?? {};
  const out: EndpointSummary[] = [];
  const search = opts.search?.toLowerCase();
  const tagFilter = opts.tag?.toLowerCase();
  for (const path of Object.keys(paths).sort()) {
    const methods = paths[path];
    if (!methods) continue;
    for (const method of Object.keys(methods)) {
      const m = method.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(m)) continue;
      const op = methods[method] as Record<string, unknown>;
      const tags = Array.isArray(op.tags) ? (op.tags as string[]) : [];
      const tag = tags[0];
      if (tagFilter && (!tag || tag.toLowerCase() !== tagFilter)) continue;
      const summary = typeof op.summary === "string" ? op.summary : undefined;
      const description = typeof op.description === "string" ? op.description : undefined;
      const operationId = typeof op.operationId === "string" ? op.operationId : undefined;
      if (search) {
        const hay = `${path} ${m} ${tag ?? ""} ${operationId ?? ""} ${summary ?? ""} ${description ?? ""}`.toLowerCase();
        if (!hay.includes(search)) continue;
      }
      out.push({ method: m, path, operationId, tag, summary, description });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

/** Discovery + introspection + read + connect + studio tools — always registered. */
const READ_ONLY_TOOL_COUNT = 24;

async function main(): Promise<void> {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  const userAgent = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;
  const client = createRepullClient({ apiKey, baseUrl, userAgent });

  const { enabled: writeScopes, unknown: unknownScopes } = parseWriteScopes(
    process.env.REPULL_MCP_ENABLE_WRITES
  );

  if (unknownScopes.length > 0) {
    process.stderr.write(
      `[${PACKAGE_NAME}] REPULL_MCP_ENABLE_WRITES: ignoring unrecognised scope(s) ` +
        `${unknownScopes.map((s) => `"${s}"`).join(", ")}. Valid scopes: ` +
        `${WRITE_SCOPES.join(", ")}, or "*"/"all" for every write scope.\n`
    );
  }

  if (writeScopes.size === 0) {
    process.stderr.write(
      `[${PACKAGE_NAME}] REPULL_MCP_ENABLE_WRITES not set — server is read-only ` +
        `(${READ_ONLY_TOOL_COUNT} tools). Set it to a comma-separated list of ` +
        `${WRITE_SCOPES.join(", ")} to enable mutating tools.\n`
    );
  } else {
    process.stderr.write(
      `[${PACKAGE_NAME}] write scopes enabled: ${[...writeScopes].sort().join(", ")} ` +
        `(${writeScopes.size} of ${WRITE_SCOPES.length} write tool(s) registered).\n`
    );
  }

  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });

  registerDiscoveryTools(server, userAgent);
  registerIntrospectionTools(server, client);
  registerReadTools(server, client);
  registerWriteTools(server, client, writeScopes);
  registerConnectTools(server, client);
  registerStudioTools(server, client, { errorFormat: errorText });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const totalTools = READ_ONLY_TOOL_COUNT + writeScopes.size;
  process.stderr.write(
    `[${PACKAGE_NAME}] connected (base=${baseUrl}). ${totalTools} tools registered.\n`
  );
}

// ---------------------------------------------------------------------------
// Discovery tools — let the agent self-discover capabilities + read docs
// without leaving the conversation.
// ---------------------------------------------------------------------------

function registerDiscoveryTools(server: McpServer, userAgent: string): void {
  server.registerTool(
    "repull_list_endpoints",
    {
      title: "List Repull API endpoints (discovery)",
      description:
        "Returns a concise summary of every Repull REST endpoint (method, path, tag, summary). " +
        "Use this when the user asks 'what can Repull do?' or when you need to find a specific operation " +
        "by name. Optionally filter by tag (e.g. `Reservations`, `Pricing`, `Airbnb`) or free-text search " +
        "across path, operation ID, summary, and description. The full OpenAPI spec is at " +
        `${OPENAPI_URL} — fetch that directly only when you need request/response schemas.`,
      inputSchema: {
        tag: z.string().optional().describe(
          "Filter by OpenAPI tag (e.g. 'Reservations', 'Properties', 'Airbnb', 'Pricing', 'Connect'). Case-insensitive."
        ),
        search: z.string().optional().describe(
          "Free-text search across path, operation ID, summary, and description. Case-insensitive substring match."
        ),
      },
    },
    async ({ tag, search }) => {
      try {
        const spec = await fetchOpenApi(userAgent);
        const endpoints = summarizeOpenApi(spec, { tag, search });
        const info = (spec.info as Record<string, unknown>) ?? {};
        const tags = (spec.tags as Array<{ name: string; description?: string }>) ?? [];
        return jsonText({
          api_title: info.title,
          api_version: info.version,
          openapi_url: OPENAPI_URL,
          tags: tags.map((t) => ({ name: t.name, description: t.description })),
          total_endpoints: endpoints.length,
          endpoints,
        });
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "repull_get_docs",
    {
      title: "Fetch a Repull docs page (or list available docs)",
      description:
        "Reads a published docs page by `slug`. If `slug` is omitted, returns a list of available doc " +
        "slugs (optionally filtered by `category` or `search`). Use this when the user asks 'how do I X?' " +
        "or when you need a longer-form explanation than what fits in tool descriptions. Returns the raw " +
        "Markdown body so you can quote or summarize it.",
      inputSchema: {
        slug: z.string().optional().describe(
          "Doc slug (e.g. 'quick-start', 'setup-wizard', 'repull-oauth-connect'). Omit to list available docs."
        ),
        category: z.string().optional().describe(
          "When listing, filter by category (e.g. 'getting-started', 'integrations', 'features')."
        ),
        search: z.string().optional().describe(
          "When listing, free-text search across title and excerpt."
        ),
      },
    },
    async ({ slug, category, search }) => {
      try {
        if (slug) {
          const url = `${DOCS_API_BASE}/api/docs/${encodeURIComponent(slug)}`;
          const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": userAgent } });
          if (!res.ok) {
            throw new RepullApiError({
              status: res.status,
              message: res.status === 404
                ? `Doc '${slug}' not found. Call repull_get_docs without a slug to see available docs.`
                : `Failed to fetch doc '${slug}' (${res.status} ${res.statusText})`,
              code: res.status === 404 ? "doc_not_found" : "doc_fetch_failed",
              docsUrl: "https://app.vanio.ai/docs",
            });
          }
          return jsonText(await res.json());
        }
        const params = new URLSearchParams();
        if (category) params.set("category", category);
        if (search) params.set("search", search);
        const qs = params.toString();
        const url = `${DOCS_API_BASE}/api/docs${qs ? `?${qs}` : ""}`;
        const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": userAgent } });
        if (!res.ok) {
          throw new RepullApiError({
            status: res.status,
            message: `Failed to list docs (${res.status} ${res.statusText})`,
            code: "doc_list_failed",
          });
        }
        const data = (await res.json()) as { docs?: Array<Record<string, unknown>> };
        // Return slim entries — agents don't need the full body for a list call.
        const docs = (data.docs ?? []).map((d) => ({
          slug: d.slug,
          title: d.title,
          excerpt: d.excerpt,
          category: d.category,
          subcategory: d.subcategory,
          tags: d.tags,
          updated_at: d.updated_at,
        }));
        return jsonText({ total: docs.length, docs });
      } catch (err) {
        return errorText(err);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Introspection — let the agent figure out what THIS API key can do before
// trying actions it might not have access to.
// ---------------------------------------------------------------------------

function registerIntrospectionTools(server: McpServer, client: RepullClient): void {
  server.registerTool(
    "repull_whoami",
    {
      title: "Get the authed workspace, plan, and connected channels",
      description:
        "Returns a snapshot of the workspace tied to the current API key: plan info, usage, and the " +
        "list of connected PMS/OTA channels with their status. Call this first when an agent starts " +
        "a session — it tells you what the user has access to (e.g. 'Airbnb is connected, Booking.com " +
        "is not') so you can avoid suggesting actions that will fail. Combines `GET /v1/usage/tier` and " +
        "`GET /v1/connect` in a single call. Both sub-calls are best-effort; if either fails the other " +
        "is still returned.",
      inputSchema: {},
    },
    async () => {
      type Result = {
        api_base_url: string;
        plan?: unknown;
        plan_error?: unknown;
        connections?: unknown;
        connections_error?: unknown;
      };
      const result: Result = { api_base_url: getBaseUrl() };
      try {
        result.plan = await client.get(TOOL_PATHS.repull_whoami_usage);
      } catch (err) {
        result.plan_error = err instanceof RepullApiError ? err.toMcpPayload() : { error: { message: String(err) } };
      }
      try {
        result.connections = await client.get(TOOL_PATHS.repull_whoami_connect);
      } catch (err) {
        result.connections_error = err instanceof RepullApiError ? err.toMcpPayload() : { error: { message: String(err) } };
      }
      return jsonText(result);
    }
  );

  server.registerTool(
    "repull_health_check",
    {
      title: "Check Repull API health",
      description:
        "Returns the Repull API health status, version, and timestamp. Useful as a connectivity sanity " +
        "check before invoking other tools, or when troubleshooting a request that hung. Does not " +
        "require a valid API key on the API side, but the MCP server still requires `REPULL_API_KEY` to start.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonText(await client.get(TOOL_PATHS.repull_health_check));
      } catch (err) {
        return errorText(err);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Read tools — list and get for the most common entities.
// All list tools accept the API's opaque `cursor` (do NOT auto-paginate;
// agents prefer to decide when to fetch the next page).
// ---------------------------------------------------------------------------

export function registerReadTools(server: McpServer, client: RepullClient): void {
  // ---- Reservations ------------------------------------------------------
  server.registerTool(
    "repull_list_reservations",
    {
      title: "List reservations",
      description:
        "List reservations across every connected PMS and OTA. Supports cursor pagination plus filters " +
        "by status, platform, listing, and check-in date range. Common use cases: 'show me upcoming " +
        "reservations', 'how many cancellations this week', 'find Airbnb bookings for listing 4118'. " +
        "Returns `{ data: Reservation[], pagination: { nextCursor, hasMore, ... } }` — pass " +
        "`pagination.nextCursor` back as `cursor` to fetch the next page.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe(
          "Page size (1–100). API defaults to 20 if omitted. Requests over 100 return a 422."
        ),
        cursor: z.string().optional().describe(
          "Opaque cursor returned in the previous response's `pagination.nextCursor`. Omit to fetch the first page."
        ),
        status: z.enum(["confirmed", "pending", "cancelled", "completed"]).optional().describe(
          "Filter by reservation status."
        ),
        platform: z.string().optional().describe(
          "Filter by booking platform (e.g. 'airbnb', 'booking', 'vrbo', 'plumguide', 'direct')."
        ),
        listing_id: z.string().optional().describe(
          "Filter to a single listing — pass the listing ID returned by `repull_list_listings` or `repull_list_properties`."
        ),
        check_in_after: z.string().optional().describe(
          "Check-in date >= this value (ISO date YYYY-MM-DD)."
        ),
        check_in_before: z.string().optional().describe(
          "Check-in date <= this value (ISO date YYYY-MM-DD)."
        ),
      },
    },
    async (args) => {
      try {
        return jsonText(await client.get(TOOL_PATHS.repull_list_reservations, { query: compact(args) }));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "repull_get_reservation",
    {
      title: "Get a single reservation",
      description:
        "Fetch one reservation by its numeric ID. Returns the full reservation object including guest, " +
        "dates, pricing, payment, and platform-specific fields. Use this after `repull_list_reservations` " +
        "to drill into details, or when the user references a specific reservation ID.",
      inputSchema: {
        id: z.number().int().positive().describe("Reservation ID."),
      },
    },
    async ({ id }) => {
      try {
        return jsonText(await client.get(resolvePath(TOOL_PATHS.repull_get_reservation, { id })));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  // ---- Properties --------------------------------------------------------
  server.registerTool(
    "repull_list_properties",
    {
      title: "List properties",
      description:
        "List properties (the underlying units in the connected PMS systems) across every connected " +
        "platform. Supports cursor pagination plus a filter by PMS provider. Use this when the user " +
        "asks 'how many properties do I have?' or wants to see properties for a specific PMS. " +
        "Returns `{ data: Property[], pagination }` — pass `pagination.nextCursor` as `cursor` for the next page.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Page size (1–100). Defaults to 20."),
        cursor: z.string().optional().describe(
          "Opaque cursor from `pagination.nextCursor` in the previous response. Omit for first page."
        ),
        provider: z.string().optional().describe(
          "Filter by PMS provider slug (e.g. 'guesty', 'hostaway', 'hostfully', 'lodgify', 'ownerrez')."
        ),
      },
    },
    async (args) => {
      try {
        return jsonText(await client.get(TOOL_PATHS.repull_list_properties, { query: compact(args) }));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "repull_get_property",
    {
      title: "Get a single property",
      description:
        "Fetch full details for one property by its ID. Returns address, amenities, photos, sleep " +
        "capacity, and PMS-specific fields. Use this after `repull_list_properties` to drill in.",
      inputSchema: {
        id: z.string().describe("Property ID (string — IDs from PMS adapters can include letters)."),
      },
    },
    async ({ id }) => {
      try {
        return jsonText(await client.get(resolvePath(TOOL_PATHS.repull_get_property, { id })));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  // ---- Listings (native Repull) -----------------------------------------
  server.registerTool(
    "repull_list_listings",
    {
      title: "List native Repull listings",
      description:
        "List native Repull listings — the canonical listings created via `POST /v1/listings`, which " +
        "can then be published to Airbnb / Booking.com via the publish endpoints. Distinct from " +
        "`repull_list_properties` (which surfaces underlying PMS rows). Supports cursor pagination.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Page size (1–100). Defaults to 20."),
        cursor: z.string().optional().describe(
          "Opaque cursor from `pagination.nextCursor` in the previous response."
        ),
      },
    },
    async (args) => {
      try {
        return jsonText(await client.get(TOOL_PATHS.repull_list_listings, { query: compact(args) }));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  // ---- Channel-specific reads (Airbnb) ----------------------------------
  server.registerTool(
    "repull_list_airbnb_listings",
    {
      title: "List Airbnb listings",
      description:
        "List Airbnb listings on the Airbnb account connected to this workspace. Requires an active " +
        "Airbnb connection (check via `repull_whoami` first). Returns Airbnb's view of each listing — " +
        "title, status, photos count, etc. For native Repull listings, use `repull_list_listings`.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonText(await client.get(TOOL_PATHS.repull_list_airbnb_listings));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  // ---- Guests ------------------------------------------------------------
  server.registerTool(
    "repull_list_guests",
    {
      title: "List guests",
      description:
        "List guest profiles across all connected platforms. Use this when the user asks 'find guest " +
        "John Smith' or 'show me all repeat guests'. Supports cursor pagination. To get reservation " +
        "history for a specific guest, use `repull_get_guest`.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Page size (1–100). Defaults to 20."),
        cursor: z.string().optional().describe("Opaque cursor from `pagination.nextCursor`."),
      },
    },
    async (args) => {
      try {
        return jsonText(await client.get(TOOL_PATHS.repull_list_guests, { query: compact(args) }));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "repull_get_guest",
    {
      title: "Get a guest profile",
      description:
        "Fetch a single guest profile by ID, including contact methods, flags, and reservation history. " +
        "Use this after `repull_list_guests` to drill in.",
      inputSchema: {
        id: z.string().describe("Guest ID."),
      },
    },
    async ({ id }) => {
      try {
        return jsonText(await client.get(resolvePath(TOOL_PATHS.repull_get_guest, { id })));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  // ---- Conversations -----------------------------------------------------
  server.registerTool(
    "repull_list_conversations",
    {
      title: "List guest conversations",
      description:
        "List guest message threads across every connected channel (Airbnb inbox, Booking.com inbox, " +
        "direct, SMS, etc.). Use this when the user asks 'show me unread messages' or 'find the " +
        "thread for reservation X'. Supports cursor pagination. To read messages in a thread, use " +
        "`repull_list_conversation_messages`.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Page size (1–100). Defaults to 20."),
        cursor: z.string().optional().describe("Opaque cursor from `pagination.nextCursor`."),
      },
    },
    async (args) => {
      try {
        return jsonText(await client.get(TOOL_PATHS.repull_list_conversations, { query: compact(args) }));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "repull_list_conversation_messages",
    {
      title: "List messages in a conversation",
      description:
        "List the messages in a single conversation thread (oldest-first). Use this after " +
        "`repull_list_conversations` to read the thread. Supports cursor pagination.",
      inputSchema: {
        id: z.string().describe("Conversation ID."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (1–100)."),
        cursor: z.string().optional().describe("Opaque cursor from `pagination.nextCursor`."),
      },
    },
    async ({ id, limit, cursor }) => {
      try {
        return jsonText(
          await client.get(resolvePath(TOOL_PATHS.repull_list_conversation_messages, { id }), {
            query: compact({ limit, cursor }),
          })
        );
      } catch (err) {
        return errorText(err);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Write tools — reservations.create/update, guests.create, messaging.send.
// Every tool here mutates real state (books a stay, edits dates, texts a
// real guest), so none of them register unless the operator explicitly
// opts in via REPULL_MCP_ENABLE_WRITES. See parseWriteScopes() and the
// README's "Write tools (opt-in)" section for the scope syntax.
// ---------------------------------------------------------------------------

export function registerWriteTools(
  server: McpServer,
  client: RepullClient,
  enabledScopes: ReadonlySet<WriteScope>
): void {
  if (enabledScopes.has("reservations:create")) {
    server.registerTool(
      "repull_create_reservation",
      {
        title: "Create a reservation",
        description:
          "Create a DIRECT reservation on one of the workspace's own properties. `platform` is limited " +
          "to 'direct', 'website' and 'owner' — OTA reservations are owned by the channel and arrive " +
          "through sync, so they cannot be created here. The stay is priced by the pricing engine, NOT " +
          "from anything in this request: read `totalPrice` and `currency` back off the response. Pass " +
          "either an inline `guest` or an existing `guestId`. Pass `idempotency_key` so a retry cannot " +
          "create a duplicate booking.",
        inputSchema: {
          listingId: z.number().int().positive().describe(
            "Internal Repull property ID — from `repull_list_properties` or `repull_list_listings`."
          ),
          checkIn: z.string().describe("Check-in date, ISO YYYY-MM-DD."),
          checkOut: z.string().describe("Check-out date, ISO YYYY-MM-DD. Must be after `checkIn`."),
          guest: z
            .object({
              firstName: z.string(),
              lastName: z.string().optional(),
              email: z.string().email().optional(),
              phone: z.string().optional(),
            })
            .optional()
            .describe(
              "Guest identity to match or create. Required unless `guestId` is supplied."
            ),
          guestId: z.number().int().positive().optional().describe(
            "Attach an existing guest instead of matching/creating one. Must belong to this workspace."
          ),
          platform: z.enum(["direct", "website", "owner"]).optional().describe(
            "Booking origin. Defaults to 'direct'. OTA platforms are deliberately not accepted."
          ),
          status: z.string().optional().describe(
            "Lifecycle status to open the reservation in. Defaults to confirmed."
          ),
          checkInTime: z.string().optional().describe("Check-in time, 24h HH:MM (e.g. '16:00')."),
          checkOutTime: z.string().optional().describe("Check-out time, 24h HH:MM (e.g. '10:00')."),
          guestCount: z.number().int().min(1).optional().describe("Number of guests."),
          currency: z.string().length(3).optional().describe("Three-letter currency code, e.g. 'USD'."),
          idempotency_key: z.string().optional().describe(
            "Optional Idempotency-Key header. Send a unique string per distinct request: the same key replays the stored response for 24 hours; the same key with a CHANGED payload is rejected with 422 idempotency_key_reused. Strongly recommended — it is what stops a retry double-booking a property."
          ),
        },
      },
      async ({ idempotency_key, ...body }) => {
        try {
          const data = await client.post(TOOL_PATHS.repull_create_reservation, {
            body: compact(body as Record<string, unknown>),
            idempotencyKey: idempotency_key,
          });
          return jsonText(data);
        } catch (err) {
          return errorText(err);
        }
      }
    );
  }

  if (enabledScopes.has("reservations:update")) {
    server.registerTool(
      "repull_update_reservation",
      {
        title: "Update a reservation",
        description:
          "Change a reservation's dates, times, guest count, or move it to another property in the same " +
          "workspace. At least one field is required. Guest identity, pricing, `status`, `platform` and " +
          "notes are rejected by name — they are not editable here. A `listingId` change combined with " +
          "new dates is applied as ONE move, so the access code is re-issued once rather than twice, and " +
          "a move forces the reservation to a confirmed status: read `status` and `changed` back off the " +
          "response rather than assuming they are unchanged.",
        inputSchema: {
          id: z.number().int().positive().describe("Internal Repull reservation ID."),
          checkIn: z.string().optional().describe("New check-in date, ISO YYYY-MM-DD."),
          checkOut: z.string().optional().describe("New check-out date, ISO YYYY-MM-DD."),
          checkInTime: z.string().optional().describe("New check-in time, 24h HH:MM."),
          checkOutTime: z.string().optional().describe("New check-out time, 24h HH:MM."),
          guestCount: z.number().int().min(1).optional().describe("New guest count."),
          listingId: z.number().int().positive().optional().describe(
            "Move the reservation to another property in this workspace."
          ),
          idempotency_key: z.string().optional().describe(
            "Optional Idempotency-Key header. The same key replays the stored response for 24 hours; the same key with a CHANGED payload is rejected with 422 idempotency_key_reused."
          ),
        },
      },
      async ({ id, idempotency_key, ...body }) => {
        try {
          const data = await client.patch(resolvePath(TOOL_PATHS.repull_update_reservation, { id }), {
            body: compact(body as Record<string, unknown>),
            idempotencyKey: idempotency_key,
          });
          return jsonText(data);
        } catch (err) {
          return errorText(err);
        }
      }
    );
  }

  if (enabledScopes.has("guests:create")) {
    server.registerTool(
      "repull_create_guest",
      {
        title: "Create a guest",
        description:
          "Create a guest profile, or match an existing one. Only `firstName` is required. The API " +
          "matches on email/phone plus name before writing, so ALWAYS read `created` on the response " +
          "rather than assuming a 2xx means a new record was made — `created: false` means an existing " +
          "guest matched and was returned. Email and phone come back as separate entries in `contacts`. " +
          "Pass `idempotency_key` so a retry cannot create a duplicate.",
        inputSchema: {
          firstName: z.string().describe("Guest's first name. The only required field."),
          lastName: z.string().optional().describe("Guest's last name."),
          email: z.string().email().optional().describe("Email address. Used for matching an existing guest."),
          phone: z.string().optional().describe(
            "Phone number, E.164 preferred (e.g. '+14035551234'). Stored normalised. Used for matching."
          ),
          language: z.string().optional().describe("BCP-47 language tag, e.g. 'en-GB'."),
          currency: z.string().length(3).optional().describe("Three-letter currency code, e.g. 'GBP'."),
          isBusinessTraveler: z.boolean().optional().describe("Mark the guest as a business traveller. Defaults to false."),
          idempotency_key: z.string().optional().describe(
            "Optional Idempotency-Key header. Send a unique string per distinct request: the same key replays the stored response for 24 hours; the same key with a CHANGED payload is rejected with 422 idempotency_key_reused. Recommended for production agents."
          ),
        },
      },
      async ({ idempotency_key, ...body }) => {
        try {
          const data = await client.post(TOOL_PATHS.repull_create_guest, {
            body: compact(body as Record<string, unknown>),
            idempotencyKey: idempotency_key,
          });
          return jsonText(data);
        } catch (err) {
          return errorText(err);
        }
      }
    );
  }

  if (enabledScopes.has("messaging:send")) {
    server.registerTool(
      "repull_send_conversation_message",
      {
        title: "Send a message to the guest",
        description:
          "Send a message to the guest on an existing conversation thread. This reaches a real person — " +
          "confirm the text with the user before calling it. Omit `channel` to send on whichever channel " +
          "the thread already uses, which is the right default. ALWAYS check `contentRewritten` on the " +
          "response: when it is true the channel altered the text before delivery (today that means " +
          "Airbnb stripped a link, an email address or a phone number), so the guest received " +
          "`deliveredContent`, NOT `submittedContent` — tell the user when that happens. Pass " +
          "`idempotency_key` so a retry cannot send the guest the same message twice.",
        inputSchema: {
          id: z.number().int().positive().describe(
            "Internal Repull thread ID — from `repull_list_conversations`."
          ),
          message: z.string().min(1).max(4000).describe("The text to send the guest. 1–4000 characters."),
          channel: z.enum(["airbnb", "booking", "sms", "email", "website"]).optional().describe(
            "Force a channel. Omit to send on whichever channel the conversation already uses."
          ),
          idempotency_key: z.string().optional().describe(
            "Optional Idempotency-Key header. Send a unique string per distinct message: the same key replays the stored response for 24 hours instead of sending again; the same key with CHANGED text is rejected with 422 idempotency_key_reused."
          ),
        },
      },
      async ({ id, idempotency_key, ...body }) => {
        try {
          const data = await client.post(
            resolvePath(TOOL_PATHS.repull_send_conversation_message, { id }),
            {
              body: compact(body as Record<string, unknown>),
              idempotencyKey: idempotency_key,
            }
          );
          return jsonText(data);
        } catch (err) {
          return errorText(err);
        }
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Connect tools. These kick off OAuth flows or provision sessions; they don't
// mutate listings or reservations. The guest/reservation/messaging writes live
// in registerWriteTools() above, gated behind REPULL_MCP_ENABLE_WRITES.
// ---------------------------------------------------------------------------

function registerConnectTools(server: McpServer, client: RepullClient): void {
  server.registerTool(
    "repull_list_connections",
    {
      title: "List active PMS/OTA connections",
      description:
        "List every PMS/OTA connection on the workspace, with status (`connected`, `disconnected`, " +
        "`error`, ...). Use this to check what the user has wired up before suggesting actions. Also " +
        "surfaced inside `repull_whoami`.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonText(await client.get(TOOL_PATHS.repull_list_connections));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "repull_list_connect_providers",
    {
      title: "List connectable channels (registry)",
      description:
        "List every channel the user can connect to (PMS adapters + OTAs), with metadata like " +
        "display name, supported features, and required credentials. Use this to answer 'what can I " +
        "connect Repull to?' before kicking off a Connect flow.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonText(await client.get(TOOL_PATHS.repull_list_connect_providers));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "repull_create_connect_session",
    {
      title: "Start a single-provider Connect flow",
      description:
        "Create a Connect session for ONE specific provider. For Airbnb (and other OAuth-based " +
        "channels), returns a hosted `oauthUrl` to redirect the user to. For PMS providers, accepts " +
        "API-key credentials directly in the request body. This is the safe, read-mostly write surface " +
        "— no reservations or listings are mutated. For a multi-channel picker UI, use " +
        "`repull_create_connect_picker_session` instead.",
      inputSchema: {
        provider: z
          .enum([
            "airbnb",
            "booking",
            "vrbo",
            "plumguide",
            "guesty",
            "hostaway",
            "hostfully",
            "lodgify",
            "ownerrez",
            "stayntouch",
          ])
          .describe(
            "Target provider. Use 'airbnb' for OAuth flows; PMS providers expect API-key credentials in the request."
          ),
        redirectUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "Airbnb only — where to redirect the user after the OAuth flow completes."
          ),
        accessType: z
          .enum(["read_only", "full_access"])
          .optional()
          .describe(
            "Airbnb only — OAuth scope set. 'read_only' grants calendar-only access; 'full_access' grants full host scopes (default)."
          ),
        apiKey: z.string().optional().describe(
          "PMS providers only — the customer's API key for the target PMS."
        ),
        clientId: z.string().optional().describe(
          "Plumguide only — client ID for the customer's Plumguide partner credentials."
        ),
        clientSecret: z.string().optional().describe(
          "Plumguide only — client secret for the customer's Plumguide partner credentials."
        ),
        idempotency_key: z.string().optional().describe(
          "Optional Idempotency-Key header — pass the same value to retry a Connect call without creating a duplicate session. Recommended for production agents."
        ),
      },
    },
    async (args) => {
      try {
        const { provider, idempotency_key, ...body } = args;
        const data = await client.post(resolvePath(TOOL_PATHS.repull_create_connect_session, { provider }), {
          body: compact(body as Record<string, unknown>),
          idempotencyKey: idempotency_key,
        });
        return jsonText(data);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "repull_create_connect_picker_session",
    {
      title: "Start a multi-channel Connect picker session",
      description:
        "Create a Connect picker session that shows the user a UI listing every connectable channel, " +
        "lets them pick one, and routes them through the right OAuth/API-key flow. Use this when the " +
        "user wants to connect 'something' but hasn't picked a provider yet. Returns a hosted URL the " +
        "user opens in a browser. After they finish, they land back on `redirectUrl` with status query params.",
      inputSchema: {
        redirectUrl: z.string().url().describe(
          "Where to send the user after they finish (or cancel) the picker. Status query params are appended (e.g. `?session=...&status=connected`)."
        ),
        state: z.string().optional().describe(
          "Optional opaque correlation token. Echoed back unchanged in the response so you can match the session to your own context."
        ),
        allowed_providers: z.array(z.string()).optional().describe(
          "Optional whitelist of provider IDs the picker should expose (e.g. ['airbnb', 'booking', 'guesty']). Omit to show every channel in the registry."
        ),
        idempotency_key: z.string().optional().describe(
          "Optional Idempotency-Key header — pass the same value to safely retry without spawning a duplicate session."
        ),
      },
    },
    async ({ idempotency_key, ...body }) => {
      try {
        const data = await client.post(TOOL_PATHS.repull_create_connect_picker_session, {
          body: compact(body as Record<string, unknown>),
          idempotencyKey: idempotency_key,
        });
        return jsonText(data);
      } catch (err) {
        return errorText(err);
      }
    }
  );
}

// ---------------------------------------------------------------------------

// Only auto-run the server when this file is executed directly (`node
// dist/index.js`, the package's `bin` entry point) — NOT when it's imported,
// e.g. by src/write-tools.test.ts to exercise registerWriteTools()/
// parseWriteScopes() against a fake McpServer without booting a real stdio
// server.
const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(
      `[${PACKAGE_NAME}] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
    );
    process.exit(1);
  });
}
