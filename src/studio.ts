/**
 * Studio tools for @repull/mcp.
 *
 * Exposes Repull Studio (no-code project / deploy / generate) over MCP so
 * Claude Code, Cursor, Continue and other clients can drive Studio workflows.
 *
 * All Studio tools talk to the dominator API at `REPULL_API_URL` (the same
 * base used by the rest of the MCP server). Authentication uses the standard
 * `REPULL_API_KEY` header — these tools rely on the shared `RepullClient`
 * created in `index.ts`.
 *
 * Tools:
 *   - studio_list_projects
 *   - studio_create_project
 *   - studio_get_project
 *   - studio_list_files
 *   - studio_generate
 *   - studio_deploy
 *
 * Each tool calls a single Studio REST endpoint and returns the raw response
 * envelope unchanged so an agent can decide what to do with it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RepullClient } from "./client.js";

// ---------------------------------------------------------------------------
// Schemas — exported so tests can reuse them and so we can hand-build
// MCP tools/list smoke tests without touching the live transport.
// ---------------------------------------------------------------------------

export const studioListProjectsSchema = {
  q: z
    .string()
    .optional()
    .describe(
      "Free-text search across project name, description, and prompt history. Case-insensitive substring match."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Page size (1-100). API defaults to 20."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Offset for pagination — defaults to 0."),
};

export const studioCreateProjectSchema = {
  name: z
    .string()
    .min(1)
    .describe("Display name for the project. Required."),
  prompt: z
    .string()
    .optional()
    .describe(
      "Optional initial prompt. When supplied, Repull AI seeds the project with a first generation pass."
    ),
};

export const studioGetProjectSchema = {
  projectId: z
    .string()
    .min(1)
    .describe("Studio project ID — returned by studio_list_projects or studio_create_project."),
};

export const studioListFilesSchema = {
  projectId: z
    .string()
    .min(1)
    .describe("Studio project ID — returned by studio_list_projects or studio_create_project."),
};

export const studioGenerateSchema = {
  projectId: z
    .string()
    .min(1)
    .describe("Studio project ID to generate code into."),
  prompt: z
    .string()
    .min(1)
    .describe(
      "Natural-language instruction for Repull AI. Describe the change you want; the generator will modify project files in-place."
    ),
};

export const studioDeploySchema = {
  projectId: z
    .string()
    .min(1)
    .describe("Studio project ID to deploy."),
};

// ---------------------------------------------------------------------------
// Handlers — pure functions that take a RepullClient + args and call the
// dominator Studio API. Returned values are passed through to the MCP tool
// response unchanged so agents see the full API envelope.
// ---------------------------------------------------------------------------

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export interface StudioListProjectsArgs {
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}
export async function studioListProjects(
  client: RepullClient,
  args: StudioListProjectsArgs
): Promise<unknown> {
  return client.get("/api/studio/projects", {
    query: compact(args as unknown as Record<string, unknown>),
  });
}

export interface StudioCreateProjectArgs {
  name: string;
  prompt?: string | undefined;
}
export async function studioCreateProject(
  client: RepullClient,
  args: StudioCreateProjectArgs
): Promise<unknown> {
  return client.post("/api/studio/projects", {
    body: compact(args as unknown as Record<string, unknown>),
  });
}

export interface StudioGetProjectArgs {
  projectId: string;
}
export async function studioGetProject(
  client: RepullClient,
  args: StudioGetProjectArgs
): Promise<unknown> {
  return client.get(`/api/studio/projects/${encodeURIComponent(args.projectId)}`);
}

export interface StudioListFilesArgs {
  projectId: string;
}
export async function studioListFiles(
  client: RepullClient,
  args: StudioListFilesArgs
): Promise<unknown> {
  return client.get(`/api/studio/projects/${encodeURIComponent(args.projectId)}/files`);
}

export interface StudioGenerateArgs {
  projectId: string;
  prompt: string;
}
export async function studioGenerate(
  client: RepullClient,
  args: StudioGenerateArgs
): Promise<unknown> {
  return client.post("/api/studio/generate", {
    body: { projectId: args.projectId, prompt: args.prompt },
  });
}

export interface StudioDeployArgs {
  projectId: string;
}
export async function studioDeploy(
  client: RepullClient,
  args: StudioDeployArgs
): Promise<unknown> {
  return client.post("/api/studio/deployments", {
    body: { projectId: args.projectId },
  });
}

// ---------------------------------------------------------------------------
// MCP wiring — exported for use from index.ts. Tests don't need this; they
// call the handler functions directly with a fake RepullClient.
// ---------------------------------------------------------------------------

type ToolResponse = { content: { type: "text"; text: string }[]; isError?: true };

function jsonText(value: unknown): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

/** Wrap a handler so thrown errors come back as MCP error envelopes. */
async function safe<T>(
  fn: () => Promise<T>,
  errorFormat: (err: unknown) => ToolResponse
): Promise<ToolResponse> {
  try {
    const data = await fn();
    return jsonText(data);
  } catch (err) {
    return errorFormat(err);
  }
}

