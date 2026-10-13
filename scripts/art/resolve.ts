// Resolve each unique (platform, title) to cover art + gameplay snaps.
// Output: art/resolved.json (committed; it is the reviewed record of which image belongs to which game).

import { platformOf, type Platform } from "../../shared/platforms";
import type { Game } from "../../shared/types";
import { libretro, steamCover, steamDetails, steamSearch, wikipedia, wikipediaPage, type Candidate } from "./sources";
import { pmap, progress } from "./util";

export interface Override {
  cover?: string | null; // explicit URL, or null to force "no art" (procedural cover)
  wiki?: string; // Wikipedia page title to take the infobox image from
  steam?: number; // Steam app id
  libretro?: string; // exact libretro name (within the platform's systems)
  snaps?: string[];
  note?: string;
}

export interface Resolved {
  key: string;
  title: string;
  platform: string;
  cover?: Candidate;
  alts: Candidate[];
  snaps: string[];
  titleScreen?: string;
  year?: number;
  steam?: { appid: number; name: string; score: number };
  flags: string[];
}

const MODERN = new Set(["PS3", "PS4", "PS5", "Switch", "Switch 2", "Wii U", "XBONE", "XBSeries", "XBOX 360"]);
const ACCEPT = 0.85;

function wikiPlatformNames(p: Platform): string[] {
  const names: Record<string, string[]> = {
    NES: ["NES", "Nintendo Entertainment System"], SNES: ["SNES", "Super NES"], N64: ["Nintendo 64"], Genesis: ["Genesis", "Mega Drive"],
    Gameboy: ["Game Boy"], GBA: ["Game Boy Advance"], PS1: ["PlayStation"], PS2: ["PlayStation 2"], PS3: ["PlayStation 3"], PS4: ["PlayStation 4"],
    PS5: ["PlayStation 5"], Windows: ["Windows", "PC"], "MS-DOS": ["MS-DOS", "DOS"], Arcade: ["arcade"], "TG-16": ["TurboGrafx-16", "PC Engine"],
    "Game Gear": ["Game Gear"], "Master System": ["Master System"], GC: ["GameCube"], Wii: ["Wii"], DS: ["Nintendo DS"], Switch: ["Nintendo Switch", "Switch"],
    "Switch 2": ["Nintendo Switch 2"], MSX: ["MSX", "MSX2"], Dreamcast: ["Dreamcast"], Saturn: ["Saturn"],
  };
  return names[p.id] ?? [p.name];
}

export async function resolveAll(games: Game[], overrides: Record<string, Override>, prev: Record<string, Resolved>, opts: { refresh?: boolean } = {}): Promise<Record<string, Resolved>> {
  // Unique art keys (same game on backlog + wishlist shares art)
  const byKey = new Map<string, Game>();
  for (const g of games) if (!byKey.has(g.artKey)) byKey.set(g.artKey, g);
  const keys = [...byKey.keys()].sort();
  const out: Record<string, Resolved> = {};
  await pmap(
    keys,
    6,
    async (key) => {
      const g = byKey.get(key)!;
      const ov = overrides[key];
      if (!opts.refresh && prev[key] && !ov && prev[key].title === g.title) {
        out[key] = prev[key];
        return;
      }
      try {
        out[key] = await resolveOne(g, ov);
      } catch (err) {
        console.error(`\n${key}: ${err}`);
        out[key] = prev[key] ?? { key, title: g.title, platform: g.platform, alts: [], snaps: [], flags: ["error"] };
      }
    },
    progress("resolve", keys.length),
  );
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function resolveOne(g: Game, ov?: Override): Promise<Resolved> {
  const p = platformOf(g.platform);
  const systems = p.libretro ?? [];
  const wnames = wikiPlatformNames(p);
  const cands: Candidate[] = [];
  const r: Resolved = { key: g.artKey, title: g.title, platform: p.id, alts: [], snaps: [], flags: [] };

  const isPC = p.id === "Windows" || p.id === "MS-DOS";
  const modern = MODERN.has(p.id) || (p.id === "Windows" && (g.year ?? 2020) >= 2004);

  // Wikipedia: almost always useful (cover + year enrichment)
  const wp = ov?.wiki ? await wikipediaPage(ov.wiki) : await wikipedia(g.title, wnames, g.year);
  if (wp) cands.push(wp);

  // libretro box scans
  if (systems.length) {
    const lr = await libretro(systems, ov?.libretro ?? g.title, "Named_Boxarts");
    if (lr) cands.push(lr);
  }

  // Steam: PC + modern platforms (cover for PC, screenshots for everything modern)
  if (isPC || modern || ov?.steam) {
    const st = ov?.steam ? { appid: ov.steam, name: `app ${ov.steam}`, score: 1 } : await steamSearch(g.title);
    if (st && st.score >= ACCEPT) {
      r.steam = st;
      // Steam's portrait library art: primary for PC, fallback for consoles (many Wikipedia
      // infoboxes for indie games are wide Steam banners, which we reject)
      const url = await steamCover(st.appid);
      if (url) cands.push({ source: "steam", url, label: `Steam ${st.appid} — ${st.name}`, score: st.score, ref: String(st.appid) });
      const det = await steamDetails(st.appid);
      if (det) {
        r.snaps.push(...det.screenshots.slice(0, 3));
        if (!r.year && det.year) r.year = det.year;
      }
    }
  }

  // Retro gameplay: real screenshots + title screens
  if (systems.length) {
    const snap = await libretro(systems, ov?.libretro ?? g.title, "Named_Snaps");
    if (snap && snap.score >= ACCEPT) r.snaps.unshift(snap.url);
    const ts = await libretro(systems, ov?.libretro ?? g.title, "Named_Titles");
    if (ts && ts.score >= ACCEPT) r.titleScreen = ts.url;
  }
  if (ov?.snaps) r.snaps = ov.snaps;

  // --- pick the cover ----------------------------------------------------------------
  const pref = (c: Candidate): number => {
    // Source preference per platform, as a small bonus on top of match confidence
    if (c.source === "libretro") return modern ? 0.0 : 0.08;
    if (c.source === "steam") return p.id === "Windows" && modern ? 0.1 : -0.06;
    if (c.source === "wikipedia") return modern ? 0.05 : 0.02;
    return 0;
  };
  cands.sort((a, b) => b.score + pref(b) - (a.score + pref(a)));
  // an override naming a specific source wins outright
  const forced = ov?.wiki ? cands.find((c) => c.source === "wikipedia") : ov?.steam ? cands.find((c) => c.source === "steam") : ov?.libretro ? cands.find((c) => c.source === "libretro") : undefined;
  if (forced && ov?.cover === undefined) {
    r.cover = { ...forced, score: 1 };
  } else if (ov?.cover !== undefined) {
    if (ov.cover) r.cover = { source: "override", url: ov.cover, label: ov.note ?? "manual", score: 1 };
    else r.flags.push("forced-none");
  } else {
    const best = cands.find((c) => c.score >= ACCEPT) ?? cands.find((c) => c.score >= 0.76);
    if (best) r.cover = best;
    if (best && best.score < ACCEPT) r.flags.push("low-confidence");
    if (!best) r.flags.push("no-cover");
  }
  r.alts = cands.filter((c) => c !== r.cover).slice(0, 3);
  if (wp?.year && wp.score >= ACCEPT) r.year = wp.year;
  else if (r.year === undefined && g.year) r.year = g.year;
  return r;
}
