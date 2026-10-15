#!/usr/bin/env bun
// THE BACKLOG — Vault pricing pipeline.
//
// Estimates the market value of every physical game Cooper owns (read from his published Google
// Sheet) using PriceCharting (pricecharting.com) game pages, and stores it as a dated snapshot in
// Cloudflare KV for the password-protected Vault room:
//   vault:snap:<YYYY-MM-DD>  the snapshot (items with all six price points, unpriced, excluded)
//   vault:index              [{ date, generatedAt, source, totals: {loose,cib,new,asOwned}, priced, unpriced }]
//
// MONTHLY UPDATE (from the repo root; ~25-35 min, almost all of it the polite 2-3.5 s request gap):
//   bun scripts/vault/price.ts --refresh --dry-run    # refetch every game page older than 20 h, print totals
//   less .cache/vault/review.txt                       # spot-check the top items + the random sample
//   bun scripts/vault/price.ts --upload=both           # (no network: pages are cached) write remote + local KV
// A crash or Ctrl-C mid-run is fine: every page is cached as soon as it's fetched, so re-running the
// same command continues where it stopped (--refresh only refetches pages older than 20 h).
//
// FLAGS
//   --refresh[=hours]   refetch game pages older than `hours` (default 20) -> new prices for a new snapshot;
//                       games that didn't match are searched again too (PriceCharting adds new releases)
//   --dry-run           build + print the snapshot, write .cache/vault/preview.json, upload nothing
//   --only=<id>[,<id>]  resolve just these games (e.g. to test an override) and print them; writes nothing
//   --upload=local|remote|both
//                       local:  `wrangler kv key put --local --binding STORE` (the dev server's KV)
//                       remote: Cloudflare API with .env.cloudflare-deploy (CLOUDFLARE_ACCOUNT_ID/API_TOKEN)
//   --allow-stale       upload even if cached prices span more than 7 days (normally: run --refresh first)
//
// FIXING MATCHES: scripts/vault/overrides.json maps a game id (as printed in review.txt / unpriced) to
// the exact PriceCharting game URL, or to null to skip the game. Keys starting with "_" are comments.
//
// POLITENESS: one request at a time, >= 2 s apart (+ up to 1.5 s jitter), descriptive User-Agent, every
// response cached in .cache/vault/pages/, exponential back-off on 429/5xx. A 403 or a challenge page
// stops the run immediately: if PriceCharting blocks us, stop and ask; don't work around it.
//
// NEVER COMMIT PRICES: the repo is public. Snapshots/backups live in .cache/vault/ (gitignored) and KV.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseTitle, norm, sim } from "../../shared/match";
import { PLATFORMS } from "../../shared/platforms";
import { fetchLibrary } from "../../shared/sheet";
import type { Game } from "../../shared/types";

// ---------------------------------------------------------------------------------------------
// config

const ROOT = join(import.meta.dir, "../..");
const CACHE = join(ROOT, ".cache/vault");
const PAGES = join(CACHE, "pages");
const OVERRIDES = join(import.meta.dir, "overrides.json");
const KV_NAMESPACE = "cf686d99bbbb491b9221b45b50155f00";
const KV_BINDING = "STORE";
const SITE = "https://www.pricecharting.com";
const UA = "TheBacklogVault/1.0 (personal game-collection valuation script; one request every 2-3.5 s; responses cached)";
const SOURCE = "PriceCharting (pricecharting.com), US prices";
const GAP_MS = 2000;
const JITTER_MS = 1500;
const MAX_REQUESTS = 3000; // per run; a full first run needs ~1000
const ACCEPT = 0.85; // minimum match score

const ASSUMPTIONS = [
  "Loose (cartridge/disc only, good condition) unless the sheet records a condition",
  "Backlog games on consoles assumed physical; PC games treated as digital (no resale value)",
  "Arcade and MSX backlog entries treated as digital (played via re-releases or emulation)",
  "Completed games counted as physical only when the sheet says 'Own Physical Copy? Yes' (old PC big-box games included)",
  "Standard US (NTSC) release priced; special editions, Greatest Hits/Player's Choice and other variants not distinguished",
  "When PriceCharting has no price for a condition, totals use the lowest of that game's loose/CIB/new prices",
  "PriceCharting prices are averages of recent completed sales, not asking prices",
];

