/**
 * Spec-derived path resolution for @repull/mcp.
 *
 * Every tool in `index.ts` used to hardcode its own `/v1/...` literal. That
 * meant a path removed or renamed on the live API would silently start
 * 404ing at runtime instead of failing loudly at build/test time. This
 * module is the single place tool handlers resolve paths through:
 *
 *   1. `openapi/v1.json` — a committed snapshot of the live spec
 *      (https://api.repull.dev/openapi.json), loaded from disk so the
 *      server has zero network dependency at startup.
 *   2. `TOOL_PATHS` — a plain typed map from tool name -> spec path
 *      template (e.g. `/v1/reservations/{id}`).
 *   3. `resolvePath()` — fills in `{param}` placeholders for templated
 *      paths, in one place instead of scattered template literals.
 *   4. `assertToolPathsExistInSpec()` — verifies every template in
 *      `TOOL_PATHS` is still a real key in the bundled spec's `paths`
 *      object. Runs at module load (so a stale map crashes server startup
 *      loudly) and is also asserted directly in `openapi-paths.test.ts`.
 *
 * This is deliberately NOT a generic router — just a const map + a small
 * interpolation helper. Keep it that way.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
// Compiled output lives at dist/openapi-paths.js; the spec snapshot ships
// alongside dist/ at the package root (see package.json "files").
const SPEC_PATH = join(moduleDir, "..", "openapi", "v1.json");

interface OpenApiSpec {
  info?: { title?: string; version?: string };
  paths?: Record<string, unknown>;
  [key: string]: unknown;
}

function loadSpec(): OpenApiSpec {
  let raw: string;
  try {
    raw = readFileSync(SPEC_PATH, "utf-8");
  } catch (err) {
    throw new Error(
      `[openapi-paths] Failed to read bundled OpenAPI spec snapshot at ${SPEC_PATH}: ` +
        `${err instanceof Error ? err.message : String(err)}. This file ships with the ` +
        `package (openapi/v1.json) — if it's missing, reinstall @repull/mcp.`
    );
  }
  try {
    return JSON.parse(raw) as OpenApiSpec;
  } catch (err) {
    throw new Error(
      `[openapi-paths] Bundled OpenAPI spec snapshot at ${SPEC_PATH} is not valid JSON: ` +
        `${err instanceof Error ? err.message : String(err)}.`
    );
  }
}

/** The bundled OpenAPI spec snapshot, parsed once at module load. */
export const OPENAPI_SPEC: OpenApiSpec = loadSpec();

/** Every path template declared in the bundled spec, e.g. `/v1/reservations/{id}`. */
export const SPEC_PATHS: ReadonlySet<string> = new Set(Object.keys(OPENAPI_SPEC.paths ?? {}));

/**
 * Maps each MCP tool (or tool sub-call, for tools that hit more than one
 * endpoint) to the OpenAPI path template it calls. Tool handlers in
 * `index.ts` resolve paths ONLY through this map — never a literal string.
 */
export const TOOL_PATHS = {
  repull_health_check: "/v1/health",
  repull_whoami_usage: "/v1/usage/tier",
  repull_whoami_connect: "/v1/connect",
  repull_list_reservations: "/v1/reservations",
  repull_get_reservation: "/v1/reservations/{id}",
  repull_list_properties: "/v1/properties",
  repull_get_property: "/v1/properties/{id}",
  repull_list_listings: "/v1/listings",
  repull_list_airbnb_listings: "/v1/channels/airbnb/listings",
  repull_list_guests: "/v1/guests",
  repull_get_guest: "/v1/guests/{id}",
  repull_list_conversations: "/v1/conversations",
  repull_list_conversation_messages: "/v1/conversations/{id}/messages",
  repull_list_connections: "/v1/connect",
  repull_list_connect_providers: "/v1/connect/providers",
  repull_create_connect_session: "/v1/connect/{provider}",
  repull_create_connect_picker_session: "/v1/connect",
} as const satisfies Record<string, string>;

export type ToolPathName = keyof typeof TOOL_PATHS;

/**
 * Fills in `{param}` placeholders in a spec path template with concrete,
 * URI-encoded values. Keeps interpolation in one place instead of scattered
 * template literals across tool handlers.
 *
 *   resolvePath(TOOL_PATHS.repull_get_reservation, { id: 12345 })
 *   -> "/v1/reservations/12345"
 */
export function resolvePath(
  template: string,
  params: Record<string, string | number>
): string {
  return template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    if (!(key in params)) {
      throw new Error(`resolvePath: missing param "${key}" for template "${template}"`);
    }
    return encodeURIComponent(String(params[key]));
  });
}

/**
 * Verifies every path template referenced in `TOOL_PATHS` still exists as a
 * key in the bundled spec's `paths` object. This is the "fail loudly
 * instead of silently drifting" guarantee: if the live API removes or
 * renames a path and the snapshot is refreshed without updating this map
 * (or vice versa), this throws instead of the tool quietly 404ing at
 * runtime.
 */
export function assertToolPathsExistInSpec(): void {
  const missing = Object.entries(TOOL_PATHS).filter(([, path]) => !SPEC_PATHS.has(path));
  if (missing.length > 0) {
    const detail = missing.map(([tool, path]) => `${tool} -> ${path}`).join(", ");
    throw new Error(
      `[openapi-paths] Path(s) referenced by TOOL_PATHS are missing from the bundled ` +
        `OpenAPI spec (openapi/v1.json): ${detail}. Either the live API removed/renamed ` +
        `these paths (update TOOL_PATHS) or the snapshot is stale (refresh openapi/v1.json).`
    );
  }
}

// Run at module load so a stale/drifted map crashes server startup loudly
// rather than letting an individual tool call fail confusingly later.
assertToolPathsExistInSpec();
