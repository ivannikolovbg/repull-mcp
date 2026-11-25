/**
 * tiket.com tools — READ ONLY, like the Airbnb and Vrbo channel tools. Every
 * tiket tool sends a GET to a path the bundled spec declares, with the query
 * the API takes; no tiket write (rates, mapping, setup, publish) is a tool.
 */

import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepullClient } from "./client.js";
import { registerReadTools, registerWriteTools, registerConnectTools, WRITE_SCOPE_TOOLS, type WriteScope } from "./index.js";
import { TOOL_PATHS, SPEC_PATHS } from "./openapi-paths.js";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean }>;

function captureTools(register: (s: McpServer, c: RepullClient) => void) {
  const handlers = new Map<string, Handler>();
  const calls: Array<{ method: string; path: string; query?: Record<string, unknown> }> = [];
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const record =
    (method: string) =>
    async (path: string, opts?: { query?: Record<string, unknown> }) => {
      calls.push({ method, path, query: opts?.query });
      return { ok: true };
    };
  const client = {
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    patch: record("PATCH"),
    delete: record("DELETE"),
    request: record("REQUEST"),
  } as unknown as RepullClient;
  register(server, client);
  return { handlers, calls };
}

const TIKET_TOOLS = [
  "repull_list_tiket_properties",
  "repull_get_tiket_availability",
  "repull_get_tiket_listing_pricing",
  "repull_list_tiket_reservations",
] as const;

describe("tiket.com tools", () => {
  it("are registered as read tools, each on a path the bundled spec declares", () => {
    const { handlers } = captureTools(registerReadTools);
    for (const name of TIKET_TOOLS) {
      expect(handlers.has(name), name).toBe(true);
      expect(SPEC_PATHS.has(TOOL_PATHS[name]), TOOL_PATHS[name]).toBe(true);
    }
  });

  it("send GET with the API's query names", async () => {
    const { handlers, calls } = captureTools(registerReadTools);
    await handlers.get("repull_list_tiket_properties")!({ status: "all" });
    await handlers.get("repull_get_tiket_availability")!({ property_id: "123", number_of_days: 7 });
    await handlers.get("repull_get_tiket_listing_pricing")!({ id: "4118", hotel_id: "123" });
    await handlers.get("repull_list_tiket_reservations")!({ property_id: "123", status: "cancelled" });
    expect(calls).toEqual([
      { method: "GET", path: "/v1/channels/tiket/properties", query: { status: "all" } },
      { method: "GET", path: "/v1/channels/tiket/availability", query: { property_id: "123", number_of_days: 7 } },
      { method: "GET", path: "/v1/channels/tiket/listings/4118/pricing", query: { hotel_id: "123" } },
      { method: "GET", path: "/v1/channels/tiket/reservations", query: { property_id: "123", status: "cancelled" } },
    ]);
  });

  it("exposes no tiket.com write", () => {
    const names = [
      ...captureTools(registerReadTools).handlers.keys(),
      ...captureTools((s, c) => registerWriteTools(s, c, new Set(Object.keys(WRITE_SCOPE_TOOLS) as WriteScope[]))).handlers.keys(),
      ...captureTools(registerConnectTools).handlers.keys(),
    ];
    const tiket = names.filter((n) => n.includes("tiket"));
    expect(tiket.sort()).toEqual([...TIKET_TOOLS].sort());
  });
});
