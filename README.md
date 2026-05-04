# @repull/mcp

**A Model Context Protocol (MCP) server for the [Repull](https://repull.dev) API.** Lets Claude Desktop, Cursor, Cline, Continue, and any other MCP-compatible client read reservations, properties, listings, guests, and conversations across 50+ PMS platforms and the major OTAs (Airbnb, Booking.com, VRBO, Plumguide) — through one API key.

> Read-mostly by design. v0.2 exposes read endpoints plus the "start a Connect flow" entry points. Mutating endpoints (cancel, modify, message, push pricing, etc.) are intentionally **not** exposed yet — those will land in a follow-up release with explicit per-tool opt-in, because giving an LLM unconfirmed write access to live bookings is a footgun.

## Why this server is built for agents

The whole point of an MCP server is that the agent on the other side can self-serve. This one is built around that:

- **Discovery built in.** `repull_list_endpoints` summarizes every endpoint in the OpenAPI spec; `repull_get_docs` reads the same docs pages humans see. The agent never has to leave the conversation to figure out what's possible.
- **Introspection built in.** `repull_whoami` returns the workspace, plan, and connected channels in one call. Agents use this to avoid suggesting actions that will fail (e.g. "this account doesn't have Booking.com connected").
- **Errors carry the full envelope.** When the API returns `{ error: { code, message, fix, docs_url, field } }`, every tool surfaces all of those fields verbatim. Agents read `fix` and `docs_url` and self-correct instead of bouncing back to the human.
- **Cursor pagination is explicit.** List tools accept `cursor` and the schema describes how to paginate. We don't auto-paginate, because LLMs do better when they decide when to fetch the next page (cost / context window).
- **Idempotency keys on writes.** The Connect tools accept an `idempotency_key` parameter that maps to the `Idempotency-Key` header — safe to retry without duplicating sessions.

## Setup

### 1. Get a Repull API key

Sign up at [repull.dev/dashboard](https://repull.dev/dashboard) and grab a key. Keys look like `sk_test_...` (sandbox) or `sk_live_...` (production). The MCP server respects whichever you pass.

### 2. Add to your MCP client

#### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`) and add:

```json
{
  "mcpServers": {
    "repull": {
      "command": "npx",
      "args": ["-y", "@repull/mcp"],
      "env": {
        "REPULL_API_KEY": "sk_test_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. The Repull tools will appear in the tool picker.

#### Cursor

Edit `~/.cursor/mcp.json` (or your project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "repull": {
      "command": "npx",
      "args": ["-y", "@repull/mcp"],
      "env": {
        "REPULL_API_KEY": "sk_test_your_key_here"
      }
    }
  }
}
```

#### Cline (VS Code)

In Cline's MCP settings (Command Palette → "Cline: Open MCP Settings"), add:

```json
{
  "mcpServers": {
    "repull": {
      "command": "npx",
      "args": ["-y", "@repull/mcp"],
      "env": {
        "REPULL_API_KEY": "sk_test_your_key_here"
      }
    }
  }
}
```

#### Continue

In your `~/.continue/config.json`, add the server under `experimental.modelContextProtocolServers`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@repull/mcp"],
          "env": {
            "REPULL_API_KEY": "sk_test_your_key_here"
          }
        }
      }
    ]
  }
}
```

#### Any other stdio MCP client

The server reads `REPULL_API_KEY` from the environment and speaks MCP over stdio. Spawn it with `npx -y @repull/mcp` (or `node /path/to/dist/index.js` if you've cloned the repo).

#### Plugin hosts (Open Plugin Spec)

This repo ships a root [`.mcp.json`](./.mcp.json) conforming to the [Open Plugin Specification](https://github.com/vercel-labs/open-plugin-spec) — the same `mcpServers` shape Cursor, Cline, and Continue already understand. Plugin hosts that auto-discover MCP servers from `.mcp.json` will pick this server up automatically; users only need to set `REPULL_API_KEY` in their environment (or via the host's secret-injection mechanism).

### 3. Optional environment variables

| Variable | Default | Purpose |
|---|---|---|
| `REPULL_API_KEY` | *(required)* | Your Repull API key. |
| `REPULL_API_BASE_URL` | `https://api.repull.dev` | Override for self-hosted / sandbox / local development. |

