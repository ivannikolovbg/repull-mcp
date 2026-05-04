# Changelog

All notable changes to `@repull/mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

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
