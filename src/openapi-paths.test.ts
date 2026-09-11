/**
 * Verifies the spec-derived path map stays honest against the bundled
 * OpenAPI snapshot (openapi/v1.json). This is the guard that's supposed to
 * catch a path removed/renamed on the live API instead of letting a tool
 * silently 404 at runtime.
 */

import { describe, it, expect } from "vitest";
import {
  assertToolPathsExistInSpec,
  OPENAPI_SPEC,
  resolvePath,
  SPEC_PATHS,
  TOOL_PATHS,
} from "./openapi-paths.js";

describe("openapi-paths", () => {
  it("loads the bundled spec from disk with a non-empty paths object", () => {
    expect(OPENAPI_SPEC.info?.title).toBe("Repull API");
    expect(SPEC_PATHS.size).toBeGreaterThan(0);
  });

  it("every TOOL_PATHS template exists as a key in the bundled spec's paths object", () => {
    for (const [tool, path] of Object.entries(TOOL_PATHS)) {
      expect(SPEC_PATHS.has(path), `${tool} -> ${path} missing from openapi/v1.json`).toBe(true);
    }
  });

  it("assertToolPathsExistInSpec() does not throw against the current snapshot", () => {
    expect(() => assertToolPathsExistInSpec()).not.toThrow();
  });

  it("assertToolPathsExistInSpec() throws when a path is missing from the spec (sanity check on the guard itself)", () => {
    const brokenSpecPaths = new Set(SPEC_PATHS);
    brokenSpecPaths.delete("/v1/reservations/{id}");
    const brokenPaths = { repull_get_reservation: "/v1/reservations/{id}" } as const;

    const assertAgainst = (map: Record<string, string>, specPaths: ReadonlySet<string>) => {
      const missing = Object.entries(map).filter(([, path]) => !specPaths.has(path));
      if (missing.length > 0) {
        throw new Error(
          `Path(s) missing from spec: ${missing.map(([tool, path]) => `${tool} -> ${path}`).join(", ")}`
        );
      }
    };

    expect(() => assertAgainst(brokenPaths, brokenSpecPaths)).toThrow(/missing from spec/);
    // And confirm it does NOT throw for the same tool against the real snapshot.
    expect(() => assertAgainst(brokenPaths, SPEC_PATHS)).not.toThrow();
  });

  it("resolvePath fills in and URI-encodes {param} placeholders", () => {
    expect(resolvePath("/v1/reservations/{id}", { id: 12345 })).toBe("/v1/reservations/12345");
    expect(resolvePath("/v1/guests/{id}", { id: "guest abc/123" })).toBe(
      "/v1/guests/guest%20abc%2F123"
    );
    expect(resolvePath("/v1/connect/{provider}", { provider: "airbnb" })).toBe(
      "/v1/connect/airbnb"
    );
  });

  it("resolvePath throws when a required param is missing", () => {
    expect(() => resolvePath("/v1/reservations/{id}", {})).toThrow(/missing param "id"/);
  });
});
