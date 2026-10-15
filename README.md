# THE BACKLOG

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
`?quality=low|mid|high`, `?dpr=1.5`, `?level=showroom` (every form factor side by side),
`?no=...` (ablation flags, see Performance notes).

The Lab also shows **grade forecasts** for every unplayed game (`data/forecasts.json`, made by
`scripts/forecast`: a ridge regression on Cooper's 438 grades that gets within one grade 91% of
the time in backtests), plus findings about how his grades compare with crowd ratings. The
forecast also appears in each game's info panel.

## Run it

```sh
bun install
bun run dev        # http://localhost:5173 (Vite + the Worker running in workerd)
```

The processed art (`public/art`, ~350 MB of content-hashed webp) is committed, so a fresh clone
runs as-is. `bun run art` rebuilds it (only needed to bake newly added games in with full scans).

## Deploy (Cloudflare Workers + static assets, free plan)

Live at **https://the-backlog.games** (also https://the-backlog.m-b-forbes.workers.dev). `bun run deploy` (clean build +
`wrangler deploy`, using the scoped token in `.env.cloudflare-deploy`, which is gitignored).

It's set-and-forget: nothing needs re-running when the sheet changes.

- **Static files** (app bundles, art, audio) are content-hashed or versioned and served from
  Cloudflare's edge with `immutable`, year-long caching (`public/_headers`). Static requests
  are free and don't touch the Worker.
- **`GET /api/library`** fetches the sheet's tabs as raw CSV (no parsing in the Worker, so it
  stays well under the free plan's 10 ms CPU), caches them at the edge for 5 minutes, and serves
  stale while refreshing. The browser parses the CSV. The last good copy is also kept in Workers
  KV, so the site keeps working if Google is ever unreachable. Sheet edits show up within about
  5 minutes.
- **New games** (rows the art build hasn't seen) get covers at runtime: `GET /api/art` finds
  Wikipedia/Steam art once and stores the answer in KV forever. Not-found answers are retried
  weekly. `GET /api/img` fetches each image once and keeps the bytes in KV forever, so lookup
  work is never redone and found art is never lost. New games get generated platform-style
  spines and backs. Running `bun run art` + `bun run deploy` later bakes them in with full scans.
- **Editions:** add an optional `Edition` column to the Backlog/Completed tabs (e.g. "Greatest
  Hits", "Player's Choice", "Platinum Hits", "Nintendo Selects", "Collector's") and those games
  get the matching banner on their spine/back. Iconic special cartridges (gold Zelda carts,
  coloured Pokémon carts, the banana-yellow DK64) are built in.

Free-plan usage: one Worker request per visit (plus one per new-game cover), a handful of KV
writes per day at most, everything else is static.

## Performance notes

- Every world is built once into its own scene and kept alive. The others are prebuilt and their
  shaders compiled in the background after the first one appears, so switching is just the CRT
  animation. Background building waits while you're interacting (pointer, wheel, keys, camera
  moving, a game held) and only compiles in the idle time between frames. three's own compile
  loop yields with `scheduler.yield()`, which Chrome runs ahead of rendering, so an unpaced
  compile got a frame through only every 50-100 ms.
- All GPU pipelines are precompiled behind the loading bar, in parallel and in the same render
  context the frame uses. Materials share programs: constants are uniforms, one shared material
  serves the inspected game, and two serve every close-up cover overlay. Images decode off the
  main thread (ImageBitmap).
- `bun scripts/test/perf.ts [--url=...] [--device=phone] [--script=switch] [--trace=out.json]`
  drives the app on the real GPU (drag, scroll, zoom, hover, open/flip/close, stations, world
  switches). It reports frame times per action, stalls, any shader/node builds that happen at
  render time, and errors. Add `?no=prebuild,overlays,upgrade,audio` to the URL to ablate parts.

## Fast by default (quality governor)

Every device starts from a setting that should hold 60 fps anywhere: desktops at 1x
resolution, phones at 1.5x, small bloom, MSAA only where it's cheap (FXAA otherwise). A
governor (`src/engine/quality.ts`) then watches real frame times while you use the site:
- smooth frames (GPU headroom where the browser can measure it) → step up one notch: sharper
  resolution, nicer bloom, sharp close-up covers
- sustained slowness → step down: bloom, resolution, close-up detail, ambient effects, and
  decor at the next room switch
A knob that had to come down stays down for the visit, and the settled result is remembered per
device, so the next visit starts there. High-refresh screens (120/144 Hz) render every other
frame (aim for 60). Effects live on camera layer 1 and decor on layer 2, so one switch covers
every room.

An FPS meter sits top left (toggle in the `?` card). `?q=low|high`, `?dpr=`, `?msaa=0` and
`?nogov` override for testing.

## Performance test (`/profile`)

https://the-backlog.games/profile runs a ~1 minute hands-off test. It tours all three rooms
(moving, zooming, pulling a game out), then holds a view in each while switching effects off one
at a time. It uploads device and GPU details, load timings and per-step frame/CPU/GPU stats to
`/api/profile` (Workers KV). Read the results with:

```sh
bun scripts/profile/fetch.ts            # last 5 uploads, summarised (--local for the dev server, --raw for JSON)
```

## NEW! badges

The sheet has no date-added column, so browsers report game ids the Worker's registry
(`/api/seen`, KV) hasn't seen yet. The first report is the baseline. Games added, or moved from
the wishlist into the collection, within `NEW_DAYS` (a wrangler var, default 30; `?newdays=` to
preview) get:
- a pulsing rim in the room's colour, a NEW! sticker and a floating NEW! tag
- a "New · n" filter chip
- "NEW · added <date>" in their info panel

`?newtest=N` previews the look with N random games.

## The Vault (hidden)

Open it with the little safe on the den floor (by the vending machine) or `/vault`. It's behind a
password the Worker checks; the password is the `VAULT_PASSWORD` secret, never in the repo.
The collection's value is only served with the signed cookie that unlocks.

It shows:
- the estimated value, with the date it was valued
- value over time
- the most valuable games
- value by platform
- the six most valuable games on pedestals

Prices come from PriceCharting snapshots stored in KV (`vault:index`, `vault:snap:<date>`).
Each game is valued in its sheet "Condition" column (Loose / CIB / New / Graded / Box only /
Manual), or loose when there isn't one. A game with no price in that condition gets the cheapest
price it has. Backlog games on consoles are assumed physical unless an "Own Physical Copy?" column
says otherwise (they're marked * on the boards); PC games count as digital.

**To add a new valuation** (at most monthly), run the gentle, cached pricing script, check its
review file, then upload:

```sh
bun scripts/vault/price.ts --refresh --dry-run   # ~25-30 min; see scripts/vault/README.md
bun scripts/vault/price.ts --upload=both
```

It adds a dated snapshot, and the chart grows a point. Prices are never committed (the repo is
public).

## Sound + music

Interaction sounds and ambient loops are synthesized (Web Audio), except the Den's rain, which is
a public-domain recording ("Rain against the window", Wikimedia Commons). Each world has a very
soft background track (credited in the in-app controls card):

- Den: "Path Of The Fireflies" by AERØHEAD, CC BY-NC 3.0
- Stacks: "Lands" by Alex Productions, CC BY 3.0
- Lab: "Fragments" by AERØHEAD, CC BY-NC 3.0

Music powered by BreakingCopyright (https://breakingcopyright.com).

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
worker/      Cloudflare Worker: /api/library (raw sheet, edge-cached + KV fallback), /api/art + /api/img (KV-persisted)
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
