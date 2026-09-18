/**
 * The Airbnb listing-content surface is READ ONLY in this server.
 *
 * The API exposes a PUT/PATCH on every one of these paths (booking settings,
 * details, photos + order + cover, rooms, amenities, descriptions, permits,
 * safety disclosures) plus `POST /v1/listings/{id}/pull/airbnb` and
 * `POST /v1/channels/airbnb/alterations/{id}/cancel`. Those writes change what
 * guests see, what a stay costs, and whether a booking stands — and an operator
 * who sets `REPULL_MCP_ENABLE_WRITES=all` to unlock message-sending would
 * inherit every one of them silently.
 *
 * So this test pins both halves: the reads ARE registered, and no tool anywhere
 * in the server points at one of the content write routes.
 *
 * Same fake-server approach as write-tools.test.ts — registration is all we're
 * proving, so an object with `registerTool` is enough.
 */

import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepullClient } from "./client.js";
import { registerReadTools, registerWriteTools, registerConnectTools } from "./index.js";
import { TOOL_PATHS, SPEC_PATHS } from "./openapi-paths.js";

function fakeServer(): { server: McpServer; registered: string[] } {
  const registered: string[] = [];
  const server = {
    registerTool: (name: string) => {
      registered.push(name);
    },
  } as unknown as McpServer;
  return { server, registered };
}

const fakeClient = {} as RepullClient;

const AIRBNB_CONTENT_READ_TOOLS = [
  "repull_get_airbnb_listing",
  "repull_get_airbnb_booking_settings",
  "repull_get_airbnb_listing_details",
  "repull_list_airbnb_listing_photos",
  "repull_list_airbnb_listing_rooms",
  "repull_list_airbnb_listing_amenities",
  "repull_list_airbnb_listing_descriptions",
  "repull_list_airbnb_listing_permits",
  "repull_list_airbnb_listing_safety_disclosures",
] as const;

/** Paths whose write methods this server deliberately does not expose. */
const WRITE_ONLY_PATHS = [
  "/v1/channels/airbnb/listings/{id}/photos/order",
  "/v1/channels/airbnb/listings/{id}/photos/cover",
  "/v1/channels/airbnb/alterations/{id}/cancel",
  "/v1/listings/{id}/pull/airbnb",
] as const;

describe("Airbnb listing content — reads", () => {
  it("registers every content read tool", () => {
    const { server, registered } = fakeServer();
    registerReadTools(server, fakeClient);
    for (const tool of AIRBNB_CONTENT_READ_TOOLS) {
      expect(registered, `${tool} should be registered`).toContain(tool);
    }
  });

  it("maps each one to a path the bundled spec actually declares", () => {
    for (const tool of AIRBNB_CONTENT_READ_TOOLS) {
      const path = (TOOL_PATHS as Record<string, string>)[tool];
      expect(path, `${tool} missing from TOOL_PATHS`).toBeTruthy();
      expect(SPEC_PATHS.has(path), `${path} missing from openapi/v1.json`).toBe(true);
    }
  });
});

describe("Airbnb listing content — writes stay unexposed", () => {
  it("no tool points at a write-only content route, even with every write scope enabled", () => {
    const { server, registered } = fakeServer();
    registerReadTools(server, fakeClient);
    registerConnectTools(server, fakeClient);
    registerWriteTools(
      server,
      fakeClient,
      new Set(["reservations:create", "reservations:update", "guests:create", "messaging:send"]),
    );

    const mappedPaths = registered
      .map((name) => (TOOL_PATHS as Record<string, string>)[name])
      .filter(Boolean);

    for (const path of WRITE_ONLY_PATHS) {
      // The path exists on the API...
      expect(SPEC_PATHS.has(path), `${path} should exist in the spec`).toBe(true);
      // ...but nothing in the tool map reaches it.
      expect(mappedPaths, `${path} must not be reachable from a tool`).not.toContain(path);
    }
  });
});
