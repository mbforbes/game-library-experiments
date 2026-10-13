// LaunchBox Games DB: a community database with real scans of box backs, spines, cartridges
// (cut-out photos), discs and clear logos, plus ESRB ratings and publishers.
// We download the metadata dump once, stream-parse the 500 MB XML and keep just our platforms.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { CACHE, ensureDir } from "./util";
import { sim, baseTitle, yearHint, norm } from "../../shared/match";

const DIR = join(CACHE, "launchbox");
const ZIP_URL = "https://gamesdb.launchbox-app.com/Metadata.zip";
export const LB_IMG = "https://images.launchbox-app.com/";

/** Our platform id -> LaunchBox platform names (best first) */
export const LB_PLATFORMS: Record<string, string[]> = {
  Arcade: ["Arcade"],
  "MS-DOS": ["MS-DOS"],
  NES: ["Nintendo Entertainment System"],
  MSX: ["Microsoft MSX2", "Microsoft MSX"],
  "Master System": ["Sega Master System"],
  Windows: ["Windows", "Windows 3.X", "MS-DOS"],
  "TG-16": ["NEC TurboGrafx-16", "NEC TurboGrafx-CD"],
  Genesis: ["Sega Genesis"],
  Gameboy: ["Nintendo Game Boy", "Nintendo Game Boy Color"],
  "Game Gear": ["Sega Game Gear"],
  SNES: ["Super Nintendo Entertainment System"],
  Saturn: ["Sega Saturn"],
  PS1: ["Sony Playstation"],
  N64: ["Nintendo 64"],
  Dreamcast: ["Sega Dreamcast"],
  PS2: ["Sony Playstation 2"],
  GBA: ["Nintendo Game Boy Advance"],
  GC: ["Nintendo GameCube"],
  XBOX: ["Microsoft Xbox"],
  DS: ["Nintendo DS"],
  "XBOX 360": ["Microsoft Xbox 360"],
  PS3: ["Sony Playstation 3"],
  Wii: ["Nintendo Wii"],
  "Wii U": ["Nintendo Wii U"],
  PS4: ["Sony Playstation 4"],
  XBONE: ["Microsoft Xbox One"],
  Switch: ["Nintendo Switch"],
  XBSeries: ["Microsoft Xbox Series X/S"],
  PS5: ["Sony Playstation 5"],
  "Switch 2": ["Nintendo Switch 2"],
};

const KEEP_TYPES = new Set(["Box - Front", "Box - Back", "Box - Spine", "Cart - Front", "Cart - Back", "Disc", "Clear Logo", "Arcade - Marquee"]);

export interface LbImage {
  file: string;
  region?: string;
}
export interface LbGame {
  id: number;
  name: string;
  platform: string;
  year?: number;
  esrb?: string;
  publisher?: string;
  developer?: string;
  players?: number;
  alts: string[];
  images: Record<string, LbImage[]>;
}

let INDEX: Map<string, LbGame[]> | null = null;

/** Build (once) and load the per-platform index. */
export async function loadLaunchbox(): Promise<Map<string, LbGame[]>> {
  if (INDEX) return INDEX;
  const idxFile = join(DIR, "index.json");
  if (!(await Bun.file(idxFile).exists())) await buildIndex(idxFile);
  const games: LbGame[] = await Bun.file(idxFile).json();
  INDEX = new Map();
  for (const g of games) {
    if (!INDEX.has(g.platform)) INDEX.set(g.platform, []);
    INDEX.get(g.platform)!.push(g);
  }
  return INDEX;
}