/** Sheet platform -> PriceCharting console slugs (primary first), search words, and non-US fallbacks. */
interface PcConsole {
  slugs: string[];
  secondary?: string[];
  foreign?: string[];
  query: string;
}
const CONSOLES: Record<string, PcConsole> = {
  NES: { slugs: ["nes"], foreign: ["famicom", "pal-nes"], query: "NES" },
  SNES: { slugs: ["super-nintendo"], foreign: ["super-famicom", "pal-super-nintendo"], query: "Super Nintendo" },
  N64: { slugs: ["nintendo-64"], foreign: ["jp-nintendo-64", "pal-nintendo-64"], query: "Nintendo 64" },
  GC: { slugs: ["gamecube"], foreign: ["jp-gamecube", "pal-gamecube"], query: "Gamecube" },
  Wii: { slugs: ["wii"], foreign: ["jp-wii", "pal-wii"], query: "Wii" },
  "Wii U": { slugs: ["wii-u"], foreign: ["jp-wii-u", "pal-wii-u"], query: "Wii U" },
  Switch: { slugs: ["nintendo-switch"], secondary: ["nintendo-switch-2"], foreign: ["jp-nintendo-switch", "pal-nintendo-switch"], query: "Switch" },
  "Switch 2": { slugs: ["nintendo-switch-2"], secondary: ["nintendo-switch"], foreign: ["jp-nintendo-switch-2", "pal-nintendo-switch-2"], query: "Switch 2" },
  Gameboy: { slugs: ["gameboy", "gameboy-color"], foreign: ["jp-gameboy", "jp-gameboy-color", "pal-gameboy", "pal-gameboy-color"], query: "GameBoy" },
  GBA: { slugs: ["gameboy-advance"], foreign: ["jp-gameboy-advance", "pal-gameboy-advance"], query: "GameBoy Advance" },
  DS: { slugs: ["nintendo-ds"], secondary: ["nintendo-3ds"], foreign: ["jp-nintendo-ds", "pal-nintendo-ds"], query: "Nintendo DS" },
  Genesis: { slugs: ["sega-genesis"], secondary: ["sega-cd", "sega-32x"], foreign: ["jp-sega-mega-drive", "pal-sega-mega-drive"], query: "Sega Genesis" },
  "Master System": { slugs: ["sega-master-system"], foreign: ["pal-sega-master-system", "jp-sega-mark-iii"], query: "Sega Master System" },
  "Game Gear": { slugs: ["sega-game-gear"], foreign: ["jp-sega-game-gear", "pal-sega-game-gear"], query: "Sega Game Gear" },
  Saturn: { slugs: ["sega-saturn"], foreign: ["jp-sega-saturn", "pal-sega-saturn"], query: "Sega Saturn" },
  Dreamcast: { slugs: ["sega-dreamcast"], foreign: ["jp-sega-dreamcast", "pal-sega-dreamcast"], query: "Sega Dreamcast" },
  "TG-16": { slugs: ["turbografx-16"], secondary: ["turbografx-cd"], foreign: ["jp-pc-engine", "jp-pc-engine-cd"], query: "TurboGrafx" },
  PS1: { slugs: ["playstation"], foreign: ["jp-playstation", "pal-playstation"], query: "PlayStation" },
  PS2: { slugs: ["playstation-2"], foreign: ["jp-playstation-2", "pal-playstation-2"], query: "PlayStation 2" },
  PS3: { slugs: ["playstation-3"], foreign: ["jp-playstation-3", "pal-playstation-3"], query: "PlayStation 3" },
  PS4: { slugs: ["playstation-4"], foreign: ["jp-playstation-4", "pal-playstation-4"], query: "PlayStation 4" },
  PS5: { slugs: ["playstation-5"], foreign: ["jp-playstation-5", "pal-playstation-5"], query: "PlayStation 5" },
  XBOX: { slugs: ["xbox"], foreign: ["jp-xbox", "pal-xbox"], query: "Xbox" },
  "XBOX 360": { slugs: ["xbox-360"], foreign: ["jp-xbox-360", "pal-xbox-360"], query: "Xbox 360" },
  XBONE: { slugs: ["xbox-one"], foreign: ["jp-xbox-one", "pal-xbox-one"], query: "Xbox One" },
  XBSeries: { slugs: ["xbox-series-x"], foreign: ["jp-xbox-series-x", "pal-xbox-series-x"], query: "Xbox Series X" },
  Windows: { slugs: ["pc-games"], query: "PC" },
  "MS-DOS": { slugs: ["pc-games"], query: "PC" },
};

/** Backlog/playing games on these platforms have no physical copy worth anything (Steam/GOG, arcade re-releases, emulation). */
const DIGITAL_PLATFORMS = new Set(["Windows", "MS-DOS", "Arcade", "MSX"]);
const KNOWN_PLATFORMS = new Set(PLATFORMS.map((p) => p.id));

// ---------------------------------------------------------------------------------------------
// args

