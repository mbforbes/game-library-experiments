# Design notes

## The idea

A game library is a physical thing: boxes, carts, spines, shelves. Cooper's backlog is mostly
not physical (a spreadsheet), so we give every row a body: the right object for its platform,
with its real cover, a printed spine, and Cooper's grade stuck on it, and then put those objects
in places that couldn't exist.

Principles that held up while building the first draft:

- **The library itself stays orderly.** Each world has an obvious organizing idea you can read
  at a glance (by console, by year, by priority / grade). The strangeness lives around it.
- **Stats are architecture, not dashboards.** The results wall *is* the grade distribution; the
  tower's height *is* the timeline; the vending machine *is* the shopping list; the split-flap
  board *is* the in-progress list. Few numbers, in places where they're fun to find.
- **The data drives the room.** Bookcase counts, wall sizes and spiral lengths are computed from
  the sheet, so the worlds grow with the backlog.
- **One gesture model everywhere.** The camera browses a *rail* in front of the collection:
  drag/swipe to pan along it, pinch/wheel to zoom, tap to pull a game out. Same on phone and
  desktop, with jump-to stations for the big moves.

## What each world says

**Neon Den** is the cozy one, the room you'd want to own. Organized by console, launch order.
The impossible bits are small: the window can show other worlds (tap it), a Vic Viper flies through
on the Konami code (or 5 taps on the GAME DEN sign), a pixel cat patrols the bookcases, the hologram
turns gameplay screenshots into voxels.

**Infinite Stacks** treats the backlog as history. Organized by release year, so climbing is
travelling in time; the shelves never end in either direction (dusty pre-history below, ghostly
unwritten volumes above). Reviews become manuscript pages in the Codex. Lit only by the lantern
you carry, candles, and moonlight.

**Backlog Science** treats the backlog as an experiment that's going badly. Organized by status:
the queue (by Cooper's priority) and the results (by grade). The Archivist turns stats into
deadpan commentary ("At your current rate of 26 per year, testing concludes in 2047. I will wait.").

## Ideas for next worlds

- **Pokémon-style "PC Box" storage**: games as monsters in storage boxes (a box per platform),
  a Pokédex view with "seen / caught" = backlog / beaten, gym badges for platforms 100% beaten.
- **Orbit**: each console is a planet; its games form rings (sorted alphabetically), completed
  ones lit like cities on the night side; the wishlist is an asteroid belt.
- **Timeline Corridor**: an endless hallway whose decor changes era by era (arcade carpet →
  90s bedroom → 2000s dorm → modern), games along the walls by release year.
- **Museum of Grades**: a gallery wing per grade, A+ games under spotlights on plinths with
  museum placards (the review as the placard text).
- **Underwater / Atlantis archive**: shelves in a sunken library, the window effect inverted.

## Ideas for the existing worlds

- Gameplay *video* on screens (Steam trailers via HLS for modern games).
- Ambient sound (rain, CRT hum, arcade attract loops, tower wind), muted by default.
- A "today" ritual: the hologram picks a suggested next game from the queue (priority × length).
- Device-orientation parallax on phones; a gyroscope "peek" around shelves.
- Daily art refresh: a scheduled Worker that resolves art for newly added sheet rows into R2.
- LaunchBox games DB as a 4th art source (covers almost every remaining gap; ~100 MB dump).

## Known limitations of this draft

- Real-device performance on iPhones is untested (development used an M1 Mac at phone
  resolutions). Adaptive resolution steps down if frames are slow; `?quality=low` exists.
- 7 obscure DLC/bonus titles have no cover art anywhere; they show styled title cards.
- Physical-copy ownership is only tracked for beaten games in the sheet, so backlog items are all
  rendered as their platform's standard object (modern PC games are digital "slabs").