export interface RegisterStudioToolsOpts {
  errorFormat: (err: unknown) => ToolResponse;
}

/**
 * Registers all 6 Studio tools on the MCP server. Tools are organized in a
 * single function so the call-site in `index.ts` stays a single line.
 */
export function registerStudioTools(
  server: McpServer,
  client: RepullClient,
  opts: RegisterStudioToolsOpts
): void {
  const { errorFormat } = opts;

  server.registerTool(
    "studio_list_projects",
    {
      title: "List Repull Studio projects",
      description:
        "List Studio projects on the workspace tied to the current API key. Supports optional " +
        "free-text search (`q`) and offset pagination. Use this when the user asks 'what Studio " +
        "projects do I have?' or wants to find a project to work on. Returns the raw API response " +
        "(typically `{ data: Project[], pagination: { total, limit, offset } }`).",
      inputSchema: studioListProjectsSchema,
    },
    async (args) =>
      safe(() => studioListProjects(client, args as StudioListProjectsArgs), errorFormat)
  );

  server.registerTool(
    "studio_create_project",
    {
      title: "Create a Studio project",
      description:
        "Create a new Studio project. `name` is required and must be unique within the workspace. " +
        "If `prompt` is supplied, Repull AI seeds the project by running an initial code generation " +
        "pass — otherwise the project starts empty and you can drive it via studio_generate. Returns " +
        "the created project record (including its `id` for use in other Studio tools).",
      inputSchema: studioCreateProjectSchema,
    },
    async (args) =>
      safe(() => studioCreateProject(client, args as StudioCreateProjectArgs), errorFormat)
  );

  server.registerTool(
    "studio_get_project",
    {
      title: "Get a Studio project",
      description:
        "Fetch a single Studio project by ID. Returns name, description, status, current deployment " +
        "info, last generation summary, and project metadata. Use this after studio_list_projects to " +
        "drill into a specific project before generating or deploying.",
      inputSchema: studioGetProjectSchema,
    },
    async (args) =>
      safe(() => studioGetProject(client, args as StudioGetProjectArgs), errorFormat)
  );

  server.registerTool(
    "studio_list_files",
    {
      title: "List files in a Studio project",
      description:
        "List every file in a Studio project, including paths, sizes, and last-modified timestamps. " +
        "Use this to understand the current shape of a project before asking Repull AI to modify it " +
        "via studio_generate.",
      inputSchema: studioListFilesSchema,
    },
    async (args) =>
      safe(() => studioListFiles(client, args as StudioListFilesArgs), errorFormat)
  );

  server.registerTool(
    "studio_generate",
    {
      title: "Generate code in a Studio project",
      description:
        "Run a code-generation pass on a Studio project. Repull AI reads the existing project files, " +
        "applies the change described in `prompt`, and writes the result back to the project. The " +
        "request is synchronous from the API's perspective — the response includes the changed files " +
        "and any reasoning the generator surfaced. Use studio_list_files afterwards to see the new state.",
      inputSchema: studioGenerateSchema,
    },
    async (args) =>
      safe(() => studioGenerate(client, args as StudioGenerateArgs), errorFormat)
  );

  server.registerTool(
    "studio_deploy",
    {
      title: "Deploy a Studio project",
      description:
        "Deploy the current state of a Studio project. Returns a deployment record with `id`, " +
        "`status`, and (once provisioning settles) a public URL. Deployments run async on the " +
        "Repull deploy fleet — poll studio_get_project to see the deployment progress.",
      inputSchema: studioDeploySchema,
    },
    async (args) =>
      safe(() => studioDeploy(client, args as StudioDeployArgs), errorFormat)
  );
}

/** Names of every Studio tool, in registration order. Used by tests. */
export const STUDIO_TOOL_NAMES = [
  "studio_list_projects",
  "studio_create_project",
  "studio_get_project",
  "studio_list_files",
  "studio_generate",
  "studio_deploy",
] as const;
