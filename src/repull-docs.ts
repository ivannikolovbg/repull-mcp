/**
 * Repull docs for agents, read from repull.dev's own machine-readable docs:
 * `llms.txt` (index of doc pages) and `llms-full.txt` (the full text).
 *
 * A doc's slug is its path under https://repull.dev/docs/ (e.g. `errors`,
 * `channels/vrbo`). Listing returns every linked doc page; reading a slug
 * returns the sections of the full text that cover it, plus the page URL.
 */

export const REPULL_DOCS_BASE = "https://repull.dev";
export const LLMS_INDEX_URL = `${REPULL_DOCS_BASE}/llms.txt`;
export const LLMS_FULL_URL = `${REPULL_DOCS_BASE}/llms-full.txt`;
export const DOCS_HOME = `${REPULL_DOCS_BASE}/docs`;

export interface RepullDocEntry {
  slug: string;
  title: string;
  url: string;
  /** The text after the link on its index line, when there is one. */
  excerpt: string;
  /** First path segment of the slug (`channels`, `pms`, …); `general` for top-level pages. */
  category: string;
}

const LINK = /\[([^\]]+)\]\((https:\/\/repull\.dev\/docs\/([^)#?\s]+))[^)]*\)/g;

/** Every distinct doc page linked from the given markdown, in first-seen order. */
export function parseDocIndex(...markdowns: string[]): RepullDocEntry[] {
  const seen = new Map<string, RepullDocEntry>();
  for (const md of markdowns) {
    for (const line of md.split("\n")) {
      for (const m of line.matchAll(LINK)) {
        const [whole, rawTitle, url, rawSlug] = m;
        if (!whole || !rawTitle || !url || !rawSlug) continue;
        const slug = rawSlug.replace(/\/+$/, "");
        if (seen.has(slug)) continue;
        const after = line.slice((m.index ?? 0) + whole.length).replace(/^[\s:·—-]+/, "").trim();
        seen.set(slug, {
          slug,
          title: rawTitle.trim(),
          url,
          excerpt: after.slice(0, 300),
          category: slug.includes("/") ? (slug.split("/")[0] ?? "general") : "general",
        });
      }
    }
  }
  return [...seen.values()];
}

export function filterDocs(docs: RepullDocEntry[], opts: { category?: string; search?: string }): RepullDocEntry[] {
  const cat = opts.category?.trim().toLowerCase();
  const q = opts.search?.trim().toLowerCase();
  return docs.filter((d) =>
    (!cat || d.category === cat) &&
    (!q || `${d.slug} ${d.title} ${d.excerpt}`.toLowerCase().includes(q)),
  );
}

/** Split markdown into `##`-level sections (the preamble before the first one is dropped). */
function sections(md: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of md.split("\n")) {
    if (/^##\s/.test(line)) {
      if (cur) out.push(cur.join("\n").trim());
      cur = [line];
    } else if (cur) cur.push(line);
  }
  if (cur) out.push(cur.join("\n").trim());
  return out;
}

/**
 * The sections of the full text that link to this doc page; failing that, the
 * section whose heading names it (some pages are linked only from the index).
 */
export function sectionsForSlug(fullText: string, slug: string, title?: string): string[] {
  const url = `${DOCS_HOME}/${slug}`;
  const all = sections(fullText);
  const linked = all.filter((s) => s.includes(`${url})`) || s.includes(`${url} `) || s.includes(`${url}\n`) || s.endsWith(url));
  if (linked.length) return linked.slice(0, 4);
  const words = [title, slug.split("/").pop()?.replace(/-/g, " ")].filter((w): w is string => !!w).map((w) => w.toLowerCase());
  const named = all.filter((s) => {
    const heading = (s.split("\n")[0] ?? "").toLowerCase();
    return words.some((w) => heading.includes(w));
  });
  return named.slice(0, 2);
}
