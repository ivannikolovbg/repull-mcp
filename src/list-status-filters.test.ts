/**
 * The API now returns ACTIVE listings/properties by default, so an agent can
 * only see inactive ones through the `status` filter. These tests pin each
 * list tool's `status` enum to the enum the bundled OpenAPI snapshot declares,
 * so a spec change that adds or drops a value fails here instead of silently
 * rejecting a valid filter (or advertising a dead one) at runtime.
 */

import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepullClient } from "./client.js";
import { registerConnectTools, registerReadTools } from "./index.js";
import { OPENAPI_SPEC } from "./openapi-paths.js";

interface ZodLike {
  unwrap?: () => ZodLike;
  options?: readonly string[];
  _def?: { innerType?: ZodLike; values?: readonly string[] };
}

function captureConfigs(register: (s: McpServer, c: RepullClient) => void) {
  const configs = new Map<string, { inputSchema?: Record<string, ZodLike> }>();
  const server = {
    registerTool: (name: string, config: { inputSchema?: Record<string, ZodLike> }) => {
      configs.set(name, config);
    },
  } as unknown as McpServer;
  register(server, {} as RepullClient);
  return configs;
}

function enumValues(schema: ZodLike | undefined): string[] {
  let s = schema;
  while (s && !s.options && s._def?.innerType) s = s._def.innerType;
  return [...(s?.options ?? s?._def?.values ?? [])].sort();
}

function specStatusEnum(path: string): string[] {
  const op = (OPENAPI_SPEC.paths as Record<string, { get?: { parameters?: unknown[] } }>)[path]?.get;
  const param = (op?.parameters ?? []).find(
    (p): p is { name: string; schema: { enum: string[] } } =>
      typeof p === "object" && p !== null && (p as { name?: string }).name === "status"
  );
  return [...(param?.schema.enum ?? [])].sort();
}

describe("list tool status filters match the spec", () => {
  const configs = captureConfigs(registerReadTools);

  it("repull_list_listings.status", () => {
    const expected = specStatusEnum("/v1/listings");
    expect(expected).toContain("inactive");
    expect(enumValues(configs.get("repull_list_listings")?.inputSchema?.status)).toEqual(expected);
  });

  it("repull_list_properties.status", () => {
    const expected = specStatusEnum("/v1/properties");
    expect(expected).toContain("inactive");
    expect(enumValues(configs.get("repull_list_properties")?.inputSchema?.status)).toEqual(expected);
  });
});

describe("repull_create_connect_session.accessType", () => {
  it("offers every Airbnb tier the spec declares", () => {
    const configs = captureConfigs(registerConnectTools);
    const spec = OPENAPI_SPEC.paths as Record<string, any>;
    const declared: string[] =
      spec["/v1/connect/{provider}"].post.requestBody.content["application/json"].schema.properties.accessType.enum;
    expect(enumValues(configs.get("repull_create_connect_session")?.inputSchema?.accessType)).toEqual(
      [...declared].sort()
    );
  });
});
