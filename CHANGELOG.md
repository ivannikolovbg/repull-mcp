# Changelog

All notable changes to `@repull/mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

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
