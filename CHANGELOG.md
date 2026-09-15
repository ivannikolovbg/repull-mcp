# Changelog

All notable changes to `@repull/mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [0.2.4] - 2026-09-15

### Changed

- Refreshed `openapi/v1.json` against the live API (174 → 175 operations):
  new `POST /v1/listings/status` (bulk activate/deactivate); `DELETE
  /v1/connect/{provider}` gains an optional `accountId` query param and a
  typed `{ disconnected, provider, accountId, listingsDeactivated }` response;
  `GET /v1/connect/{provider}` declares `accounts[]`; a new `403
  listing_inactive` error response on 83 operations; Airbnb calendar writes
  gain `busy_subtype`, stricter validation and new errors (`422
  airbnb_rejected`, `403 connection_reauth_required`, `429
  airbnb_rate_limited`); Booking.com webhooks endpoints are deprecated (always
  `403`).
- `repull_list_listings` and `repull_list_properties` gain a `status` filter
  (`active|inactive|archived|all` and `active|inactive|all`). The API now
  returns active rows only by default, so without it an agent could not see
  inactive listings at all. Descriptions explain that inactive listings keep
  syncing but return `403 listing_inactive` until activated.
- `repull_create_connect_session`: `accessType` accepts `messaging`, and its
  description now says passing it locks the host's consent screen to that
  tier — omit it to let the host choose. The old text called `full_access`
  the default, which nudged agents into always sending it.

### Notes

- No tool was added for `POST /v1/listings/status` or account disconnect:
  both change billing/connection state, and a new write scope would be
  auto-enabled for existing `REPULL_MCP_ENABLE_WRITES=*` installs.
- New `src/list-status-filters.test.ts` pins those tool enums to the enums in
  the bundled spec snapshot.

## [0.2.3] - 2026-09-11

### Added

- Four opt-in write tools, gated behind the new `REPULL_MCP_ENABLE_WRITES`
  environment variable (comma-separated `domain:action` scopes, forgiving of
  whitespace/case, `*`/`all` for every scope):
  - `repull_create_reservation` (`reservations:create`) — `POST /v1/reservations`.
  - `repull_update_reservation` (`reservations:update`) — `PATCH /v1/reservations/{id}`.
  - `repull_create_guest` (`guests:create`) — `POST /v1/guests`.
  - `repull_send_conversation_message` (`messaging:send`) — `POST /v1/conversations/{id}/messages`.
  None of these register — or appear in `tools/list` — unless their scope is
  explicitly enabled; the default install stays 100% read-only (24 tools).
  With every scope enabled the server registers 28 tools. Unrecognised scopes
  are rejected with a stderr warning naming the bad scope and the valid list,
  and enable nothing. The server logs which write scopes (if any) are active
  at startup.

### Fixed

- Refreshed `openapi/v1.json` against the live API. 19 schema corrections
  landed upstream since the last snapshot: 10 fields renamed snake_case →
  camelCase (`data_freshness` → `dataFreshness`, `last_synced_at` →
  `lastSyncedAt`, `fix_url` → `fixUrl`, `next_cursor` → `nextCursor`,
  `has_more` → `hasMore`, `monthly_requests` → `monthlyRequests`,
  `daily_ai_requests` → `dailyAiRequests`, `daily_ai` → `dailyAi`,
  `dynamic_pricing_listings` → `dynamicPricingListings`, `resets_at` →
  `resetsAt`); `BookingPropertyListResponse`, `BookingConversationListResponse`,
  and `VrboListingListResponse` changed from `{ data, pagination }` objects to
  bare arrays; 4 id fields and `Property.latitude`/`Property.longitude`
  changed integer/number → string. Path/operation inventory is unchanged
  (124 paths / 174 operations). Updated the hand-written pagination doc
  strings in `src/index.ts` (`next_cursor`/`has_more` → `nextCursor`/`hasMore`)
  to match.

## [0.2.2] - 2026-09-11

### Fixed

- `repull_whoami` called `GET /v1/billing`, which unconditionally returns a
  `501 not_implemented` on the live API — every call surfaced a `billing_error`
  instead of real plan data. Repointed the sub-call to `GET /v1/usage/tier`
  (confirmed live: 200, `{ tier, limits, used, remaining, resetsAt }`) and
  renamed the result field from `billing`/`billing_error` to `plan`/`plan_error`
  to match the actual shape. The tool's description no longer references
  `GET /v1/billing`.

### Changed

- All `/v1/...` REST paths used by tool handlers are now resolved through a
  spec-derived map (`src/openapi-paths.ts`) instead of hardcoded string
  literals scattered across `src/index.ts`. The map is checked against a
  committed snapshot of the live OpenAPI spec (`openapi/v1.json`) both at
  server startup and in a dedicated test — a path removed or renamed on the
  live API now fails loudly instead of the affected tool silently 404ing at
  runtime.

## [0.2.1] - 2026-05-04

### Added

- 6 new Studio tools for driving Repull Studio from MCP clients:
  - `studio_list_projects` — list Studio projects, with optional search and
    offset pagination.
  - `studio_create_project` — create a new project, optionally seeded with
    a Repull AI generation prompt.
  - `studio_get_project` — fetch a single project.
  - `studio_list_files` — list every file in a project.
  - `studio_generate` — run a code-generation pass against an existing
    project using Repull AI.
  - `studio_deploy` — kick off a deploy of the current project state to
    the Repull deploy fleet.
- `REPULL_API_URL` environment variable as the canonical name for the API
  base URL. `REPULL_API_BASE_URL` continues to work for backwards
  compatibility.

## [0.2.0] - 2026-05-02

- Initial public release. 18 tools covering discovery, introspection,
  reads, and Connect session creation.
