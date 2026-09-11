/**
 * Write-tool gating tests — proves REPULL_MCP_ENABLE_WRITES controls exactly
 * which of the four mutating tools (repull_create_reservation,
 * repull_update_reservation, repull_create_guest,
 * repull_send_conversation_message) get registered, and that unrecognised
 * scopes are rejected loudly rather than silently ignored or silently
 * enabling something.
 *
 * We don't spin up a real McpServer/stdio transport here — registerWriteTools()
 * only needs an object with a `registerTool` method, so a fake that records
 * the names it was called with is enough to prove registration behavior
 * without the protocol overhead. The README's own JSON-RPC smoke test
 * (see README "Local development") is the end-to-end proof this same
 * behavior holds through a real `tools/list` call.
 */

import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepullClient } from "./client.js";
import {
  parseWriteScopes,
  registerReadTools,
  registerWriteTools,
  WRITE_SCOPE_TOOLS,
  type WriteScope,
} from "./index.js";

const ALL_WRITE_TOOL_NAMES = Object.values(WRITE_SCOPE_TOOLS).sort();

/** A fake McpServer that just records the tool names it was asked to register. */
function fakeServer(): { server: McpServer; registered: string[] } {
  const registered: string[] = [];
  const server = {
    registerTool: (name: string, _config: unknown, _handler: unknown) => {
      registered.push(name);
    },
  } as unknown as McpServer;
  return { server, registered };
}

// Never invoked during registration — registerWriteTools only reads it into
// closures that fire on tool *calls*, which these tests never make.
const fakeClient = {} as RepullClient;

function registerWithScopes(scopes: ReadonlySet<WriteScope>): string[] {
  const { server, registered } = fakeServer();
  registerWriteTools(server, fakeClient, scopes);
  return registered.sort();
}

describe("parseWriteScopes", () => {
  it("no env var -> empty scope set, no unknowns", () => {
    const { enabled, unknown } = parseWriteScopes(undefined);
    expect(enabled.size).toBe(0);
    expect(unknown).toEqual([]);
  });

  it("empty string -> empty scope set", () => {
    const { enabled, unknown } = parseWriteScopes("");
    expect(enabled.size).toBe(0);
    expect(unknown).toEqual([]);
  });

  it("a single valid scope is parsed", () => {
    const { enabled, unknown } = parseWriteScopes("reservations:create");
    expect([...enabled]).toEqual(["reservations:create"]);
    expect(unknown).toEqual([]);
  });

  it("multiple scopes, comma-separated", () => {
    const { enabled, unknown } = parseWriteScopes("reservations:create,messaging:send");
    expect([...enabled].sort()).toEqual(["messaging:send", "reservations:create"]);
    expect(unknown).toEqual([]);
  });

  it("is forgiving of whitespace and case", () => {
    const { enabled, unknown } = parseWriteScopes("  Reservations:Create , MESSAGING:SEND  ");
    expect([...enabled].sort()).toEqual(["messaging:send", "reservations:create"]);
    expect(unknown).toEqual([]);
  });

  it("an unknown scope is reported and enables nothing", () => {
    const { enabled, unknown } = parseWriteScopes("reservations:cancel");
    expect(enabled.size).toBe(0);
    expect(unknown).toEqual(["reservations:cancel"]);
  });

  it("a mix of valid and unknown scopes enables only the valid ones and reports the rest", () => {
    const { enabled, unknown } = parseWriteScopes("reservations:create,bogus:thing");
    expect([...enabled]).toEqual(["reservations:create"]);
    expect(unknown).toEqual(["bogus:thing"]);
  });

  it("'*' enables every write scope", () => {
    const { enabled, unknown } = parseWriteScopes("*");
    expect([...enabled].sort()).toEqual(Object.keys(WRITE_SCOPE_TOOLS).sort());
    expect(unknown).toEqual([]);
  });

  it("'all' (any case) enables every write scope", () => {
    const { enabled, unknown } = parseWriteScopes("ALL");
    expect([...enabled].sort()).toEqual(Object.keys(WRITE_SCOPE_TOOLS).sort());
    expect(unknown).toEqual([]);
  });
});

describe("registerWriteTools", () => {
  it("(a) no scopes enabled -> none of the four write tools are registered", () => {
    const registered = registerWithScopes(new Set());
    expect(registered).toEqual([]);
    for (const name of ALL_WRITE_TOOL_NAMES) {
      expect(registered).not.toContain(name);
    }
  });

  it("(b) a single scope registers exactly that one tool", () => {
    const registered = registerWithScopes(new Set<WriteScope>(["reservations:create"]));
    expect(registered).toEqual(["repull_create_reservation"]);
  });

  it("(b2) each of the other three scopes independently registers exactly its own tool", () => {
    expect(registerWithScopes(new Set<WriteScope>(["reservations:update"]))).toEqual([
      "repull_update_reservation",
    ]);
    expect(registerWithScopes(new Set<WriteScope>(["guests:create"]))).toEqual([
      "repull_create_guest",
    ]);
    expect(registerWithScopes(new Set<WriteScope>(["messaging:send"]))).toEqual([
      "repull_send_conversation_message",
    ]);
  });

  it("(c) multiple scopes register exactly their tools, nothing more", () => {
    const registered = registerWithScopes(
      new Set<WriteScope>(["reservations:create", "messaging:send"])
    );
    expect(registered).toEqual(
      ["repull_create_reservation", "repull_send_conversation_message"].sort()
    );
  });

  it("(d) an unknown scope from parseWriteScopes results in zero tools registered", () => {
    const { enabled, unknown } = parseWriteScopes("not_a_real_scope");
    expect(unknown).toEqual(["not_a_real_scope"]);
    const registered = registerWithScopes(enabled);
    expect(registered).toEqual([]);
  });

  it("all four scopes together register all four write tools", () => {
    const registered = registerWithScopes(
      new Set<WriteScope>(Object.keys(WRITE_SCOPE_TOOLS) as WriteScope[])
    );
    expect(registered).toEqual(ALL_WRITE_TOOL_NAMES);
  });

  it("the wildcard parse result registers all four write tools", () => {
    const { enabled } = parseWriteScopes("*");
    const registered = registerWithScopes(enabled);
    expect(registered).toEqual(ALL_WRITE_TOOL_NAMES);
  });
});

describe("registerReadTools", () => {
  it("never registers any of the four gated write tools, regardless of env", () => {
    const { server, registered } = fakeServer();
    registerReadTools(server, fakeClient);
    for (const name of ALL_WRITE_TOOL_NAMES) {
      expect(registered).not.toContain(name);
    }
  });
});
