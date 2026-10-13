# Cooper's Library

Cooper's video game backlog (a published Google Sheet: 973 games, 438 reviews, a 351-game shopping
list) rendered as places you can wander around: every game is a 3D cartridge / case / big box /
digital slab with its real cover art, shelved in a world that's slightly impossible.

Three worlds so far (switch from the title button, or `?level=`):

| level | what it is |
| --- | --- |
| `den` | **The Neon Den**: late-night game room. Console bookcases by launch order, PC wall (90s big boxes + glowing digital slabs), cartridge vault, arcade cabinets playing real gameplay, a holo-table that voxelizes the selected game, the Want-O-Matic wishlist vending machine, a split-flap NOW PLAYING board, an LED stats ticker, and an impossible window. |
| `stacks` | **The Infinite Stacks**: a stone tower where the library spirals upward through time (1971 at the bottom, today at the top). Endless tomes above and below, the wishlist circling overhead as flying books, the Codex showing reviews in calligraphy. |
| `lab` | **Backlog Science**: clinical test chambers. The queue wall (by priority), the results wall (sorted by grade, so the lights form a bar chart), live portals between chambers, and a deadpan AI with opinions. |

Everywhere: every game is its real-world object with full retail branding: real box fronts,
real spine scans, real back covers (flip a game over), real cartridge photos (gold Zelda carts
included), Cooper's grade stickers on every spine, and generated platform-style spines/backs where
no scan exists. Synthesized sound throughout (interaction SFX + positional ambience: arcade
chiptunes, rain, neon hum, candles, portal drones…; mute button top-right). Effects: neon
power-on, CRT transitions between worlds, glossy reflections, pull-off-the-shelf animation,
hover lift + titles (desktop), particles, page turns.

Debug helpers: `?debug` (FPS / draw calls / pixel ratio), `?webgl` (force the WebGL2 backend),
`?quality=low|mid|high`, `?dpr=1.5`, `?level=showroom` (every form factor side by side).

## Run it

```sh
bun install
bun run art        # first time: resolve + download + process cover art (≈10 min, cached after)
bun run dev        # http://localhost:5173 (Vite + the Worker running in workerd)
```

Without `bun run art` everything still works; games just get procedural title-card covers.

## Deploy (Cloudflare Workers + static assets)

```sh
bunx wrangler login   # once
bun run deploy        # vite build + wrangler deploy
```

- Static files (app bundle, `public/art/**`) are served from Cloudflare's edge. Content-hashed
  files are cached forever (`public/_headers`); the art manifest revalidates every 5 minutes.
- `GET /api/library` (the Worker) fetches the sheet's tabs, parses them and caches the JSON at
  the edge for 5 minutes, then serves stale while refreshing in the background, so the site follows
  the sheet without hammering Google. `?fresh` bypasses the cache. If the API is unreachable the
  client fetches the sheet directly, and failing that uses its last copy.
- **New games added to the sheet:** the library data is fetched live (≤5 min old), so new rows
  appear on the next visit. Covers for games the art build hasn't seen are resolved at runtime:
  the Worker's `GET /api/art` finds Wikipedia/Steam art (cached at the edge for 30 days) and the
  client paints it over the placeholder title card, all automatically. Re-run `bun run art` +
  `bun run deploy` now and then to bake new games into the atlases with full scans (spines,
  backs, cart photos) and the faster first load.
- **Editions:** add an optional `Edition` column to the Backlog/Completed tabs (e.g. "Greatest
  Hits", "Player's Choice", "Platinum Hits", "Nintendo Selects", "Collector's") and those games
  get the matching banner on their spine/back. Iconic special cartridges (gold Zelda carts,
  coloured Pokémon carts, the banana-yellow DK64) are built in.

## Cover art pipeline (`scripts/art`)

1. **Resolve**: each (platform, title) is matched against libretro-thumbnails (retro box scans +
   real gameplay screenshots + title screens), Wikipedia (infobox covers), Steam (portrait
   library art + screenshots) and the LaunchBox Games DB (real NA retail scans: box fronts,
   spines, backs, cartridge photos, discs, clear logos, plus ESRB ratings and publishers; the
   ~110 MB metadata dump is downloaded once into `.cache/`). Fuzzy title matching is number-aware (sequels don't match),
   region-aware (USA boxes preferred) and rejects banners, logos and placeholder art. Results go
   to `art/resolved.json` (committed: the record of which image belongs to which game).
2. **Overrides**: `art/overrides.json` pins a specific `cover` URL, Wikipedia page, Steam app,
   libretro name or LaunchBox entry (`lb: <id>`, or `lb: null` to skip LaunchBox) for anything
   the matcher gets wrong. Every one of the 1,304 covers was reviewed
   by eye from contact sheets; 107 are pinned here.
3. **Process**: downloads (cached in `.cache/`), then writes web-ready covers, backs, spines,
   cartridge photos, logos, discs and snaps (webp), and packs every cover + cart photo into
   atlases and every real spine into a spine atlas, each at two tiers (2048² for phones / first
   paint, 4096² for desktop). Writes `public/art/manifest.json`.
4. **Review**: `bun run art:review` renders `art/review/sheet-NN.jpg` contact sheets (title,
   platform, source, confidence; red frame = flagged). `--flagged` or `--keys=file` narrows it;
   `--lb` shows front | spine | back | cart side by side to check LaunchBox matches.

## Code map

```
shared/      data model, sheet fetch+parse, stats, platform registry (used by Worker, client, scripts)
worker/      Cloudflare Worker: /api/library (edge-cached), /api/img proxy
scripts/art  cover art pipeline        scripts/test  Playwright screenshots + perf (shot.ts, montage.ts)
src/
  app.ts            wires everything: data, art, renderer, rig, input, HUD, inspect, levels
  engine/           WebGPU renderer + bloom/post + adaptive resolution, Rail + CameraRig, input, inspect mode
  library/          client data store (filters, search, selection), art store (atlases, hi-res LRU)
  audio/            Web Audio engine (positional emitters, room reverb) + synthesized SFX/loops
  media/            ★ the reusable core: game → 3D object
    templates.ts      real-world form factors (NES/SNES/N64/GB/GBA/GG/MSX carts, HuCards, Genesis
                      clamshells, CD jewel cases, DVD/Blu-ray/Switch/DS cases, PC big boxes, digital
                      slabs, mini arcade cabinets)
    field.ts          MediaField: any set of placed games, ~1 draw call per form factor, per-game
                      cover crop / spine / glow / highlight / dim, fast picking, hi-res overlays up close
    spines.ts         spines: real scans, or printed in each platform's retail style
    branding.ts       platform wordmarks, ESRB boxes, edition banners, special cartridge shells
    stickers.ts       Cooper's grade / now-playing stickers (decals on spines and cart corners)
    hero.ts           the inspected game: real front/spine/back scans (or branded generated ones)
  world/            reusable world-building: shelf packing, furniture, neon, displays (dot-matrix,
                    split-flap, LED panels), CRT screens, hologram, vending machine, medieval + lab kits
  levels/           one folder per world; each implements the Level interface (levels/types.ts)
```

### Adding a world

Create `src/levels/<name>/<name>.ts` exporting a factory that returns a `Level`, and register it
in `src/levels/index.ts`. A level builds its scene, places games with `MediaField` (usually via
`packShelves`), supplies a camera `Rail` (the path the camera browses: drag/swipe to pan,
pinch/wheel to zoom), and lists `stations` (jump points). Inspect mode, search, filters, art,
spines and the HUD come for free.
