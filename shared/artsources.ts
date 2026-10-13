// Portable art lookups (Wikipedia infobox covers, Steam library art + screenshots), used by the
// build-time pipeline (with a disk cache) and the Worker (with the edge cache). Callers plug in
// how JSON is fetched via configureArtIO().

import { baseTitle, sim, yearHint } from "./match";

export interface Candidate {
  source: "libretro" | "wikipedia" | "steam" | "launchbox" | "override";
  url: string;
  label: string; // what we matched against (for review)
  score: number; // 0..1 confidence
  width?: number;
  height?: number;
  year?: number;
  ref?: string; // page title / app id / libretro name
}

let getJson: <T = any>(url: string) => Promise<T | null> = async (url) => {
  const r = await fetch(url, { headers: { "user-agent": "CoopersGameLibrary/0.1 (personal fan project)" } });
  return r.ok ? r.json() : null;
};
export function configureArtIO(io: { json: <T = any>(url: string) => Promise<T | null> }) {
  getJson = io.json;
}
const cachedJson = <T = any>(url: string) => getJson<T>(url);

// --- Wikipedia ----------------------------------------------------------------------

const WP = "https://en.wikipedia.org/w/api.php";
interface WpPage {
  title: string;
  description?: string;
  original?: { source: string; width: number; height: number };
  missing?: string;
}

async function wpQuery(params: Record<string, string>): Promise<WpPage[]> {
  const q = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    redirects: "1",
    prop: "pageimages|description",
    piprop: "original",
    pilicense: "any",
    ...params,
  });
  const res = await cachedJson<{ query?: { pages?: WpPage[] } }>(`${WP}?${q}`);
  return (res?.query?.pages ?? []).filter((p) => !p.missing);
}

const stripDisambig = (t: string) => t.replace(/\s*\([^)]*\)\s*$/, "");
const disambig = (t: string) => t.match(/\(([^)]*)\)\s*$/)?.[1] ?? "";

function scoreWp(p: WpPage, title: string, platformNames: string[], year?: number): Candidate | null {
  if (!p.original) return null;
  const desc = (p.description ?? "").toLowerCase();
  const dis = disambig(p.title).toLowerCase();
  // Must be about a game (not a character, series, magazine, film...)
  if (!/game/.test(desc) && !/game/.test(dis)) return null;
  if (/\b(series|franchise|character|list of|company|developer|publisher|film|novel|album|song|television|magazine|soundtrack|console|engine)\b/.test(desc)) return null;
  if (/^list of/i.test(p.title)) return null;
  const { width: w, height: h } = p.original;
  const aspect = w / h;
  if (aspect > 1.75 || aspect < 0.4) return null; // logos / banners
  let score = sim(baseTitle(title), stripDisambig(p.title));
  const dyear = +(desc.match(/\b(19[6-9]\d|20[0-4]\d)\b/)?.[1] ?? dis.match(/\b(19[6-9]\d|20[0-4]\d)\b/)?.[1] ?? 0) || undefined;
  if (year && dyear) score += Math.abs(dyear - year) <= 1 ? 0.06 : -0.12;
  if (platformNames.some((n) => dis.includes(n.toLowerCase()) || desc.includes(n.toLowerCase()))) score += 0.04;
  if (/\bseries\b/.test(desc)) score -= 0.2;
  return { source: "wikipedia", url: p.original.source.split("?")[0], label: `${p.title} — ${p.description ?? ""}`, score: Math.min(1, score), width: w, height: h, year: dyear, ref: p.title };
}

export async function wikipedia(title: string, platformNames: string[], year?: number): Promise<Candidate | null> {
  year = yearHint(title) ?? year;
  const base = baseTitle(title);
  const direct = [base, `${base} (video game)`];
  if (year) direct.push(`${base} (${year} video game)`);
  for (const n of platformNames.slice(0, 2)) direct.push(`${base} (${n} video game)`);
  let pages = await wpQuery({ titles: direct.join("|") });
  let best = pick(pages);
  if (!best || best.score < 0.9) {
    pages = await wpQuery({ generator: "search", gsrsearch: `${base} video game`, gsrlimit: "8" });
    const s = pick(pages);
    if (s && (!best || s.score > best.score)) best = s;
  }
  return best;

  function pick(ps: WpPage[]) {
    let b: Candidate | null = null;
    for (const p of ps) {
      const c = scoreWp(p, title, platformNames, year);
      if (c && (!b || c.score > b.score)) b = c;
    }
    return b;
  }
}

/** Look up a specific page (used by overrides). */
export async function wikipediaPage(pageTitle: string): Promise<Candidate | null> {
  const [p] = await wpQuery({ titles: pageTitle });
  if (!p?.original) return null;
  return { source: "wikipedia", url: p.original.source.split("?")[0], label: `${p.title} — ${p.description ?? ""}`, score: 1, width: p.original.width, height: p.original.height, ref: p.title };
}

// --- Steam ----------------------------------------------------------------------------

const STEAM_CDN = "https://shared.steamstatic.com/store_item_assets/steam/apps";

export async function steamSearch(title: string): Promise<{ appid: number; name: string; score: number } | null> {
  const base = baseTitle(title);
  const res = await cachedJson<{ items?: { id: number; name: string; type: string }[] }>(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(base)}&cc=us&l=en`,
  );
  let best: { appid: number; name: string; score: number } | null = null;
  for (const it of res?.items ?? []) {
    if (it.type !== "app") continue;
    let s = sim(base, it.name.replace(/[®™]/g, ""));
    const extra = /\b(demo|soundtrack|ost|dlc|season pass|playtest|artbook|vr|wallpapers?|bundle|pack|prologue)\b/i;
    if (extra.test(it.name) && !extra.test(base)) s -= 0.3;
    if (!best || s > best.score) best = { appid: it.id, name: it.name, score: s };
  }
  return best;
}

/**
 * Portrait library art for an app. Newer apps serve it from hashed paths, so ask the store
 * API for the real asset name. Auto-generated `portrait.png` placeholders and DLC (no library
 * art) return null.
 */
export async function steamCover(appid: number): Promise<string | null> {
  const input = { ids: [{ appid }], context: { language: "english", country_code: "US" }, data_request: { include_assets: true } };
  const res = await cachedJson<any>(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`);
  const item = res?.response?.store_items?.[0];
  const a = item?.assets;
  const file: string | undefined = a?.library_capsule_2x ?? a?.library_capsule;
  if (!a || !file || /portrait\.png/.test(file)) return null;
  const fmt: string = a.asset_url_format ?? `steam/apps/${appid}/\${FILENAME}`;
  return `https://shared.steamstatic.com/store_item_assets/${fmt.replace("${FILENAME}", file).split("?")[0]}`;
}

export async function steamDetails(appid: number): Promise<{ screenshots: string[]; year?: number; movie?: string } | null> {
  const res = await cachedJson<Record<string, { success: boolean; data?: any }>>(
    `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en&filters=basic,screenshots,movies,release_date`,
  );
  const d = res?.[appid]?.data;
  if (!d) return null;
  const screenshots: string[] = (d.screenshots ?? []).slice(0, 4).map((s: any) => String(s.path_thumbnail).split("?")[0]);
  const year = +(String(d.release_date?.date ?? "").match(/\d{4}/)?.[0] ?? 0) || undefined;
  return { screenshots, year, movie: d.movies?.[0]?.hls_h264 };
}

