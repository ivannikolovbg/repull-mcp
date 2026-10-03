/**
 * repull_create_connect_session with provider "track": Track connects through
 * POST /v1/connect/track/credentials, so the tool must send the credentials
 * there (wrapped in `credentials`), not to POST /v1/connect/{provider}.
 */
import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepullClient } from "./client.js";
import { registerConnectTools } from "./index.js";
import { SPEC_PATHS } from "./openapi-paths.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function capture() {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const calls: { path: string; body: unknown; idempotencyKey?: string }[] = [];
  const client = {
    post: async (path: string, opts?: { body?: unknown; idempotencyKey?: string }) => {
      calls.push({ path, body: opts?.body, idempotencyKey: opts?.idempotencyKey });
      return { provider: "track", connected: true };
    },
    get: async () => ({}),
  } as unknown as RepullClient;
  return { server, client, handlers, calls };
}

describe("repull_create_connect_session — track", () => {
  it("posts the Track credentials to /v1/connect/track/credentials", async () => {
    const { server, client, handlers, calls } = capture();
    registerConnectTools(server, client);
    const res = await handlers.get("repull_create_connect_session")!({
      provider: "track",
      domain: "acme.trackhs.com",
      apiKey: "trk_live_x",
      apiSecret: "c2VjcmV0",
      keyType: "server",
      moveReasonId: 3,
      idempotency_key: "k-1",
    });
    expect(res.isError).toBeFalsy();
    expect(SPEC_PATHS.has("/v1/connect/track/credentials")).toBe(true);
    expect(calls).toEqual([
      {
        path: "/v1/connect/track/credentials",
        body: {
          credentials: {
            domain: "acme.trackhs.com",
            apiKey: "trk_live_x",
            apiSecret: "c2VjcmV0",
            keyType: "server",
            moveReasonId: 3,
          },
        },
        idempotencyKey: "k-1",
      },
    ]);
  });

  it("refuses without domain / apiSecret and makes no call", async () => {
    const { server, client, handlers, calls } = capture();
    registerConnectTools(server, client);
    const res = await handlers.get("repull_create_connect_session")!({ provider: "track", apiKey: "k" });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
