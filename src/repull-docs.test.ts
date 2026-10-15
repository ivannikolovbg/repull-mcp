import { describe, it, expect } from "vitest";
import { filterDocs, parseDocIndex, sectionsForSlug } from "./repull-docs.js";

const index = `# Repull
- [Errors](https://repull.dev/docs/errors) and [Rate Limits](https://repull.dev/docs/rate-limits): tier-based limits.
- [Vrbo guide](https://repull.dev/docs/channels/vrbo): the host signs in with their Vrbo account.
- [Errors again](https://repull.dev/docs/errors)`;

const full = `# Full
intro
## 8. Channel manager — Vrbo (beta)
See https://repull.dev/docs/channels/vrbo for the flow.
## 14. Errors and idempotency
Every error has a code.`;

describe("repull docs", () => {
  it("lists each linked doc page once, with its section", () => {
    const docs = parseDocIndex(index, full);
    expect(docs.map((d) => d.slug)).toEqual(["errors", "rate-limits", "channels/vrbo"]);
    expect(docs[2]).toMatchObject({ title: "Vrbo guide", category: "channels", url: "https://repull.dev/docs/channels/vrbo" });
    expect(docs[0]?.category).toBe("general");
  });

  it("filters by section and by search text", () => {
    const docs = parseDocIndex(index);
    expect(filterDocs(docs, { category: "channels" }).map((d) => d.slug)).toEqual(["channels/vrbo"]);
    expect(filterDocs(docs, { search: "tier" }).map((d) => d.slug)).toEqual(["errors", "rate-limits"]);
  });

  it("returns the sections that link a page, else the section whose heading names it", () => {
    expect(sectionsForSlug(full, "channels/vrbo")[0]).toMatch(/^## 8\. Channel manager — Vrbo/);
    expect(sectionsForSlug(full, "errors", "Errors")[0]).toMatch(/^## 14\. Errors/);
    expect(sectionsForSlug(full, "nothing-like-this", "Nothing")).toEqual([]);
  });
});