## Tools exposed

### Discovery

| Tool | Maps to | What it does |
|---|---|---|
| `repull_list_endpoints` | `GET https://api.repull.dev/openapi.json` | Concise summary of every Repull REST endpoint (method, path, tag, summary), filterable by tag or free-text. Use first when the user asks "what can Repull do?". |
| `repull_get_docs` | `GET /api/docs[/{slug}]` | Fetch a single docs page by slug, or list available docs. Use for "how do I X?" questions or when an error includes a `docs_url`. |

### Introspection

| Tool | Maps to | What it does |
|---|---|---|
| `repull_whoami` | `GET /v1/billing` + `GET /v1/connect` | Workspace snapshot — plan, usage, and connected channels — in a single call. **Always call this first** when starting a session. |
| `repull_health_check` | `GET /v1/health` | Connectivity sanity check. |

### Reads

| Tool | Maps to | What it does |
|---|---|---|
| `repull_list_reservations` | `GET /v1/reservations` | Cursor-paginated reservation list. Filters: `status`, `platform`, `listing_id`, `check_in_after`, `check_in_before`. |
| `repull_get_reservation` | `GET /v1/reservations/{id}` | Full reservation detail (guest, dates, pricing, payment, platform fields). |
| `repull_list_properties` | `GET /v1/properties` | Cursor-paginated list of underlying PMS properties; filterable by `provider`. |
| `repull_get_property` | `GET /v1/properties/{id}` | Full property detail (address, amenities, photos, capacity). |
| `repull_list_listings` | `GET /v1/listings` | Cursor-paginated list of native Repull listings (the canonical objects you publish to channels). |
| `repull_list_airbnb_listings` | `GET /v1/channels/airbnb/listings` | Airbnb's view of listings on the connected Airbnb account. |
| `repull_list_guests` | `GET /v1/guests` | Cursor-paginated list of guest profiles. |
| `repull_get_guest` | `GET /v1/guests/{id}` | Single guest profile (contacts, flags, history). |
| `repull_list_conversations` | `GET /v1/conversations` | Cursor-paginated list of guest message threads across every channel. |
| `repull_list_conversation_messages` | `GET /v1/conversations/{id}/messages` | Messages inside a single thread (oldest-first, cursor-paginated). |

### Connect (the only writes in v0.2)

| Tool | Maps to | What it does |
|---|---|---|
| `repull_list_connections` | `GET /v1/connect` | Active PMS/OTA connections with status. |
| `repull_list_connect_providers` | `GET /v1/connect/providers` | Registry of every channel the user *can* connect — display name, features, required credentials. |
| `repull_create_connect_session` | `POST /v1/connect/{provider}` | Start a Connect flow for one provider. Airbnb returns a hosted `oauthUrl`. PMS providers accept API-key credentials in the body. Accepts `idempotency_key`. |
| `repull_create_connect_picker_session` | `POST /v1/connect` | Start a multi-channel picker session. Returns a hosted URL with a UI listing every connectable channel. Accepts `idempotency_key`. |

**Total: 18 tools.**

## Sample agent prompts that work well

These are the kinds of asks this server is tuned for:

1. **"What's connected to my Repull account, and what can I do?"** → agent calls `repull_whoami` then `repull_list_endpoints`, narrates back the plan + channels + capability list.
2. **"Show me upcoming reservations for listing 4118 on Airbnb."** → agent calls `repull_list_reservations` with `listing_id=4118&platform=airbnb&check_in_after=<today>` and pages through with `cursor` until the user stops asking for more.
3. **"Connect this account to Hostaway — here's the API key: hk_..."** → agent calls `repull_list_connect_providers` to confirm Hostaway is supported, then `repull_create_connect_session` with `provider=hostaway`, `apiKey=hk_...`, and a fresh `idempotency_key`.
4. **"Find the most recent guest message thread for reservation 216039."** → agent calls `repull_get_reservation`, pulls the guest ID, then `repull_list_conversations` and `repull_list_conversation_messages` to read the thread.
5. **"What does the error `invalid_param` mean and how do I fix it?"** → agent calls `repull_get_docs` with `slug=errors/invalid-param` (or `search=invalid_param`) and quotes the doc back to the user.

