// bun scripts/art/build-art.ts [--resolve-only] [--process-only] [--refresh]
//
// 1. Fetch the live sheet
// 2. Resolve covers/snaps for every game (cached; reuses art/resolved.json unless --refresh)
// 3. Download + process into public/art (atlases, covers, snaps, manifest)

import { join } from "node:path";
import { fetchLibrary } from "../../shared/sheet";
import { processAll } from "./process";
import { resolveAll, type Override, type Resolved } from "./resolve";
import { ROOT } from "./util";

const args = new Set(process.argv.slice(2));
const RESOLVED = join(ROOT, "art/resolved.json");
const OVERRIDES = join(ROOT, "art/overrides.json");

const lib = await fetchLibrary();
console.log(`library: ${lib.games.length} entries`);

const overrides: Record<string, Override> = (await Bun.file(OVERRIDES).exists()) ? await Bun.file(OVERRIDES).json() : {};
const prev: Record<string, Resolved> = (await Bun.file(RESOLVED).exists()) ? await Bun.file(RESOLVED).json() : {};

let resolved = prev;
if (!args.has("--process-only")) {
  resolved = await resolveAll(lib.games, overrides, prev, { refresh: args.has("--refresh") });
  await Bun.write(RESOLVED, JSON.stringify(resolved, null, 1));
  const vals = Object.values(resolved);
  const count = (f: string) => vals.filter((r) => r.flags.includes(f)).length;
  const bySrc: Record<string, number> = {};
  for (const r of vals) if (r.cover) bySrc[r.cover.source] = (bySrc[r.cover.source] ?? 0) + 1;
  console.log(`resolved ${vals.length}: covers by source`, bySrc, `| no-cover ${count("no-cover")} | low-confidence ${count("low-confidence")} | with snaps ${vals.filter((r) => r.snaps.length).length}`);
}
if (!args.has("--resolve-only")) {
  const owned = new Set(lib.games.filter((g) => g.status !== "wishlist").map((g) => g.artKey));
  const m = await processAll(resolved, owned);
  console.log(`manifest ${m.version}: ${Object.keys(m.games).length} games, ${m.atlas.hi.length} atlas pages`);
}
