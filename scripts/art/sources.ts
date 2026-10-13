// Art sources: libretro-thumbnails (retro box scans + real gameplay snaps),
// Wikipedia (platform box art from article infoboxes), Steam (clean key art + screenshots).

import { cachedJson, cachedText } from "./util";
import { baseTitle, norm, sim, yearHint } from "../../shared/match";


// --- libretro -------------------------------------------------------------------

const LR = "https://thumbnails.libretro.com";
type Kind = "Named_Boxarts" | "Named_Snaps" | "Named_Titles";
const indexCache = new Map<string, Promise<string[]>>();

async function lrIndex(system: string, kind: Kind): Promise<string[]> {
  const key = `${system}/${kind}`;
  if (!indexCache.has(key)) {
    indexCache.set(
      key,
      (async () => {
        const html = await cachedText(`${LR}/${encodeURIComponent(system)}/${kind}/`);
        if (!html) return [];
        const names: string[] = [];
        for (const m of html.matchAll(/<a href="([^"?][^"]*\.png)">/g)) names.push(decodeURIComponent(m[1]).replace(/\.png$/, ""));
        return names;
      })(),
    );
  }
  return indexCache.get(key)!;
}

const BAD_VARIANT = /\((beta|proto|demo|sample|pirate|unl|hack|aftermarket|kiosk|program|debug|playchoice|bootleg|vs\.)|PlayChoice|bootleg|\[(b|h|t|f|o)\d*\]|\(alt|\(rev [a-z]\)|virtual console|sega channel|disney classic|collection|genesis mini|mega drive mini|preview disc|limited edition preview|\(e3|switch online|tec ?toy/i;

function regionRank(name: string): number {
  const r = name.match(/\(([^)]*)\)/)?.[1] ?? "";
  if (/\bUSA\b/.test(r)) return 0;
  if (/\bWorld\b/.test(r)) return 1;
  if (/\bEurope\b/.test(r)) return 2;
  if (/\bJapan\b/.test(r)) return 4;
  return 3;
}

// libretro file names replace & * / : ` < > ? \ | " with "_"
const lrSafe = (s: string) => s.replace(/[&*/:`<>?\\|"]/g, "_");

export async function libretro(systems: string[], title: string, kind: Kind = "Named_Boxarts"): Promise<Candidate | null> {
  let best: (Candidate & { rank: number; tags: number }) | null = null;
  const want = baseTitle(title);
  for (const system of systems) {
    const names = await lrIndex(system, kind);
    for (const name of names) {
      const s = sim(want, name.replace(/_/g, " "));
      if (s < 0.8) continue;
      // odd variants (betas, Virtual Console, Sega Channel...) are penalized outright; among equal
      // matches prefer USA > World > Europe > other > Japan, then the plainest name (fewest tags)
      const score = s - (BAD_VARIANT.test(name) ? 0.15 : 0);
      const rank = regionRank(name);
      const tags = (name.match(/\([^)]*\)/g) ?? []).length;
      const better =
        !best ||
        score > best.score + 0.01 ||
        (Math.abs(score - best.score) <= 0.01 && (rank < best.rank || (rank === best.rank && tags < best.tags)));
      if (better) {
        best = { source: "libretro", url: `${LR}/${encodeURIComponent(system)}/${kind}/${encodeURIComponent(lrSafe(name))}.png`, label: `${system} › ${name}`, score, rank, tags, ref: name };
      }
    }
    if (best && best.score >= 0.98) break;
  }
  if (!best) return null;
  const { rank, tags, ...c } = best;
  void rank;
  void tags;
  return c;
}

// --- Wikipedia + Steam live in shared/artsources.ts (also used by the Worker) ---------------
import { configureArtIO, type Candidate } from "../../shared/artsources";
configureArtIO({ json: cachedJson });
export { wikipedia, wikipediaPage, steamSearch, steamCover, steamDetails } from "../../shared/artsources";
export type { Candidate };
export { norm };
