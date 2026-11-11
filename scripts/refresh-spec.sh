#!/usr/bin/env bash
# Pull the live OpenAPI spec into the committed snapshot (openapi/v1.json).
#
# The snapshot is what src/openapi-paths.ts resolves tool paths against and what
# scripts/check-spec-freshness.py compares to the live API. Run this, then
# `npm test` (asserts every TOOL_PATHS entry still exists in the spec), then
# commit openapi/v1.json. The spec-refresh workflow does exactly this hourly.
#
# curl, not node fetch: api.repull.dev sits behind Cloudflare, which blocks
# non-curl TLS fingerprints (see check-spec-freshness.py).
set -euo pipefail

URL="${REPULL_OPENAPI_URL:-https://api.repull.dev/openapi.json}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/openapi/v1.json"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl --silent --show-error --fail --location --retry 3 --max-time 60 \
  --header "Accept: application/json" "$URL" -o "$TMP"

# Refuse to overwrite the snapshot with anything that is not an OpenAPI doc
# (an error page, an empty body, a truncated download).
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!s.openapi || !s.paths || Object.keys(s.paths).length < 50) {
    console.error("refresh-spec: response is not a plausible OpenAPI spec");
    process.exit(1);
  }
' "$TMP"

mv "$TMP" "$OUT"
trap - EXIT
echo "refresh-spec: wrote $OUT ($(node -e 'console.log(Object.keys(require(process.argv[1]).paths).length)' "$OUT") paths)"
