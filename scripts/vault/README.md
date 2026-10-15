# Vault pricing

`price.ts` estimates what Cooper's physical games are worth on the market and stores the estimate
as a dated snapshot in Cloudflare KV. The password-protected Vault room reads it from there.

- **Source:** PriceCharting game pages (US prices). The script stores all six price points: loose,
  CIB, new, graded, box only and manual only.
- **What counts:** owned games (not wishlist). For completed games the sheet's "Own Physical Copy?"
  column decides. Backlog and playing games on consoles are assumed physical. PC, DOS, Arcade and
  MSX backlog entries count as digital and are excluded.
- **KV:** `vault:snap:<YYYY-MM-DD>` holds the snapshot and `vault:index` holds the per-date totals
  for the graph. Backups of both go in `.cache/vault/snapshots/` and `.cache/vault/index.json`.
- **Never commit prices.** The repo is public. Everything priced stays in `.cache/vault/`
  (gitignored) and in KV.

## Monthly update

```sh
bun scripts/vault/price.ts --refresh --dry-run   # refetch prices (~25-30 min), print totals + top 10
less .cache/vault/review.txt                     # spot-check: top 30, random 20, weakest matches, unpriced
bun scripts/vault/price.ts --upload=both         # no network (all cached): write remote + local KV
```

Each run adds a point to the value-over-time graph, because the snapshot date is the day the prices
were fetched. If a run is interrupted, re-run the same command and it carries on where it stopped.
Every page is cached in `.cache/vault/pages/`, and `--refresh` only refetches pages older than 20 h.

Other flags:
- `--only=<id>[,<id>]` resolves just those games and prints them, which is useful for testing an
  override.
- `--upload=local` writes only the dev server's KV (`wrangler kv key put --local`). `remote` writes
  only production, through the Cloudflare API using `.env.cloudflare-deploy`.
- `--allow-stale` uploads even when the cached prices span more than 7 days.

## Fixing matches

To pin a game to a PriceCharting page, add it to `overrides.json` as
`"<game id>": "https://www.pricecharting.com/game/<console>/<slug>"`. To leave a game out of the
total, map it to `null`. Game ids appear in `review.txt` and in the snapshot's `unpriced` list.

Why the current overrides exist:
- **PriceCharting names the game differently.** Examples: "Star Wars Rogue Leader", "007 Nightfire",
  "Major League Baseball Featuring Ken Griffey Jr", "Decap Attack", "Columns III: Revenge of
  Columns", "Microsoft Flight Simulator X", "Tiger Woods 2009 All-Play".
- **The only US physical release is a compilation or another edition.** Chrono Trigger [PS1] is on
  Final Fantasy Chronicles. Peace Walker [PS3] is on the MGS HD Collection. Heavy Rain [PS4] is on
  Heavy Rain & Beyond Two Souls. Resident Evil HD [PS4] is on the Origins Collection. Tomb Raider
  2013 [PS4] is the Definitive Edition. Helldivers [PS4] is the Super-Earth Ultimate Edition.
  Devil Engine is the Complete Edition. Gleylancer is the Retro-Bit Collector's Edition.
- **One disc holds two of Cooper's games**, so it is counted once and the other game is set to
  `null`. Metal Slug 4 & 5 is one PS2 disc. Galak-Z and Skulls of the Shogun share one PS4 disc.
- **The sheet has a mistake.** Red Dead Revolver is listed as PS1 but is PS2-only. "Forumla
  Legends" is a typo.

`.cache/vault/review.txt` lists the top 30 items, a random 20, the 25 weakest matches and every
unpriced game, with the reason it is unpriced. Read it after each run.

## Being polite to PriceCharting

The script sends one request at a time, at least 2 s apart plus jitter, with a descriptive
User-Agent, and backs off on 429 and 5xx responses. A 403 or a challenge page stops the run. If
that happens, wait and try later; don't work around it. The first full run took 828 requests
(45 min). A monthly `--refresh` needs about 1 request per priced game plus a re-search of the
unpriced ones, around 600 requests or 25-30 min.
