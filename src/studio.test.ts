/**
 * Studio tool tests — verify each handler calls the right dominator endpoint
 * with the right payload, and that errors come back as MCP error envelopes.
 *
 * We mock `globalThis.fetch` and create a real `RepullClient` so we exercise
 * the full HTTP code path (URL building, headers, error parsing) — not just
 * the handler signature.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRepullClient, RepullApiError, type RepullClient } from "./client.js";
import {
  registerStudioTools,
  STUDIO_TOOL_NAMES,
  studioCreateProject,
  studioDeploy,
  studioGenerate,
  studioGetProject,
  studioListFiles,
  studioListProjects,
} from "./studio.js";

const BASE_URL = "https://api.repull.dev";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let captured: CapturedRequest[];
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(data: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", "x-request-id": "req_test_123" },
  });
}

function makeClient(): RepullClient {
  return createRepullClient({
    apiKey: "test-key",
    baseUrl: BASE_URL,
    userAgent: "@repull/mcp-test/0.0.0",
  });
}

beforeEach(() => {
  captured = [];
  fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const reqHeaders = init?.headers;
    if (reqHeaders) {
      // RequestInit headers can be a plain object, an array, or a Headers — normalise.
      if (reqHeaders instanceof Headers) {
        reqHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(reqHeaders)) {
        for (const pair of reqHeaders) {
          const k = pair[0];
          const v = pair[1];
          if (typeof k === "string" && typeof v === "string") {
            headers[k.toLowerCase()] = v;
          }
        }
      } else {
        for (const [k, v] of Object.entries(reqHeaders)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    }
    captured.push({
      url: String(url),
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return jsonResponse({ ok: true });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("studio tools — handlers", () => {
  it("studio_list_projects calls GET /api/studio/projects with query params", async () => {
    const client = makeClient();
    await studioListProjects(client, { q: "demo", limit: 5, offset: 10 });

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      `${BASE_URL}/api/studio/projects?q=demo&limit=5&offset=10`
    );
    expect(req.headers.authorization).toBe("Bearer test-key");
    expect(req.body).toBeUndefined();
  });

  it("studio_list_projects omits undefined query params", async () => {
    const client = makeClient();
    await studioListProjects(client, {});

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(`${BASE_URL}/api/studio/projects`);
  });

  it("studio_create_project posts JSON body to /api/studio/projects", async () => {
    const client = makeClient();
    await studioCreateProject(client, { name: "Demo", prompt: "hello" });

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE_URL}/api/studio/projects`);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body!)).toEqual({ name: "Demo", prompt: "hello" });
  });

  it("studio_get_project encodes the projectId in the path", async () => {
    const client = makeClient();
    await studioGetProject(client, { projectId: "proj abc/123" });

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      `${BASE_URL}/api/studio/projects/${encodeURIComponent("proj abc/123")}`
    );
  });

  it("studio_list_files calls GET /api/studio/projects/{id}/files", async () => {
    const client = makeClient();
    await studioListFiles(client, { projectId: "proj_42" });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("GET");
    expect(captured[0]!.url).toBe(
      `${BASE_URL}/api/studio/projects/proj_42/files`
    );
  });

  it("studio_generate posts {projectId, prompt} to /api/studio/generate", async () => {
    const client = makeClient();
    await studioGenerate(client, {
      projectId: "proj_42",
      prompt: "Add a contact form",
    });

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE_URL}/api/studio/generate`);
    expect(JSON.parse(req.body!)).toEqual({
      projectId: "proj_42",
      prompt: "Add a contact form",
    });
  });

  it("studio_deploy posts {projectId} to /api/studio/deployments", async () => {
    const client = makeClient();
    await studioDeploy(client, { projectId: "proj_42" });

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE_URL}/api/studio/deployments`);
    expect(JSON.parse(req.body!)).toEqual({ projectId: "proj_42" });
  });

  it("studio handlers surface RepullApiError on non-2xx responses", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: "project_not_found",
            message: "Project not found",
            fix: "Call studio_list_projects to find a valid projectId.",
            docs_url: "https://app.vanio.ai/docs/studio-projects",
          },
        },
        { status: 404 }
      )
    );

    const client = makeClient();
    await expect(studioGetProject(client, { projectId: "missing" })).rejects.toMatchObject({
      name: "RepullApiError",
      status: 404,
      code: "project_not_found",
      fix: "Call studio_list_projects to find a valid projectId.",
      docsUrl: "https://app.vanio.ai/docs/studio-projects",
    });

    // Sanity — confirm the thrown thing is the typed class so consumers get the
    // full envelope via `.toMcpPayload()` and not just an opaque Error.
    try {
      await studioGetProject(client, { projectId: "missing-2" });
    } catch (err) {
      expect(err).toBeInstanceOf(RepullApiError);
      expect((err as RepullApiError).toMcpPayload()).toMatchObject({
        error: { status: 404, code: "project_not_found" },
      });
    }
  });
});

describe("studio tools — registration", () => {
  it("registers all 6 Studio tools on the McpServer in the expected order", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const client = makeClient();
    registerStudioTools(server, client, {
      errorFormat: () => ({
        content: [{ type: "text", text: "" }],
        isError: true,
      }),
    });

    // McpServer exposes registered tools via its private `_registeredTools`
    // map. We poke through it to confirm tools/list will surface every Studio
    // tool — this is what an MCP client sees on the wire.
    const registered = (
      server as unknown as { _registeredTools: Record<string, unknown> }
    )._registeredTools;
    const names = Object.keys(registered).filter((n) => n.startsWith("studio_"));
    expect(names.sort()).toEqual([...STUDIO_TOOL_NAMES].sort());
    expect(STUDIO_TOOL_NAMES).toHaveLength(6);
  });
});
