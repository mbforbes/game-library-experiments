// A small, fun set of stats computed from the library (the sheet's own Stats tab is
// formula output; recomputing keeps us independent of its layout).

import { platformOf } from "./platforms";
import { GRADES, GRADE_POINTS, type Game, type Grade, type Library } from "./types";

export interface PlatformStats {
  platform: string;
  total: number;
  completed: number;
  backlog: number; // includes playing
  playing: number;
  wishlist: number;
  pct: number; // 0..1
  avgGrade?: Grade;
  hours: number;
}

export interface Stats {
  total: number; // backlog + completed (wishlist excluded)
  completed: number;
  backlog: number; // not completed, includes playing
  playing: number;
  notStarted: number;
  pct: number;
  backlogHours: number;
  physicalOwned: number;
  valueOwned: number;
  grades: Record<Grade, number>;
  avgGrade?: Grade;
  wishlist: number;
  wishlistLoose: number;
  wishlistCib: number;
  platforms: PlatformStats[];
  recentlyCompleted: Game[];
  completionsByYear: { year: number; count: number }[];
  /** completions in the 365 days before the newest completion */
  pace: number;
  /** projected year the backlog is cleared at current pace */
  clearYear?: number;
  oldest?: Game;
  newest?: Game;
  topDeveloper?: { name: string; count: number };
  topGenre?: { name: string; count: number };
}

export function avgGradeOf(games: Game[]): Grade | undefined {
  const g = games.filter((x) => x.grade);
  if (!g.length) return;
  const avg = g.reduce((s, x) => s + GRADE_POINTS[x.grade!], 0) / g.length;
  // Same rounding as the sheet: nearest letter
  let best: Grade = "F";
  for (const k of GRADES) if (Math.abs(GRADE_POINTS[k] - avg) < Math.abs(GRADE_POINTS[best] - avg)) best = k;
  return best;
}

export function computeStats(lib: Library): Stats {
  const owned = lib.games.filter((g) => g.status !== "wishlist");
  const wish = lib.games.filter((g) => g.status === "wishlist");
  const done = owned.filter((g) => g.status === "completed");
  const back = owned.filter((g) => g.status !== "completed");
  const playing = back.filter((g) => g.status === "playing");

  const grades = Object.fromEntries(GRADES.map((g) => [g, 0])) as Record<Grade, number>;
  for (const g of done) if (g.grade) grades[g.grade]++;

  const byPlat = new Map<string, Game[]>();
  for (const g of lib.games) {
    const arr = byPlat.get(g.platform) ?? [];
    arr.push(g);
    byPlat.set(g.platform, arr);
  }
  const platforms: PlatformStats[] = [...byPlat.entries()]
    .map(([platform, gs]) => {
      const o = gs.filter((g) => g.status !== "wishlist");
      const c = o.filter((g) => g.status === "completed");
      return {
        platform,
        total: o.length,
        completed: c.length,
        backlog: o.length - c.length,
        playing: o.filter((g) => g.status === "playing").length,
        wishlist: gs.length - o.length,
        pct: o.length ? c.length / o.length : 0,
        avgGrade: avgGradeOf(c),
        hours: o.filter((g) => g.status !== "completed").reduce((s, g) => s + (g.hours ?? 0), 0),
      };
    })
    .sort((a, b) => platformOf(a.platform).released.localeCompare(platformOf(b.platform).released));

  const recentlyCompleted = done
    .filter((g) => g.completedOn)
    .sort((a, b) => b.completedOn!.localeCompare(a.completedOn!))
    .slice(0, 8);

  const byYear = new Map<number, number>();
  for (const g of done) if (g.completedOn) byYear.set(+g.completedOn.slice(0, 4), (byYear.get(+g.completedOn.slice(0, 4)) ?? 0) + 1);
  const completionsByYear = [...byYear.entries()].map(([year, count]) => ({ year, count })).sort((a, b) => a.year - b.year);

  let pace = 0;
  let clearYear: number | undefined;
  const latest = recentlyCompleted[0]?.completedOn;
  if (latest) {
    const cutoff = new Date(latest);
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const c = cutoff.toISOString().slice(0, 10);
    pace = done.filter((g) => g.completedOn && g.completedOn > c).length;
    if (pace > 0) clearYear = Math.ceil(+latest.slice(0, 4) + back.length / pace);
  }

  const dated = owned.filter((g) => g.released).sort((a, b) => a.released!.localeCompare(b.released!));
  const top = (key: (g: Game) => string) => {
    const m = new Map<string, number>();
    for (const g of owned) {
      const k = key(g);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    const [name, count] = [...m.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    return name ? { name, count: count! } : undefined;
  };

  return {
    total: owned.length,
    completed: done.length,
    backlog: back.length,
    playing: playing.length,
    notStarted: back.length - playing.length,
    pct: owned.length ? done.length / owned.length : 0,
    backlogHours: back.reduce((s, g) => s + (g.hours ?? 0), 0),
    physicalOwned: done.filter((g) => g.ownPhysical).length,
    valueOwned: done.reduce((s, g) => s + (g.value ?? 0), 0),
    grades,
    avgGrade: avgGradeOf(done),
    wishlist: wish.length,
    wishlistLoose: wish.reduce((s, g) => s + (g.looseValue ?? 0), 0),
    wishlistCib: wish.reduce((s, g) => s + (g.cibValue ?? 0), 0),
    platforms,
    recentlyCompleted,
    completionsByYear,
    pace,
    clearYear,
    oldest: dated[0],
    newest: dated[dated.length - 1],
    topDeveloper: top((g) => g.developer),
    topGenre: top((g) => g.genre),
  };
}