const argv = process.argv.slice(2);
const flag = (name: string) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name: string) => flag(name)?.split("=").slice(1).join("=");
const known = ["refresh", "dry-run", "only", "upload", "allow-stale", "help"];
for (const a of argv) {
  if (!known.some((k) => a === `--${k}` || a.startsWith(`--${k}=`))) {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}
if (flag("help")) {
  console.log(readFileSync(import.meta.path, "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
const REFRESH_HOURS = flag("refresh") ? Number(flagValue("refresh") || 20) : null;
const DRY = !!flag("dry-run");
const ONLY = flagValue("only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const UPLOAD = (flagValue("upload") ?? "") as "" | "local" | "remote" | "both";
const ALLOW_STALE = !!flag("allow-stale");
if (UPLOAD && !["local", "remote", "both"].includes(UPLOAD)) {
  console.error("--upload must be local, remote or both");
  process.exit(2);
}
if (REFRESH_HOURS !== null && !(REFRESH_HOURS >= 0)) {
  console.error("--refresh=<hours> must be a number");
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// polite, cached fetching

class Blocked extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const ensureDir = (p: string) => existsSync(p) || mkdirSync(p, { recursive: true });

let nextAt = 0;
let requests = 0;
const runStart = Date.now();

interface Page {
  status: number;
  location?: string;
  body?: string;
  /** when this response was fetched (ms) */
  at: number;
  cached: boolean;
}

function cachePath(url: string): string {
  const u = new URL(url);
  const readable = (u.pathname + (u.searchParams.get("q") ? "_q_" + u.searchParams.get("q") : ""))
    .replace(/%27/g, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
  return join(PAGES, `${readable}-${sha(url).slice(0, 8)}`);
}

function readCache(url: string): Page | null {
  const base = cachePath(url);
  if (existsSync(base + ".html.gz")) {
    const at = statSync(base + ".html.gz").mtimeMs;
    return { status: 200, body: new TextDecoder().decode(Bun.gunzipSync(readFileSync(base + ".html.gz"))), at, cached: true };
  }
  if (existsSync(base + ".json")) {
    const meta = JSON.parse(readFileSync(base + ".json", "utf8"));
    return { status: meta.status, location: meta.location, at: statSync(base + ".json").mtimeMs, cached: true };
  }
  return null;
}

function writeCache(url: string, p: Page) {
  ensureDir(PAGES);
  const base = cachePath(url);
  for (const ext of [".html.gz", ".json"]) if (existsSync(base + ext)) unlinkSync(base + ext);
  if (p.status === 200 && p.body !== undefined) writeFileSync(base + ".html.gz", Bun.gzipSync(new TextEncoder().encode(p.body)));
  else writeFileSync(base + ".json", JSON.stringify({ url, status: p.status, location: p.location, fetchedAt: new Date(p.at).toISOString() }));
}

async function fetchPolite(url: string): Promise<Page> {
  if (requests >= MAX_REQUESTS) throw new Blocked(`safety stop: ${MAX_REQUESTS} requests this run`);
  for (let attempt = 0; ; attempt++) {
    const wait = nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    let res: Response | null = null;
    let err: unknown = null;
    try {
      res = await fetch(url, { redirect: "manual", headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" } });
    } catch (e) {
      err = e;
    }
    requests++;
    nextAt = Date.now() + GAP_MS + Math.random() * JITTER_MS;
    const status = res?.status ?? 0;
    if (status === 403 || status === 401 || res?.headers.get("cf-mitigated")) {
      throw new Blocked(`HTTP ${status}${res?.headers.get("cf-mitigated") ? " (cf-mitigated: " + res.headers.get("cf-mitigated") + ")" : ""} for ${url}`);
    }
    if (err || status === 429 || status >= 500) {
      if (attempt >= 4) throw new Blocked(`giving up after ${attempt + 1} tries (${err ?? "HTTP " + status}) for ${url}`);
      const retryAfter = Number(res?.headers.get("retry-after")) * 1000 || 0;
      const backoff = Math.max(retryAfter, 30_000 * 2 ** attempt);
      console.warn(`  ! ${err ? String(err) : "HTTP " + status}; backing off ${Math.round(backoff / 1000)} s`);
      nextAt = Date.now() + backoff;
      continue;
    }
    const body = status === 200 ? await res!.text() : undefined;
    if (body && /<title>\s*(Just a moment|Attention Required)/i.test(body.slice(0, 4000))) throw new Blocked(`challenge page for ${url}`);
    const location = res!.headers.get("location") ? new URL(res!.headers.get("location")!, url).toString() : undefined;
    return { status, body, location, at: Date.now(), cached: false };
  }
}

/** Fetch with the permanent page cache; `maxAgeH` (when set) refetches cached copies older than that. */
async function get(url: string, maxAgeH: number | null = null): Promise<Page> {
  const c = readCache(url);
  if (c && (maxAgeH === null || Date.now() - c.at <= maxAgeH * 3600e3)) return c;
  const p = await fetchPolite(url);
  if (![200, 301, 302, 303, 307, 308, 404, 410].includes(p.status)) throw new Error(`unexpected HTTP ${p.status} for ${url}`);
  writeCache(url, p);
  return p;
}

// ---------------------------------------------------------------------------------------------
// parsing

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

export type PriceKey = "loose" | "cib" | "new" | "graded" | "box" | "manual";
type Prices = Record<PriceKey, number | null>;
const PRICE_IDS: Record<PriceKey, string> = {
  loose: "used_price",
  cib: "complete_price",
  new: "new_price",
  graded: "graded_price",
  box: "box_only_price",
  manual: "manual_only_price",
};

interface GamePage {
  url: string;
  name: string;
  consoleSlug: string;
  consoleName: string;
  prices: Prices;
  /** when the page was fetched (ms) */
  at: number;
}

function parsePrice(s: string): number | null {
  const v = parseFloat(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

function parseGamePage(html: string, url: string, at: number): GamePage | null {
  const h1 = html.match(/<h1[^>]*id="product_name"[^>]*>([\s\S]*?)<\/h1>/);
  if (!h1) return null;
  const a = h1[1].match(/<a[^>]*href="\/console\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
  const name = text(h1[1].replace(/<a[\s\S]*?<\/a>/g, " "));
  const canonical = html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/)?.[1];
  const prices = {} as Prices;
  for (const [k, id] of Object.entries(PRICE_IDS) as [PriceKey, string][]) {
    const m = html.match(new RegExp(`id="${id}"[^>]*>\\s*<span class="price js-price"[^>]*>([^<]*)<`));
    prices[k] = m ? parsePrice(m[1]) : null;
  }
  return { url: canonical ? decode(canonical) : url, name, consoleSlug: a?.[1] ?? "", consoleName: a ? text(a[2]) : "", prices, at };
}

interface Candidate {
  url: string;
  name: string;
  consoleSlug: string;
  consoleName: string;
  pos: number;
}

function parseSearch(html: string): Candidate[] {
  const out: Candidate[] = [];
  for (const row of html.matchAll(/<tr id="product-\d+"[\s\S]*?<\/tr>/g)) {
    const t = row[0].match(/<td class="title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const c = row[0].match(/<td class="console[^"]*">\s*<a href="\/console\/([^"]+)">([\s\S]*?)<\/a>/);
    if (!t) continue;
    const url = new URL(decode(t[1]), SITE).toString();
    const consoleSlug = c?.[1] ?? url.match(/\/game\/([^/]+)\//)?.[1] ?? "";
    out.push({ url, name: text(t[2]), consoleSlug, consoleName: c ? text(c[2]) : consoleSlug, pos: out.length });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// matching

const VARIANT =
  /\b(collector'?s|limited|special|deluxe|premium|steelbook|greatest hits|player'?s choice|platinum|nintendo selects|playstation hits|best buy|gamestop|target|walmart|amazon|launch|day one|game of the year|goty|complete edition|definitive|gold|ultimate|anniversary|bundle|demo|not for resale|rental|reprint|retro-bit|limited run|variant|exclusive|pre-?order|box set|signature|kiosk|seal(ed)?|lot)\b/i;

function consolePenalty(slug: string, pc: PcConsole): number | null {
  if (pc.slugs.includes(slug)) return 0;
  if (pc.secondary?.includes(slug)) return 0.02;
  if (pc.foreign?.includes(slug)) return 0.1;
  return null;
}

/** Spelling differences PriceCharting makes systematically. */
const canon = (s: string) =>
  s
    .replace(/^(the )?legend of zelda\b/i, "Zelda") // "Zelda Wind Waker"
    .replace(/^disney'?s\s+/i, "") // "Goof Troop"
    .replace(/^tony hawk'?s pro skater (\d)$/i, "Tony Hawk $1") // "Tony Hawk 3"
    .replace(/^madden nfl (\d{4})$/i, "Madden $1") // "Madden 2003"
    .replace(/^madden nfl 0(\d)$/i, "Madden 200$1") // "Madden 2008"
    .replace(/\b([a-z])-(\d)/gi, "$1$2") // "F-1" ~ "F1"
    .replace(/(\d),(\d{3})\b/g, "$1$2"); // "40,000" ~ "40000"

/** "Rush 2: Extreme Racing USA" -> "Rush 2"; "Castle of Illusion Starring Mickey Mouse" -> "Castle of Illusion" */
function coreTitle(title: string): string | null {
  const core = title.split(/\s*:\s*|\s+-\s+|\s+starring\s+/i)[0].trim();
  if (core === title.trim()) return null;
  return norm(core).split(" ").filter((t) => !["the", "a", "an", "of", "and"].includes(t)).length >= 2 ? core : null;
}

function score(sheetTitle: string, candName: string): number {
  let s = sim(canon(sheetTitle), canon(candName));
  // PriceCharting often drops the subtitle: an exact match on the main title is good enough to accept
  // (but scores below any full-title match, and lands in review.txt's lowest-confidence list)
  const core = coreTitle(canon(sheetTitle));
  if (core && sim(core, canon(candName)) >= 0.98) s = Math.max(s, 0.88);
  if (/\[[^\]]*\]/.test(candName) && !/\[/.test(sheetTitle)) s -= 0.04; // "[Greatest Hits]" etc: a variant of the base game
  const v = candName.match(VARIANT);
  if (v && !new RegExp(`\\b${v[1]}`, "i").test(sheetTitle)) s -= 0.05;
  return s;
}

function rank(sheetTitle: string, pc: PcConsole, cands: Candidate[], allowForeign: boolean): { c: Candidate; s: number }[] {
  return cands
    .map((c) => {
      const p = !allowForeign && pc.foreign?.includes(c.consoleSlug) ? null : consolePenalty(c.consoleSlug, pc);
      return p === null ? null : { c, s: score(sheetTitle, c.name) - p - c.pos * 0.0005 };
    })
    .filter((x): x is { c: Candidate; s: number } => !!x)
    .sort((a, b) => tier(a) - tier(b) || b.s - a.s);
  // any acceptable US release beats a (better-named) JP/PAL one
  function tier(x: { c: Candidate; s: number }) {
    return x.s < ACCEPT ? 2 : pc.foreign?.includes(x.c.consoleSlug) ? 1 : 0;
  }
}

/** PriceCharting-style slug: "Castlevania II: Belmont's Revenge" -> "castlevania-ii-belmont%27s-revenge" */
function pcSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' &+-]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/'/g, "%27")
    .replace(/\+/g, "%2B");
}

const searchUrl = (q: string) => `${SITE}/search-products?type=prices&q=${encodeURIComponent(q).replace(/%20/g, "+")}`;

interface Resolved {
  page?: GamePage;
  score?: number;
  how?: "override" | "guess" | "search" | "search-title" | "search-core";
  skip?: boolean;
  reason?: string;
}

async function loadGame(url: string, maxAgeH: number | null): Promise<GamePage | null> {
  const p = await get(url, maxAgeH);
  if (p.status !== 200 || !p.body) return null;
  const g = parseGamePage(p.body, url, p.at);
  if (!g) {
    // a 200 game page we can't parse: layout changed or something in the way. Don't keep going blind.
    throw new Blocked(`can't parse game page ${url} (layout change or interstitial?)`);
  }
  return g;
}

/**
 * Find the PriceCharting page for one game: override, else a guessed URL, else search. Only games Cooper
 * definitely owns physically (`allowForeign`) may match a JP/PAL release: a backlog entry whose only
 * release is foreign ("Aleste", "GG Aleste 2") is almost certainly played via a modern collection.
 */
async function resolve(
  game: Game,
  overrides: Record<string, string | null>,
  opts: { priceAgeH: number | null; searchAgeH: number | null; allowForeign: boolean },
): Promise<Resolved> {
  if (game.id in overrides) {
    const o = overrides[game.id];
    if (o === null) return { skip: true, reason: "skipped (override)" };
    const g = await loadGame(o, opts.priceAgeH);
    return g ? { page: g, score: 1, how: "override" } : { reason: `override URL not found: ${o}` };
  }
  const pc = CONSOLES[game.platform];
  if (!pc) return { reason: `no PriceCharting console for platform "${game.platform}"` };
  const title = baseTitle(game.title) + (game.edition ? ` ${game.edition}` : "");

  // 1. guess the URL: cheap and right for most plainly-named games
  const guessUrl = `${SITE}/game/${pc.slugs[0]}/${pcSlug(baseTitle(game.title))}`;
  const guess = await get(guessUrl, opts.searchAgeH);
  if (guess.status === 200 && guess.body) {
    const g = parseGamePage(guess.body, guessUrl, guess.at);
    if (!g) throw new Blocked(`can't parse game page ${guessUrl}`);
    const s = score(title, g.name);
    if (s >= 0.9 && consolePenalty(g.consoleSlug, pc) === 0) {
      // fresh prices for this snapshot (the guess may have been cached long ago)
      const fresh = opts.priceAgeH !== null ? await loadGame(guessUrl, opts.priceAgeH) : g;
      return { page: fresh ?? g, score: s, how: "guess" };
    }
  }

  // 2. search "<title> <console>", then 3. the bare title
  const seen = new Map<string, Candidate & { how: Resolved["how"] }>(); // every candidate so far, by URL
  const elsewhere = new Set<string>(); // consoles the same title exists on, for the reason text
  const core = coreTitle(title);
  const queries: [string, Resolved["how"]][] = [
    [`${title} ${pc.query}`, "search"],
    [title, "search-title"],
  ];
  if (core) queries.push([`${core} ${pc.query}`, "search-core"]);
  let best: { c: Candidate; s: number } | undefined;
  let closest: { c: Candidate; s: number } | undefined; // incl. foreign releases, for the reason text
  for (const [qi, [q, how]] of queries.entries()) {
    const sp = await get(searchUrl(q), opts.searchAgeH);
    let cands: Candidate[] = [];
    if (sp.status >= 300 && sp.status < 400 && sp.location && /\/game\//.test(sp.location)) {
      // exactly one hit: PriceCharting redirects straight to the game page (any cached copy will do to
      // learn its name; it's refetched below, under this same URL, if it's the match and prices are due)
      const loc = sp.location.replace(/[?#].*$/, "");
      const g = await loadGame(loc, null);
      if (g) cands = [{ url: loc, name: g.name, consoleSlug: g.consoleSlug, consoleName: g.consoleName, pos: 0 }];
    } else if (sp.status === 200 && sp.body) {
      cands = parseSearch(sp.body);
    }
    for (const c of cands) if (!seen.has(c.url)) seen.set(c.url, { ...c, pos: c.pos + qi * 10, how });
    for (const c of cands) if (consolePenalty(c.consoleSlug, pc) === null && score(title, c.name) >= 0.95) elsewhere.add(c.consoleName);
    best = rank(title, pc, [...seen.values()], opts.allowForeign)[0];
    closest = rank(title, pc, [...seen.values()], true)[0];
    // accept a US release right away; a JP/PAL one only once every query has had its chance
    const last = qi === queries.length - 1;
    if (best && best.s >= ACCEPT && (last || !pc.foreign?.includes(best.c.consoleSlug))) {
      const g = await loadGame(best.c.url, opts.priceAgeH);
      if (g) return { page: g, score: best.s, how: seen.get(best.c.url)?.how ?? how };
    }
  }
  if (closest && closest.s >= ACCEPT && closest.c.url !== best?.c.url && pc.foreign?.includes(closest.c.consoleSlug)) {
    return { reason: `no US release on PriceCharting (only "${closest.c.name}" [${closest.c.consoleName}]); likely played via a re-release/collection` };
  }
  if ((!best || best.s < 0.6) && elsewhere.size) {
    const on = [...elsewhere].slice(0, 4).join(", ");
    return { reason: `no ${game.platform} release on PriceCharting (exists for ${on}); probably digital` };
  }
  return {
    reason: best ? `no confident match (closest: "${best.c.name}" [${best.c.consoleName}] ${best.s.toFixed(2)})` : "no match on PriceCharting",
  };
}

// ---------------------------------------------------------------------------------------------
// snapshot

interface Item {
  id: string;
  title: string;
  platform: string;
  status: Game["status"];
  physical: "yes" | "assumed";
  prices: Prices;
  url: string;
  matchedTitle: string;
  matchedConsole: string;
  match: number;
  recorded: number | null;
}
interface Unpriced {
  id: string;
  title: string;
  platform: string;
  reason: string;
}
interface Snapshot {
  date: string;
  generatedAt: string;
  source: string;
  currency: "USD";
  assumptions: string[];
  items: Item[];
  unpriced: Unpriced[];
  excluded: { digital: number; wishlist: number };
}
interface IndexEntry {
  date: string;
  generatedAt: string;
  source: string;
  totals: { loose: number; cib: number; new: number; asOwned: number };
  priced: number;
  unpriced: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;
/** The condition the sheet records for each game (optional "Condition" column); loose when it doesn't say. */
const CONDITION = new Map<string, PriceKey>();
const conditionOf = (it: Item): PriceKey => CONDITION.get(it.id) ?? "loose";
/** An item's value in condition `c`; when PriceCharting has no such price, the lowest of its loose/CIB/new. */
function valueAs(it: Item, c: PriceKey): number {
  const v = it.prices[c];
  if (v !== null) return v;
  const others = (["loose", "cib", "new"] as PriceKey[]).map((k) => it.prices[k]).filter((x): x is number => x !== null);
  return others.length ? Math.min(...others) : 0;
}

function totals(items: Item[]) {
  const sum = (f: (it: Item) => number) => cents(items.reduce((a, it) => a + f(it), 0));
  return {
    loose: sum((it) => valueAs(it, "loose")),
    cib: sum((it) => valueAs(it, "cib")),
    new: sum((it) => valueAs(it, "new")),
    asOwned: sum((it) => valueAs(it, conditionOf(it))),
  };
}

const localDate = (ms: number) => new Date(ms).toLocaleDateString("en-CA"); // YYYY-MM-DD, local time

/** Deterministic shuffle (so the review sample is stable for a given snapshot date). */
function sample<T>(xs: T[], n: number, seed: string): T[] {
  let h = parseInt(sha(seed).slice(0, 8), 16);
  const rnd = () => ((h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x6d2b79f5) >>> 0), h / 2 ** 32);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// ---------------------------------------------------------------------------------------------
// KV

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function remoteKv() {
  const env = { ...readEnvFile(join(ROOT, ".env.cloudflare-deploy")), ...process.env };
  const acct = env.CLOUDFLARE_ACCOUNT_ID, token = env.CLOUDFLARE_API_TOKEN;
  if (!acct || !token) throw new Error("remote upload needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (.env.cloudflare-deploy)");
  const url = (key: string) => `https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${KV_NAMESPACE}/values/${encodeURIComponent(key)}`;
  const headers = { authorization: `Bearer ${token}` };
  return {
    async get(key: string): Promise<string | null> {
      const res = await fetch(url(key), { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`KV get ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      return res.text();
    },
    async put(key: string, value: string) {
      const res = await fetch(url(key), { method: "PUT", headers: { ...headers, "content-type": "text/plain" }, body: value });
      const body = await res.text();
      if (!res.ok || !JSON.parse(body).success) throw new Error(`KV put ${key}: HTTP ${res.status} ${body.slice(0, 300)}`);
      const back = await this.get(key);
      if (back !== value) throw new Error(`KV put ${key}: read-back mismatch`);
    },
  };
}

function wrangler(args: string[]): { ok: boolean; out: string; err: string; cmd: string } {
  const cmd = ["bunx", "wrangler", ...args];
  const r = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString(), cmd: cmd.map((c) => (/\s/.test(c) ? JSON.stringify(c) : c)).join(" ") };
}

function localKv() {
  return {
    async get(key: string): Promise<string | null> {
      const r = wrangler(["kv", "key", "get", "--local", "--binding", KV_BINDING, "--text", key]);
      if (!r.ok) return null;
      const out = r.out.trim();
      return out && out !== "Value not found" ? out : null;
    },
    async put(key: string, value: string) {
      ensureDir(join(CACHE, "tmp"));
      const file = join(CACHE, "tmp", key.replace(/[^a-z0-9-]+/gi, "_") + ".json");
      writeFileSync(file, value);
      const r = wrangler(["kv", "key", "put", "--local", "--binding", KV_BINDING, key, "--path", file]);
      if (!r.ok) throw new Error(`local KV put failed: ${r.cmd}\n${r.err || r.out}`);
      console.log(`    $ ${r.cmd.replace(ROOT + "/", "")}`);
    },
  };
}

function parseIndex(s: string | null): IndexEntry[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function mergeIndex(...lists: IndexEntry[][]): IndexEntry[] {
  const by = new Map<string, IndexEntry>();
  for (const l of lists) for (const e of l) if (e && /^\d{4}-\d{2}-\d{2}$/.test(e.date)) by.set(e.date, e);
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------------------------
// main

async function main() {
  ensureDir(PAGES);
  const overridesRaw: Record<string, string | null> = existsSync(OVERRIDES) ? JSON.parse(readFileSync(OVERRIDES, "utf8")) : {};
  const overrides = Object.fromEntries(Object.entries(overridesRaw).filter(([k]) => !k.startsWith("_")));

  console.log("reading Cooper's sheet...");
  const lib = await fetchLibrary();
  writeFileSync(join(CACHE, "library.json"), JSON.stringify(lib));

  const owned = lib.games.filter((g) => g.status !== "wishlist");
  for (const g of owned) if (g.condition) CONDITION.set(g.id, g.condition);
  const wishlist = lib.games.length - owned.length;
  const physical: { g: Game; physical: "yes" | "assumed" }[] = [];
  let digital = 0;
  for (const g of owned) {
    if (g.ownPhysical !== undefined) {
      // the sheet says ("Own Physical Copy?" on the Completed tab, and Backlog if it ever gets one)
      if (g.ownPhysical) physical.push({ g, physical: "yes" });
      else digital++;
    } else if (DIGITAL_PLATFORMS.has(g.platform)) digital++;
    else physical.push({ g, physical: "assumed" });
  }
  for (const id of Object.keys(overrides)) if (!lib.games.some((g) => g.id === id)) console.warn(`  ! override for unknown game id ${id}`);
  const unknownPlatforms = [...new Set(physical.map((p) => p.g.platform).filter((p) => !KNOWN_PLATFORMS.has(p)))];
  if (unknownPlatforms.length) console.warn(`  ! platforms not in shared/platforms.ts (priced if PriceCharting has them): ${unknownPlatforms.join(", ")}`);

  const work = ONLY ? physical.filter((p) => ONLY.includes(p.g.id)) : physical;
  if (ONLY) {
    for (const id of ONLY) {
      const g = lib.games.find((x) => x.id === id);
      if (!g) console.warn(`  ! no game with id ${id}`);
      else if (!work.some((w) => w.g.id === id)) console.warn(`  ! ${id} is not counted as a physical owned game (status ${g.status}, platform ${g.platform})`);
    }
  }
  console.log(`${lib.games.length} games: ${owned.length} owned (${physical.length} physical, ${digital} digital), ${wishlist} wishlist`);
  console.log(`pricing ${work.length} games${REFRESH_HOURS !== null ? ` (refreshing pages older than ${REFRESH_HOURS} h)` : ""}...`);

  const items: Item[] = [];
  const unpriced: Unpriced[] = [];
  const how = new Map<string, string>();
  const pageAt: number[] = [];
  let blocked: string | null = null;
  for (const [i, { g, physical: ph }] of work.entries()) {
    const before = requests;
    let r: Resolved;
    try {
      const allowForeign = ph === "yes";
      r = await resolve(g, overrides, { priceAgeH: REFRESH_HOURS, searchAgeH: null, allowForeign });
      if (!r.page && !r.skip && REFRESH_HOURS !== null) r = await resolve(g, overrides, { priceAgeH: REFRESH_HOURS, searchAgeH: REFRESH_HOURS, allowForeign });
    } catch (e) {
      if (e instanceof Blocked) {
        blocked = e.message;
        break;
      }
      r = { reason: `error: ${(e as Error).message}` };
    }
    const n = `[${String(i + 1).padStart(3)}/${work.length}]`;
    const reqs = requests - before ? ` (+${requests - before} req)` : "";
    if (r.page && Object.values(r.page.prices).some((v) => v !== null)) {
      const p = r.page;
      items.push({
        id: g.id,
        title: g.title,
        platform: g.platform,
        status: g.status,
        physical: ph,
        prices: p.prices,
        url: p.url,
        matchedTitle: p.name,
        matchedConsole: p.consoleName,
        match: Math.round(Math.min(1, r.score ?? 0) * 100) / 100,
        recorded: g.value ?? null,
      });
      how.set(g.id, r.how ?? "");
      pageAt.push(p.at);
      console.log(`${n} ${g.title} [${g.platform}] -> ${p.name} [${p.consoleName}] $${p.prices.loose ?? "-"} / $${p.prices.cib ?? "-"} (${r.how} ${r.score?.toFixed(2)})${reqs}`);
    } else {
      const reason = r.page ? `no price data on PriceCharting (${r.page.url})` : (r.reason ?? "no match");
      unpriced.push({ id: g.id, title: g.title, platform: g.platform, reason });
      console.log(`${n} ${g.title} [${g.platform}] -> UNPRICED: ${reason}${reqs}`);
    }
  }
  const mins = ((Date.now() - runStart) / 60000).toFixed(1);
  console.log(`\n${requests} requests to PriceCharting in ${mins} min`);
  if (blocked) {
    console.error(`\nSTOPPED: ${blocked}\nPriceCharting may be blocking or rate-limiting us. Everything fetched so far is cached;`);
    console.error(`do NOT retry in a loop or try to evade it. Wait (hours), then re-run the same command to resume.`);
    process.exit(3);
  }

  if (ONLY) {
    console.log(JSON.stringify({ items, unpriced }, null, 1));
    return;
  }

  // ---- the snapshot ------------------------------------------------------------------------
  const newest = Math.max(...pageAt), oldest = Math.min(...pageAt);
  const date = localDate(newest);
  const stale = newest - oldest > 7 * 864e5;
  items.sort((a, b) => valueAs(b, "loose") - valueAs(a, "loose") || a.title.localeCompare(b.title));
  unpriced.sort((a, b) => a.platform.localeCompare(b.platform) || a.title.localeCompare(b.title));
  const assumptions = [...ASSUMPTIONS];
  if (localDate(oldest) !== date) assumptions.push(`Prices fetched between ${localDate(oldest)} and ${date}`);
  const snap: Snapshot = {
    date,
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    currency: "USD",
    assumptions,
    items,
    unpriced,
    excluded: { digital, wishlist },
  };
  const entry: IndexEntry = { date, generatedAt: snap.generatedAt, source: SOURCE, totals: totals(items), priced: items.length, unpriced: unpriced.length };

  // ---- review file: the top 30 + a random 20, every match, and the unpriced ---------------
  const fmt = (v: number | null) => (v === null ? "     -" : ("$" + v.toFixed(0)).padStart(6));
  const line = (it: Item, i?: number) =>
    `${i !== undefined ? String(i + 1).padStart(3) + ". " : ""}${fmt(it.prices.loose)} ${fmt(it.prices.cib)} ${fmt(it.prices.new)}  ${it.title} [${it.platform}]  ->  ${it.matchedTitle} [${it.matchedConsole}]  ${it.match.toFixed(2)} ${how.get(it.id)}  ${it.id}`;
  const review = [
    `Vault pricing review — snapshot ${date} (${items.length} priced, ${unpriced.length} unpriced)`,
    `totals: loose $${entry.totals.loose}  cib $${entry.totals.cib}  new $${entry.totals.new}  asOwned $${entry.totals.asOwned}`,
    `columns: loose cib new  sheet title [platform] -> PriceCharting title [console]  match how  id`,
    "",
    "== TOP 30 ==",
    ...items.slice(0, 30).map(line),
    "",
    "== RANDOM 20 (rest of the list) ==",
    ...sample(items.slice(30), 20, date).map((it) => line(it)),
    "",
    "== LOWEST-CONFIDENCE 25 ==",
    ...[...items].sort((a, b) => a.match - b.match).slice(0, 25).map((it) => line(it)),
    "",
    "== UNPRICED ==",
    ...unpriced.map((u) => `${u.title} [${u.platform}]  ${u.id}  — ${u.reason}`),
    "",
    "== ALL ITEMS ==",
    ...items.map(line),
  ].join("\n");
  writeFileSync(join(CACHE, "review.txt"), review + "\n");

  console.log(`\nsnapshot ${date}: ${items.length} priced, ${unpriced.length} unpriced, excluded ${digital} digital + ${wishlist} wishlist`);
  console.log(`totals: loose $${entry.totals.loose.toLocaleString()}  cib $${entry.totals.cib.toLocaleString()}  new $${entry.totals.new.toLocaleString()}  (as owned $${entry.totals.asOwned.toLocaleString()})`);
  console.log(`top 10:\n${items.slice(0, 10).map(line).join("\n")}`);
  console.log(`review: .cache/vault/review.txt`);
  if (stale) console.warn(`\n  ! cached prices span ${localDate(oldest)} .. ${date}: run with --refresh for a consistent snapshot`);

  if (DRY) {
    writeFileSync(join(CACHE, "preview.json"), JSON.stringify(snap, null, 1));
    console.log(`dry run: wrote .cache/vault/preview.json, uploaded nothing`);
    return;
  }

  // ---- local backup (always), then KV ------------------------------------------------------
  ensureDir(join(CACHE, "snapshots"));
  const snapJson = JSON.stringify(snap);
  writeFileSync(join(CACHE, "snapshots", `${date}.json`), JSON.stringify(snap, null, 1));
  const backupIndexFile = join(CACHE, "index.json");
  const backupIndex = parseIndex(existsSync(backupIndexFile) ? readFileSync(backupIndexFile, "utf8") : null);
  console.log(`backup: .cache/vault/snapshots/${date}.json`);

  if (!UPLOAD) {
    writeFileSync(backupIndexFile, JSON.stringify(mergeIndex(backupIndex, [entry]), null, 1));
    console.log(`not uploaded (pass --upload=local|remote|both)`);
    return;
  }
  if (stale && !ALLOW_STALE) {
    console.error(`refusing to upload a snapshot whose prices span more than 7 days; run with --refresh (or pass --allow-stale)`);
    process.exit(4);
  }
  const targets = UPLOAD === "both" ? (["remote", "local"] as const) : ([UPLOAD] as const);
  const kvs = Object.fromEntries(targets.map((t) => [t, t === "remote" ? remoteKv() : localKv()]));
  // one merged history: whatever each KV already has + the local backup + this snapshot
  const existing = await Promise.all(targets.map(async (t) => parseIndex(await kvs[t].get("vault:index"))));
  const index = mergeIndex(backupIndex, ...existing, [entry]);
  const indexJson = JSON.stringify(index);
  for (const t of targets) {
    console.log(`uploading to ${t} KV: vault:snap:${date} (${(snapJson.length / 1024).toFixed(0)} KB), vault:index (${index.length} entries)`);
    await kvs[t].put(`vault:snap:${date}`, snapJson);
    await kvs[t].put("vault:index", indexJson);
  }
  writeFileSync(backupIndexFile, JSON.stringify(index, null, 1));
  console.log(`done.`);
}

await main();