async function buildIndex(out: string) {
  ensureDir(DIR);
  const xml = join(DIR, "Metadata.xml");
  if (!existsSync(xml)) {
    const zip = join(DIR, "Metadata.zip");
    if (!existsSync(zip)) {
      console.log("downloading LaunchBox metadata (~110 MB)…");
      await $`curl -sfL -A "CoopersGameLibrary/0.1" -o ${zip} ${ZIP_URL}`;
    }
    await $`unzip -o -q ${zip} Metadata.xml -d ${DIR}`;
  }
  console.log("indexing LaunchBox metadata…");
  const wanted = new Set(Object.values(LB_PLATFORMS).flat());
  const games = new Map<number, LbGame>();
  const tag = (block: string, t: string) => {
    const m = block.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`));
    return m ? decode(m[1]) : undefined;
  };
  // Stream the XML and cut out complete top-level elements.
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.file(xml).stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let start: number;
    while ((start = buf.indexOf("<", 0)) >= 0) {
      const m = buf.slice(start, start + 24).match(/^<(Game|GameAlternateName|GameImage)>/);
      if (!m) {
        const next = buf.indexOf("<", start + 1);
        if (next < 0) {
          buf = buf.slice(start);
          break;
        }
        buf = buf.slice(next);
        continue;
      }
      const name = m[1];
      const close = `</${name}>`;
      const end = buf.indexOf(close, start);
      if (end < 0) {
        buf = buf.slice(start);
        break;
      }
      const block = buf.slice(start, end + close.length);
      buf = buf.slice(end + close.length);
      if (name === "Game") {
        const platform = tag(block, "Platform") ?? "";
        if (!wanted.has(platform)) continue;
        const id = +(tag(block, "DatabaseID") ?? 0);
        const year = +(tag(block, "ReleaseYear") ?? tag(block, "ReleaseDate")?.slice(0, 4) ?? 0) || undefined;
        games.set(id, {
          id,
          name: tag(block, "Name") ?? "",
          platform,
          year,
          esrb: tag(block, "ESRB"),
          publisher: tag(block, "Publisher"),
          developer: tag(block, "Developer"),
          players: +(tag(block, "MaxPlayers") ?? 0) || undefined,
          alts: [],
          images: {},
        });
      } else if (name === "GameAlternateName") {
        const g = games.get(+(tag(block, "DatabaseID") ?? 0));
        const alt = tag(block, "AlternateName");
        if (g && alt) g.alts.push(alt);
      } else {
        const g = games.get(+(tag(block, "DatabaseID") ?? 0));
        const type = tag(block, "Type") ?? "";
        if (!g || !KEEP_TYPES.has(type)) continue;
        (g.images[type] ??= []).push({ file: tag(block, "FileName")!, region: tag(block, "Region") });
      }
    }
  }
  const list = [...games.values()];
  await Bun.write(out, JSON.stringify(list));
  console.log(`LaunchBox index: ${list.length} games on our platforms`);
}

function decode(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

const REGION_RANK = ["North America", "United States", "World", "Canada", undefined, "United Kingdom", "Europe", "Australia"];
function regionRank(r?: string) {
  const i = REGION_RANK.indexOf(r);
  return i < 0 ? (r === "Japan" ? 20 : 10) : i;
}

// Cooper's copies are North American releases: packaging scans must be NA (or region-free);
// a Japanese Mega Drive spine or a PAL back would be wrong. Logos can come from anywhere.
const NA = new Set(["North America", "United States", "Canada", "World", undefined]);

export function bestImage(g: LbGame, type: string): string | undefined {
  let list = g.images[type];
  if (!list?.length) return;
  if (type !== "Clear Logo") list = list.filter((i) => NA.has(i.region));
  if (!list.length) return;
  return [...list].sort((a, b) => regionRank(a.region) - regionRank(b.region))[0].file;
}

// token index per platform so matching doesn't compare against every game (Windows has ~50k)
const STOP = new Set(["the", "a", "an", "of", "and", "edition", "game", "1", "2", "3"]);
const tokIndex = new Map<string, Map<string, Set<LbGame>>>();
function tokensOf(s: string) {
  return norm(s).split(" ").filter((t) => t && !STOP.has(t));
}
function platformIndex(plat: string, games: LbGame[]) {
  let idx = tokIndex.get(plat);
  if (idx) return idx;
  idx = new Map();
  for (const g of games)
    for (const name of [g.name, ...g.alts])
      for (const t of tokensOf(name)) {
        if (!idx.has(t)) idx.set(t, new Set());
        idx.get(t)!.add(g);
      }
  tokIndex.set(plat, idx);
  return idx;
}

/** A specific LaunchBox game by DatabaseID (for overrides). */
export async function launchboxById(id: number): Promise<LbGame | null> {
  const idx = await loadLaunchbox();
  for (const list of idx.values()) for (const g of list) if (g.id === id) return g;
  return null;
}

/** Find the LaunchBox entry for one of our games. */
export async function launchboxMatch(platformId: string, title: string, year?: number): Promise<{ game: LbGame; score: number } | null> {
  const idx = await loadLaunchbox();
  year = yearHint(title) ?? year;
  const want = baseTitle(title);
  const wantTok = tokensOf(want);
  let best: { game: LbGame; score: number } | null = null;
  for (const plat of LB_PLATFORMS[platformId] ?? []) {
    const all = idx.get(plat) ?? [];
    const ti = platformIndex(plat, all);
    // candidates: games sharing the query's rarest token (or all, for very short titles)
    const sets = wantTok.map((t) => ti.get(t)).filter((x): x is Set<LbGame> => !!x);
    const cand: Iterable<LbGame> = sets.length ? sets.sort((a, b) => a.size - b.size)[0] : wantTok.length ? [] : all;
    for (const g of cand) {
      let s = Math.max(sim(want, g.name), ...g.alts.map((a) => sim(want, a) - 0.01));
      if (s < 0.86) continue;
      if (year && g.year) s += Math.abs(g.year - year) <= 1 ? 0.03 : -0.06;
      // prefer entries that actually have scans
      s += Math.min(0.02, Object.keys(g.images).length * 0.004);
      if (plat !== LB_PLATFORMS[platformId][0]) s -= 0.01;
      if (!best || s > best.score) best = { game: g, score: s };
    }
  }
  return best;
}
