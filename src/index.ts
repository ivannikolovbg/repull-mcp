#!/usr/bin/env node
/**
 * @repull/mcp — Model Context Protocol server for the Repull API.
 *
 * Exposes a curated set of tools (discovery, introspection, reads, plus the
 * "start a Connect flow" entry point) over stdio so MCP clients (Claude
 * Desktop, Cursor, Continue, etc.) can talk to api.repull.dev.
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
 *   - Mutating tools (currently only the connect-session creators) accept an
 *     `idempotency_key` parameter that becomes the `Idempotency-Key` header.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRepullClient, RepullApiError, type RepullClient } from "./client.js";
import { registerStudioTools } from "./studio.js";

const PACKAGE_NAME = "@repull/mcp";
const PACKAGE_VERSION = "0.2.1";

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

async function main(): Promise<void> {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  const userAgent = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;
  const client = createRepullClient({ apiKey, baseUrl, userAgent });

  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });

  registerDiscoveryTools(server, userAgent);
  registerIntrospectionTools(server, client);
  registerReadTools(server, client);
  registerConnectTools(server, client);
  registerStudioTools(server, client, { errorFormat: errorText });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[${PACKAGE_NAME}] connected (base=${baseUrl}). 24 tools registered.\n`
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
        "is not') so you can avoid suggesting actions that will fail. Combines `GET /v1/billing` and " +
        "`GET /v1/connect` in a single call. Both sub-calls are best-effort; if either fails the other " +
        "is still returned.",
      inputSchema: {},
    },
    async () => {
      type Result = {
        api_base_url: string;
        billing?: unknown;
        billing_error?: unknown;
        connections?: unknown;
        connections_error?: unknown;
      };
      const result: Result = { api_base_url: getBaseUrl() };
      try {
        result.billing = await client.get("/v1/billing");
      } catch (err) {
        result.billing_error = err instanceof RepullApiError ? err.toMcpPayload() : { error: { message: String(err) } };
      }
      try {
        result.connections = await client.get("/v1/connect");
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
        return jsonText(await client.get("/v1/health"));
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

function registerReadTools(server: McpServer, client: RepullClient): void {
  // ---- Reservations ------------------------------------------------------
  server.registerTool(
    "repull_list_reservations",
    {
      title: "List reservations",
      description:
        "List reservations across every connected PMS and OTA. Supports cursor pagination plus filters " +
        "by status, platform, listing, and check-in date range. Common use cases: 'show me upcoming " +
        "reservations', 'how many cancellations this week', 'find Airbnb bookings for listing 4118'. " +
        "Returns `{ data: Reservation[], pagination: { next_cursor, has_more, ... } }` — pass " +
        "`pagination.next_cursor` back as `cursor` to fetch the next page.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe(
          "Page size (1–100). API defaults to 20 if omitted. Requests over 100 return a 422."
        ),
        cursor: z.string().optional().describe(
          "Opaque cursor returned in the previous response's `pagination.next_cursor`. Omit to fetch the first page."
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
        return jsonText(await client.get("/v1/reservations", { query: compact(args) }));
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
        return jsonText(await client.get(`/v1/reservations/${id}`));
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
        "Returns `{ data: Property[], pagination }` — pass `pagination.next_cursor` as `cursor` for the next page.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Page size (1–100). Defaults to 20."),
        cursor: z.string().optional().describe(
          "Opaque cursor from `pagination.next_cursor` in the previous response. Omit for first page."
        ),
        provider: z.string().optional().describe(
          "Filter by PMS provider slug (e.g. 'guesty', 'hostaway', 'hostfully', 'lodgify', 'ownerrez')."
        ),
      },
    },
    async (args) => {
      try {
        return jsonText(await client.get("/v1/properties", { query: compact(args) }));
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
        return jsonText(await client.get(`/v1/properties/${encodeURIComponent(id)}`));
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
          "Opaque cursor from `pagination.next_cursor` in the previous response."
        ),
      },
    },
    async (args) => {
      try {
        return jsonText(await client.get("/v1/listings", { query: compact(args) }));
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
        return jsonText(await client.get("/v1/channels/airbnb/listings"));
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
        cursor: z.string().optional().describe("Opaque cursor from `pagination.next_cursor`."),
      },
    },
    async (args) => {
      try {
        return jsonText(await client.get("/v1/guests", { query: compact(args) }));
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
        return jsonText(await client.get(`/v1/guests/${encodeURIComponent(id)}`));
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
        cursor: z.string().optional().describe("Opaque cursor from `pagination.next_cursor`."),
      },
    },
    async (args) => {
      try {
        return jsonText(await client.get("/v1/conversations", { query: compact(args) }));
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
        cursor: z.string().optional().describe("Opaque cursor from `pagination.next_cursor`."),
      },
    },
    async ({ id, limit, cursor }) => {
      try {
        return jsonText(
          await client.get(`/v1/conversations/${encodeURIComponent(id)}/messages`, {
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
// Connect tools — the only "writes" exposed in v1. These are safe by design
// (they kick off OAuth flows or provision sessions; they don't mutate listings
// or reservations). Mutating tools (cancel, modify, send-message, etc.) are
// deliberately not exposed yet — see README "Why no write tools (yet)".
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
        return jsonText(await client.get("/v1/connect"));
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
        return jsonText(await client.get("/v1/connect/providers"));
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
        const data = await client.post(`/v1/connect/${provider}`, {
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
        const data = await client.post(`/v1/connect`, {
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

main().catch((err) => {
  process.stderr.write(
    `[${PACKAGE_NAME}] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
  );
  process.exit(1);
});
