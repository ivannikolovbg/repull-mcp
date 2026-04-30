# @repull/mcp

**A Model Context Protocol (MCP) server for the [Repull](https://repull.dev) API.** Lets Claude Desktop, Cursor, Continue, and any other MCP-compatible client read reservations, properties, and Airbnb listings across 50+ PMS platforms and the major OTAs (Airbnb, Booking.com, VRBO, Plumguide) through a single API key.

> Read-mostly by design. v1 exposes read endpoints plus the "start a Connect flow" entry point. Mutating endpoints (cancel, modify, message, push pricing, etc.) are intentionally **not** exposed — those will land in a follow-up release with explicit per-tool opt-in, because giving an LLM unconfirmed write access to live bookings is a footgun.

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

### 3. Optional environment variables

| Variable | Default | Purpose |
|---|---|---|
| `REPULL_API_KEY` | *(required)* | Your Repull API key. |
| `REPULL_API_BASE_URL` | `https://api.repull.dev` | Override for self-hosted / sandbox / local development. |

## Tools exposed

| Tool | Maps to | What it does |
|---|---|---|
| `repull_health_check` | `GET /v1/health` | Returns `{ status, version }` — useful as a connectivity sanity check. |
| `repull_list_reservations` | `GET /v1/reservations` | Paginated reservation list across every connected PMS, filterable by `status`, `platform`, and check-in date range. |
| `repull_get_reservation` | `GET /v1/reservations/{id}` | Fetch a single reservation by numeric ID. |
| `repull_list_properties` | `GET /v1/properties` | Paginated property list, filterable by PMS provider. |
| `repull_list_listings_airbnb` | `GET /v1/channels/airbnb/listings` | Airbnb listings for the connected workspace. |
| `repull_create_connect_session` | `POST /v1/connect/{provider}` | Starts a Connect flow. For Airbnb, returns a hosted `oauthUrl` to redirect the user to (with optional `accessType: read_only \| full_access`). For PMS providers, expects credentials in a follow-up step. |

### Why no write tools (yet)

The Repull API supports a full set of mutations — modify reservations, cancel, push pricing, send guest messages, manage webhooks, etc. We are deliberately holding those out of v1. An LLM that decides to "tidy up" a reservation calendar is not a good story. We will add mutating tools individually, each one gated behind an opt-in env flag (`REPULL_MCP_ENABLE_WRITES=reservations:cancel,messaging:send` style), once we have real-world feedback on what people actually want.

If your use case needs writes today, use the Repull SDK directly — see [repull.dev/docs](https://repull.dev/docs).

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

## Registry submission copy

This repo is published as `@repull/mcp` on npm and registered with the [official MCP Registry](https://registry.modelcontextprotocol.io) under the namespace `io.github.ivannikolovbg/repull-mcp`. Copy/paste suggestion for awesome-mcp-servers PRs:

> **[Repull](https://github.com/ivannikolovbg/repull-mcp)** — Read-mostly access to vacation-rental reservations, properties, and Airbnb listings via the [Repull](https://repull.dev) API. One API key fans out to 50+ PMS platforms and the major OTAs (Airbnb, Booking.com, VRBO, Plumguide).

## License

MIT — see [LICENSE](./LICENSE). The MCP server is a thin wrapper over the public REST API; the moat lives behind the API, not in the client.

## Links

- Sign up: [repull.dev](https://repull.dev)
- API docs / OpenAPI: [api.repull.dev/openapi.json](https://api.repull.dev/openapi.json)
- Issues: [github.com/ivannikolovbg/repull-mcp/issues](https://github.com/ivannikolovbg/repull-mcp/issues)
- MCP spec: [modelcontextprotocol.io](https://modelcontextprotocol.io)
