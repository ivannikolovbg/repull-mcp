/**
 * Vrbo listing content — READ ONLY in this server, like the Airbnb content
 * tools (see airbnb-content-tools.test.ts).
 *
 * The API exposes PUT on every Vrbo section, POST/DELETE on videos and a push
 * onto an existing Vrbo listing. None of them are tools: they change what
 * guests see and what a stay costs. Vrbo writes share their paths with the
 * reads, so instead of a list of write-only paths this test calls every Vrbo
 * tool against a client that records the HTTP method, and requires GET only.
 *
 * It also pins each tool to a path the bundled spec declares, and the query
 * each tool sends (`sections`, `groups`, `start`/`end`, `vrboListingNumber`).
 */

import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepullClient } from "./client.js";
import { registerReadTools, registerWriteTools, registerConnectTools } from "./index.js";
import { TOOL_PATHS, SPEC_PATHS, OPENAPI_SPEC } from "./openapi-paths.js";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean }>;

interface Call {
  method: string;
  path: string;
  query?: Record<string, unknown>;
}

function captureTools(register: (s: McpServer, c: RepullClient) => void) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, { description?: string; inputSchema?: Record<string, unknown> }>();
  const calls: Call[] = [];
  const server = {
    registerTool: (name: string, config: { description?: string }, handler: Handler) => {
      handlers.set(name, handler);
      configs.set(name, config);
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
  return { handlers, configs, calls };
}

const VRBO_CONTENT_READ_TOOLS = [
  "repull_list_vrbo_listings",
  "repull_get_vrbo_listing",
  "repull_get_vrbo_listing_content",
  "repull_list_vrbo_listing_descriptions",
  "repull_get_vrbo_listing_details",
  "repull_list_vrbo_listing_photos",
  "repull_list_vrbo_listing_amenities",
  "repull_list_vrbo_listing_rooms",
  "repull_get_vrbo_listing_house_rules",
  "repull_get_vrbo_listing_booking_settings",
  "repull_get_vrbo_listing_cancellation",
  "repull_get_vrbo_listing_fees",
  "repull_get_vrbo_listing_rates",
  "repull_list_vrbo_listing_permits",
  "repull_list_vrbo_listing_safety_disclosures",
] as const;

describe("Vrbo listing content — reads", () => {
  it("registers every content read tool", () => {
    const { handlers } = captureTools(registerReadTools);
    for (const tool of VRBO_CONTENT_READ_TOOLS) {
      expect(handlers.has(tool), `${tool} should be registered`).toBe(true);
    }
  });

  it("maps each one to a path the bundled spec declares with a GET", () => {
    const paths = OPENAPI_SPEC.paths as Record<string, { get?: unknown }>;
    for (const tool of VRBO_CONTENT_READ_TOOLS) {
      const path = (TOOL_PATHS as Record<string, string>)[tool];
      expect(path, `${tool} missing from TOOL_PATHS`).toBeTruthy();
      expect(SPEC_PATHS.has(path), `${path} missing from openapi/v1.json`).toBe(true);
      expect(paths[path]?.get, `${path} has no GET in the spec`).toBeTruthy();
    }
  });

  it("tells the agent the id is the Repull listing id, not the Vrbo number", () => {
    const { configs } = captureTools(registerReadTools);
    for (const tool of VRBO_CONTENT_READ_TOOLS.filter((t) => t !== "repull_list_vrbo_listings")) {
      const id = configs.get(tool)?.inputSchema?.id as { description?: string } | undefined;
      expect(id?.description, tool).toMatch(/Repull listing id/);
      expect(id?.description, tool).toMatch(/not the Vrbo listing/);
    }
  });

  it("says reads come from Repull's copy, on the Airbnb tools' names", () => {
    const { configs } = captureTools(registerReadTools);
    expect(configs.get("repull_get_vrbo_listing_content")?.description).toMatch(/Repull's copy/);
    expect(configs.get("repull_list_vrbo_listing_descriptions")?.description).toMatch(/Airbnb tools/);
  });

  it("sends the section path and query each tool is meant to", async () => {
    const { handlers, calls } = captureTools(registerReadTools);
    const run = async (tool: string, args: Record<string, unknown>) => {
      calls.length = 0;
      const res = await handlers.get(tool)!(args);
      expect(res.isError, tool).toBeFalsy();
      expect(calls).toHaveLength(1);
      return calls[0];
    };

    expect(
      await run("repull_get_vrbo_listing_content", { id: "123", sections: "descriptions,fees" })
    ).toEqual({
      method: "GET",
      path: "/v1/channels/vrbo/listings/123/content",
      query: { sections: "descriptions,fees" },
    });

    expect(
      await run("repull_list_vrbo_listing_amenities", {
        id: "123",
        groups: "essentials,parking",
        vrboListingNumber: "5506023",
      })
    ).toEqual({
      method: "GET",
      path: "/v1/channels/vrbo/listings/123/amenities",
      query: { groups: "essentials,parking", vrboListingNumber: "5506023" },
    });

    expect(
      await run("repull_get_vrbo_listing_rates", { id: "123", start: "2026-12-01", end: "2026-12-31" })
    ).toEqual({
      method: "GET",
      path: "/v1/channels/vrbo/listings/123/rates",
      query: { start: "2026-12-01", end: "2026-12-31" },
    });

    expect(await run("repull_get_vrbo_listing_house_rules", { id: "123" })).toEqual({
      method: "GET",
      path: "/v1/channels/vrbo/listings/123/house-rules",
      query: {},
    });

    expect(await run("repull_get_vrbo_listing", { id: "123", include: "content" })).toEqual({
      method: "GET",
      path: "/v1/channels/vrbo/listings/123",
      query: { include: "content" },
    });

    expect(await run("repull_list_vrbo_listing_descriptions", { id: "123" })).toEqual({
      method: "GET",
      path: "/v1/channels/vrbo/listings/123/descriptions",
      query: {},
    });

    expect(await run("repull_list_vrbo_listings", { status: "all" })).toEqual({
      method: "GET",
      path: "/v1/channels/vrbo/listings",
      query: { status: "all" },
    });
  });
});

describe("Vrbo listing content — writes stay unexposed", () => {
  it("every Vrbo tool only ever reads, even with every write scope enabled", async () => {
    const register = (s: McpServer, c: RepullClient) => {
      registerReadTools(s, c);
      registerConnectTools(s, c);
      registerWriteTools(
        s,
        c,
        new Set(["reservations:create", "reservations:update", "guests:create", "messaging:send"])
      );
    };
    const { handlers, calls } = captureTools(register);

    const vrboTools = [...handlers.keys()].filter((name) => name.includes("vrbo"));
    expect([...vrboTools].sort()).toEqual([...VRBO_CONTENT_READ_TOOLS].sort());

    for (const tool of vrboTools) {
      await handlers.get(tool)!({ id: "1", sections: "all" });
    }
    expect(calls.length).toBe(vrboTools.length);
    expect(calls.every((c) => c.method === "GET")).toBe(true);

    // No tool of any kind is mapped onto a Vrbo listing-content path other than
    // through the read tools above.
    const contentPathTools = Object.entries(TOOL_PATHS as Record<string, string>)
      .filter(([, path]) => path.startsWith("/v1/channels/vrbo/listings/{id}/"))
      .map(([name]) => name);
    for (const name of contentPathTools) {
      expect(VRBO_CONTENT_READ_TOOLS as readonly string[]).toContain(name);
    }
  });
});
