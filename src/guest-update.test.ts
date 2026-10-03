/**
 * repull_update_guest: PATCH /v1/guests/{id} with only the fields that change,
 * gated behind the `guests:update` write scope.
 */
import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepullClient } from "./client.js";
import { registerWriteTools } from "./index.js";
import { SPEC_PATHS } from "./openapi-paths.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function capture() {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const calls: { method: string; path: string; body: unknown; idempotencyKey?: string }[] = [];
  const record = (method: string) => async (path: string, opts?: { body?: unknown; idempotencyKey?: string }) => {
    calls.push({ method, path, body: opts?.body, idempotencyKey: opts?.idempotencyKey });
    return { id: 42, firstName: "Ana", lastName: "Lopez", pms: [{ provider: "guesty", applied: ["guest"] }] };
  };
  const client = { post: record("POST"), patch: record("PATCH"), get: async () => ({}) } as unknown as RepullClient;
  return { server, client, handlers, calls };
}

describe("repull_update_guest", () => {
  it("registers only under guests:update", () => {
    const { server, client, handlers } = capture();
    registerWriteTools(server, client, new Set(["guests:create"]));
    expect(handlers.has("repull_update_guest")).toBe(false);
    registerWriteTools(server, client, new Set(["guests:update"]));
    expect(handlers.has("repull_update_guest")).toBe(true);
  });

  it("PATCHes /v1/guests/{id} with only the changed fields", async () => {
    const { server, client, handlers, calls } = capture();
    registerWriteTools(server, client, new Set(["guests:update"]));
    const res = await handlers.get("repull_update_guest")!({ id: 42, lastName: "Lopez", idempotency_key: "k-1" });
    expect(res.isError).toBeFalsy();
    expect(SPEC_PATHS.has("/v1/guests/{id}")).toBe(true);
    expect(calls).toEqual([{ method: "PATCH", path: "/v1/guests/42", body: { lastName: "Lopez" }, idempotencyKey: "k-1" }]);
    expect(res.content[0].text).toContain("guesty");
  });

  it("refuses an empty change and makes no call", async () => {
    const { server, client, handlers, calls } = capture();
    registerWriteTools(server, client, new Set(["guests:update"]));
    const res = await handlers.get("repull_update_guest")!({ id: 42 });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("repull_create_guest forwards provider", async () => {
    const { server, client, handlers, calls } = capture();
    registerWriteTools(server, client, new Set(["guests:create"]));
    await handlers.get("repull_create_guest")!({ firstName: "Ana", lastName: "Lopez", provider: "guesty" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/guests", body: { firstName: "Ana", lastName: "Lopez", provider: "guesty" } });
  });
});
