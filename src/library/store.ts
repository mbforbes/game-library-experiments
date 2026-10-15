// Client-side library: loads data (Worker API -> direct Google fallback -> last cached copy),
// holds selection + filter state, and notifies listeners.

import { fetchLibrary, parseLibrary } from "../../shared/sheet";
import { computeStats, type Stats } from "../../shared/stats";
import { platformOf } from "../../shared/platforms";
import type { Game, Library } from "../../shared/types";

export type Filter = "all" | "new" | "playing" | "backlog" | "completed" | "aplus" | "wishlist";

/** Games added to the sheet recently (see /api/seen). Kept here so the filter can see it. */
export const newGames = { ids: new Set<string>(), since: new Map<string, string>(), days: 30 };

export const FILTERS: { id: Filter; label: string; test: (g: Game) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "new", label: "New", test: (g) => newGames.ids.has(g.id) },
  { id: "playing", label: "Playing", test: (g) => g.status === "playing" },
  { id: "backlog", label: "Backlog", test: (g) => g.status === "backlog" || g.status === "playing" },
  { id: "completed", label: "Beaten", test: (g) => g.status === "completed" },
  { id: "aplus", label: "A+", test: (g) => g.grade === "A+" },
  { id: "wishlist", label: "Wishlist", test: (g) => g.status === "wishlist" },
];

type Listener = () => void;
const LS_KEY = "coopers-library-cache-v1";

export class LibraryStore {
  lib!: Library;
  games: Game[] = [];
  byId = new Map<string, Game>();
  stats!: Stats;
  selected: Game | null = null;
  filter: Filter = "all";
  query = "";
  source: "api" | "google" | "cache" = "api";
  private listeners = new Map<string, Set<Listener>>();

  async load(): Promise<void> {
    let lib: Library | null = null;
    try {
      const res = await fetch("/api/library", { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      // v2: the Worker sends the tabs as raw CSV (keeps it tiny on CPU); parse here
      lib = raw.tabs ? { ...parseLibrary(raw.tabs), fetchedAt: raw.fetchedAt } : raw;
      this.source = "api";
    } catch (err) {
      console.warn("library API unavailable, fetching sheet directly", err);
      try {
        lib = await fetchLibrary();
        this.source = "google";
      } catch (err2) {
        console.warn("sheet fetch failed, using cached copy", err2);
        try {
          const cached = localStorage.getItem(LS_KEY);
          if (cached) lib = JSON.parse(cached);
          this.source = "cache";
        } catch {}
      }
    }
    if (!lib) throw new Error("Could not load the library (no network and no cached copy).");
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(lib));
    } catch {}
    this.set(lib);
  }

  /**
   * "New" games: the sheet has no date-added column, so the Worker keeps a registry of when each
   * game was first seen (and first owned, for wishlist games that get bought). We report any
   * games it doesn't know yet, then mark those added within the last N days.
   */
  async loadNew() {
    const params = new URLSearchParams(location.search);
    try {
      const res = await fetch("/api/seen");
      if (!res.ok) return;
      let reg = (await res.json()) as { newDays: number; baseline: string | null; items: Record<string, { seen: string; owned?: string }> };
      const report = this.games
        .filter((g) => {
          const r = reg.items[g.id];
          return !r || (g.status !== "wishlist" && !r.owned);
        })
        .map((g) => ({ id: g.id, owned: g.status !== "wishlist" }));
      if (report.length) {
        const r2 = await fetch("/api/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: report }) });
        if (r2.ok) reg = await r2.json();
      }
      const days = params.has("newdays") ? +params.get("newdays")! : reg.newDays;
      newGames.days = days;
      newGames.ids.clear();
      newGames.since.clear();
      const cutoff = Date.now() - days * 864e5;
      for (const g of this.games) {
        const r = reg.items[g.id];
        const when = g.status === "wishlist" ? r?.seen : (r?.owned ?? r?.seen);
        if (!when || !reg.baseline || when <= reg.baseline) continue; // there from the start
        if (Date.parse(when) >= cutoff) {
          newGames.ids.add(g.id);
          newGames.since.set(g.id, when);
        }
      }
      // ?newtest=N: pretend N random owned games are new (to preview the look)
      const test = +(params.get("newtest") ?? 0);
      if (test > 0) {
        const pool = this.games.filter((g) => g.status !== "wishlist");
        for (let i = 0; i < test; i++) {
          const g = pool[(i * 7919 + 13) % pool.length];
          newGames.ids.add(g.id);
          newGames.since.set(g.id, new Date(Date.now() - i * 2 * 864e5).toISOString());
        }
      }
      this.emit("new");
    } catch {}
  }

  set(lib: Library) {
    this.lib = lib;
    this.games = lib.games;
    this.byId = new Map(lib.games.map((g) => [g.id, g]));
    this.stats = computeStats(lib);
    this.emit("data");
  }

  /** Games on a platform (owned unless includeWishlist), in the given order. */
  byPlatform(includeWishlist = false): Map<string, Game[]> {
    const m = new Map<string, Game[]>();
    for (const g of this.games) {
      if (!includeWishlist && g.status === "wishlist") continue;
      const arr = m.get(g.platform) ?? [];
      arr.push(g);
      m.set(g.platform, arr);
    }
    return new Map([...m.entries()].sort((a, b) => platformOf(a[0]).released.localeCompare(platformOf(b[0]).released)));
  }

  select(g: Game | null) {
    if (this.selected === g) return;
    this.selected = g;
    this.emit("select");
  }

  setFilter(f: Filter) {
    this.filter = f;
    this.emit("filter");
  }

  setQuery(q: string) {
    this.query = q;
    this.emit("filter");
  }

  /** Does this game pass the active filter + search? */
  matches(g: Game): boolean {
    const f = FILTERS.find((x) => x.id === this.filter)!;
    if (!f.test(g)) return false;
    if (this.query) {
      const q = this.query.toLowerCase();
      return g.title.toLowerCase().includes(q) || g.developer.toLowerCase().includes(q) || g.platform.toLowerCase() === q;
    }
    return true;
  }

  get filtering() {
    return this.filter !== "all" || !!this.query;
  }

  search(q: string, limit = 12): Game[] {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const scored: [number, Game][] = [];
    for (const g of this.games) {
      const t = g.title.toLowerCase();
      const i = t.indexOf(q);
      if (i >= 0) scored.push([i === 0 ? 0 : t[i - 1] === " " ? 1 : 2, g]);
      else if (g.developer.toLowerCase().includes(q)) scored.push([3, g]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].title.localeCompare(b[1].title));
    return scored.slice(0, limit).map((x) => x[1]);
  }

  on(ev: "data" | "select" | "filter" | "new", fn: Listener) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
    return () => this.listeners.get(ev)!.delete(fn);
  }
  private emit(ev: string) {
    for (const fn of this.listeners.get(ev) ?? []) fn();
  }
}
