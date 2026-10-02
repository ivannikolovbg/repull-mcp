/**
 * repull_quote_reservation (always-on read) and the PMS booking fields on
 * repull_create_reservation (write, behind `reservations:create`): the tool
 * call must reach the right spec path with the caller's fields intact.
 */
import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepullClient } from "./client.js";
import { registerReadTools, registerWriteTools } from "./index.js";
import { SPEC_PATHS } from "./openapi-paths.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function capture() {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, Record<string, unknown>>();
  const server = {
    registerTool: (name: string, config: { inputSchema: Record<string, unknown> }, handler: Handler) => {
      handlers.set(name, handler);
      schemas.set(name, config.inputSchema);
    },
  } as unknown as McpServer;
  const calls: { path: string; body: unknown; idempotencyKey?: string }[] = [];
  const client = {
    post: async (path: string, opts?: { body?: unknown; idempotencyKey?: string }) => {
      calls.push({ path, body: opts?.body, idempotencyKey: opts?.idempotencyKey });
      return { ok: true };
    },
    get: async () => ({}),
  } as unknown as RepullClient;
  return { server, client, handlers, schemas, calls };
}

describe("repull_quote_reservation", () => {
  it("is a read tool: registered without any write scope", () => {
    const { server, client, handlers } = capture();
    registerReadTools(server, client);
    expect(handlers.has("repull_quote_reservation")).toBe(true);
    expect(SPEC_PATHS.has("/v1/reservations/quote")).toBe(true);
  });

  it("POSTs the stay to /v1/reservations/quote and drops unset fields", async () => {
    const { server, client, handlers, calls } = capture();
    registerReadTools(server, client);
    await handlers.get("repull_quote_reservation")!({
      listingId: 4118,
      checkIn: "2026-10-01",
      checkOut: "2026-10-05",
      adults: 2,
      children: 1,
      unitId: undefined,
    });
    expect(calls).toEqual([
      {
        path: "/v1/reservations/quote",
        body: { listingId: 4118, checkIn: "2026-10-01", checkOut: "2026-10-05", adults: 2, children: 1 },
        idempotencyKey: undefined,
      },
    ]);
  });
});

describe("repull_create_reservation PMS fields", () => {
  it("accepts and forwards adults, children, totalPrice, notes, unitId, status, sendConfirmationEmail", async () => {
    const { server, client, handlers, schemas, calls } = capture();
    registerWriteTools(server, client, new Set(["reservations:create"]));
    const schema = schemas.get("repull_create_reservation")!;
    for (const f of ["adults", "children", "totalPrice", "notes", "unitId", "status", "sendConfirmationEmail"]) {
      expect(schema).toHaveProperty(f);
    }
    await handlers.get("repull_create_reservation")!({
      listingId: 4118,
      checkIn: "2026-10-01",
      checkOut: "2026-10-05",
      guest: { firstName: "Ada" },
      adults: 2,
      children: 1,
      totalPrice: 880,
      notes: "Late arrival",
      unitId: "u-1",
      status: "tentative",
      sendConfirmationEmail: false,
      idempotency_key: "k-1",
    });
    expect(calls[0].path).toBe("/v1/reservations");
    expect(calls[0].idempotencyKey).toBe("k-1");
    expect(calls[0].body).toEqual({
      listingId: 4118,
      checkIn: "2026-10-01",
      checkOut: "2026-10-05",
      guest: { firstName: "Ada" },
      adults: 2,
      children: 1,
      totalPrice: 880,
      notes: "Late arrival",
      unitId: "u-1",
      status: "tentative",
      sendConfirmationEmail: false,
    });
  });
});
