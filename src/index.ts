#!/usr/bin/env node
/**
 * @repull/mcp — Model Context Protocol server for the Repull API.
 *
 * Exposes read-mostly tools (plus connect-session creation) over stdio so MCP
 * clients (Claude Desktop, Cursor, Continue, etc.) can talk to api.repull.dev.
 *
 * Auth: requires the `REPULL_API_KEY` environment variable.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRepullClient, RepullApiError } from "./client.js";

const PACKAGE_NAME = "@repull/mcp";
const PACKAGE_VERSION = "0.1.0";

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
  return process.env.REPULL_API_BASE_URL ?? "https://api.repull.dev";
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

function errorText(err: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  let message: string;
  if (err instanceof RepullApiError) {
    message = `Repull API error ${err.status}${err.code ? ` (${err.code})` : ""}: ${err.message}`;
    if (err.requestId) message += ` [request_id=${err.requestId}]`;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function main(): Promise<void> {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  const client = createRepullClient({ apiKey, baseUrl, userAgent: `${PACKAGE_NAME}/${PACKAGE_VERSION}` });

  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });

  // --- Tool: health check ----------------------------------------------------
  server.registerTool(
    "repull_health_check",
    {
      title: "Repull API health check",
      description:
        "Returns the Repull API health and version. Useful as a connectivity check before invoking other tools.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await client.get("/v1/health");
        return jsonText(data);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  // --- Tool: list reservations ----------------------------------------------
  server.registerTool(
    "repull_list_reservations",
    {
      title: "List reservations",
      description:
        "List reservations across all connected PMS platforms. Supports pagination plus optional filters by status and platform.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional()
          .describe("Page size (1–100). Defaults to the API default if omitted."),
        offset: z.number().int().min(0).optional()
          .describe("Pagination offset. Defaults to 0."),
        status: z.enum(["confirmed", "pending", "cancelled", "completed"]).optional()
          .describe("Filter by reservation status."),
        platform: z.string().optional()
          .describe("Filter by booking platform (e.g. 'airbnb', 'booking', 'vrbo')."),
        checkInFrom: z.string().optional()
          .describe("Check-in date range start, ISO date (YYYY-MM-DD)."),
        checkInTo: z.string().optional()
          .describe("Check-in date range end, ISO date (YYYY-MM-DD)."),
      },
    },
    async (args) => {
      try {
        const data = await client.get("/v1/reservations", { query: args });
        return jsonText(data);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  // --- Tool: get reservation by id ------------------------------------------
  server.registerTool(
    "repull_get_reservation",
    {
      title: "Get a reservation",
      description: "Fetch a single reservation by its numeric ID.",
      inputSchema: {
        id: z.number().int().positive().describe("Reservation ID."),
      },
    },
    async ({ id }) => {
      try {
        const data = await client.get(`/v1/reservations/${id}`);
        return jsonText(data);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  // --- Tool: list properties -------------------------------------------------
  server.registerTool(
    "repull_list_properties",
    {
      title: "List properties",
      description:
        "List all properties across connected PMS platforms. Supports pagination plus an optional filter by PMS provider.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        provider: z.string().optional()
          .describe("Filter by PMS provider (e.g. 'guesty', 'hostaway', 'hostfully')."),
      },
    },
    async (args) => {
      try {
        const data = await client.get("/v1/properties", { query: args });
        return jsonText(data);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  // --- Tool: list Airbnb listings -------------------------------------------
  server.registerTool(
    "repull_list_listings_airbnb",
    {
      title: "List Airbnb listings",
      description:
        "List Airbnb listings for the connected workspace. Requires an active Airbnb connection on the workspace tied to the API key.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await client.get("/v1/channels/airbnb/listings");
        return jsonText(data);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  // --- Tool: create connect session (the only "write" in v1) ----------------
  server.registerTool(
    "repull_create_connect_session",
    {
      title: "Start a Connect flow",
      description:
        "Create a Connect session for a PMS or OTA provider. Returns provider-specific session details (e.g. an Airbnb hosted `oauthUrl` to redirect the user to). This is the safe, read-mostly write surface — no reservations or listings are mutated.",
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
            "Target provider. Use 'airbnb' for OAuth flows; PMS providers expect API-key credentials in a follow-up step."
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
      },
    },
    async ({ provider, redirectUrl, accessType }) => {
      try {
        const body: Record<string, unknown> = {};
        if (redirectUrl !== undefined) body.redirectUrl = redirectUrl;
        if (accessType !== undefined) body.accessType = accessType;
        const data = await client.post(`/v1/connect/${provider}`, { body });
        return jsonText(data);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so we don't corrupt the stdio JSON-RPC channel.
  process.stderr.write(
    `[${PACKAGE_NAME}] connected (base=${baseUrl}). 6 tools registered.\n`
  );
}

main().catch((err) => {
  process.stderr.write(
    `[${PACKAGE_NAME}] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
  );
  process.exit(1);
});