## What to do when you get error X

Every tool returns the API's full error envelope verbatim — `code`, `message`, `fix`, `docs_url`, `field`, and `request_id`. Read them. They tell the agent exactly what to do. Common ones:

| `error.code` | HTTP | What it means | What the agent should do |
|---|---|---|---|
| `unauthorized` | 401 | Missing or invalid `REPULL_API_KEY`. | Tell the user to recheck the key in their MCP client config. Do **not** retry. |
| `forbidden` | 403 | Key is valid but doesn't have access to this endpoint or resource. | Run `repull_whoami` and report the plan + entitlements. Surface the `fix` field if present. |
| `not_found` | 404 | The ID doesn't exist on this workspace. | Don't guess another ID — ask the user to confirm the ID, or call the list tool to find candidates. |
| `invalid_param` | 422 | A parameter value is wrong (`field` tells you which one). | Re-read the tool schema, fix the parameter, retry. The `example` field often contains a correct value. |
| `rate_limited` | 429 | Too many requests in a short window. | Back off and retry in 30s+. Don't loop. |
| `provider_unavailable` | 503 | A downstream PMS/OTA is down (e.g. Airbnb). | Tell the user the channel is having issues — don't retry immediately. Try `repull_health_check` to see if it's transient. |
| `doc_not_found` | 404 | A `repull_get_docs(slug=...)` call missed. | Call `repull_get_docs` without a slug to list available docs and find the right one. |

For anything unexpected, the `request_id` field is what support will ask for. Email **hello@repull.dev** with the `request_id` and a one-line description — but try the `docs_url` first; nine times out of ten it has the answer.

### Why no write tools (yet)

The Repull API supports a full set of mutations — modify reservations, cancel, push pricing, send guest messages, manage webhooks, etc. We are deliberately holding those out of v0.2. An LLM that decides to "tidy up" a reservation calendar is not a good story. We will add mutating tools individually, each one gated behind an opt-in env flag (`REPULL_MCP_ENABLE_WRITES=reservations:cancel,messaging:send` style), once we have real-world feedback on what people actually want.

If your use case needs writes today, use the [Repull SDK](https://repull.dev/docs) directly — it covers every endpoint.

## Local development

```bash
git clone https://github.com/ivannikolovbg/repull-mcp.git
cd repull-mcp
npm install
npm run build
REPULL_API_KEY=sk_test_... node dist/index.js
```

The server logs to **stderr** (stdout is reserved for the MCP JSON-RPC channel — never write to it from a server). To inspect what an MCP client sees, run the server under [`@modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

A JSON-RPC smoke test that lists every tool:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | REPULL_API_KEY=sk_test_anything node dist/index.js
```

## Registry submission copy

This repo is published as `@repull/mcp` on npm and registered with the [official MCP Registry](https://registry.modelcontextprotocol.io) under the namespace `io.github.ivannikolovbg/repull-mcp`. Copy/paste suggestion for awesome-mcp-servers PRs:

> **[Repull](https://github.com/ivannikolovbg/repull-mcp)** — Agent-friendly read access to vacation-rental reservations, properties, listings, guests, and conversations via the [Repull](https://repull.dev) API. One API key fans out to 50+ PMS platforms and the major OTAs (Airbnb, Booking.com, VRBO, Plumguide). Includes built-in OpenAPI + docs discovery, `whoami` introspection, cursor pagination, idempotency keys, and verbatim error envelopes.

## License

MIT — see [LICENSE](./LICENSE). The MCP server is a thin wrapper over the public REST API; the moat lives behind the API, not in the client.

## Links

- Sign up: [repull.dev](https://repull.dev)
- Docs: [repull.dev/docs](https://repull.dev/docs)
- API / OpenAPI: [api.repull.dev/openapi.json](https://api.repull.dev/openapi.json)
- Issues: [github.com/ivannikolovbg/repull-mcp/issues](https://github.com/ivannikolovbg/repull-mcp/issues)
- MCP spec: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- Support: [hello@repull.dev](mailto:hello@repull.dev) (please try the docs first!)
