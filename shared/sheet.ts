// Fetch + parse Cooper's published Google Sheet into a normalized Library.
// Runs unchanged in the Cloudflare Worker, the browser (fallback) and Bun scripts.

import Papa from "papaparse";
import { platformOf, slugify } from "./platforms";
import type { ConsoleInfo, Game, Grade, Library, Status } from "./types";

export const PUB_ID = "2PACX-1vRWbWi3NOUWZ2N-NzbRXolc5v4474_91ViFmo5ZxY_cN1c_Szjuuhtrn416NawGVgcjVQoTSkLLEPdb";

/** Known tab gids (discovered from the pubhtml page; rediscovered if a fetch fails). */
export const DEFAULT_TABS: Record<TabName, string> = {
  Backlog: "243164480",
  Completed: "127587651",
  "Shopping List": "2136571350",
  Machinery: "2002846174",
};
export type TabName = "Backlog" | "Completed" | "Shopping List" | "Machinery";

const base = (pubId: string) => `https://docs.google.com/spreadsheets/d/e/${pubId}`;
export const tabCsvUrl = (pubId: string, gid: string) => `${base(pubId)}/pub?output=csv&single=true&gid=${gid}`;

/** Parse the pubhtml page to find tab names -> gids. */
export async function discoverTabs(pubId = PUB_ID, f: typeof fetch = fetch): Promise<Record<string, string>> {
  const html = await (await f(`${base(pubId)}/pubhtml`)).text();
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/\{name: "([^"]+)", pageUrl: "[^"]*", gid: "(\d+)"/g)) out[m[1]] = m[2];
  return out;
}

export async function fetchTabCsvs(pubId = PUB_ID, f: typeof fetch = fetch): Promise<Record<TabName, string>> {
  let tabs: Record<string, string> = { ...DEFAULT_TABS };
  const get = async (name: TabName) => {
    const res = await f(tabCsvUrl(pubId, tabs[name]));
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const text = await res.text();
    if (text.trimStart().startsWith("<")) throw new Error(`${name}: got HTML instead of CSV`);
    return text;
  };
  const names = Object.keys(DEFAULT_TABS) as TabName[];
  try {
    const csvs = await Promise.all(names.map(get));
    return Object.fromEntries(names.map((n, i) => [n, csvs[i]])) as Record<TabName, string>;
  } catch (err) {
    // Tabs may have been re-created (new gids). Rediscover and retry once.
    tabs = { ...tabs, ...(await discoverTabs(pubId, f)) };
    const csvs = await Promise.all(names.map(get));
    return Object.fromEntries(names.map((n, i) => [n, csvs[i]])) as Record<TabName, string>;
  }
}

export async function fetchLibrary(pubId = PUB_ID, f: typeof fetch = fetch): Promise<Library> {
  return parseLibrary(await fetchTabCsvs(pubId, f));
}

// ---------------------------------------------------------------------------

type Row = string[];

function rows(csv: string): Row[] {
  const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: false });
  return parsed.data.map((r) => r.map((c) => (c ?? "").trim()));
}

/** Find the header row (the first row containing a "Title" cell) and map column names -> index. */
function table(csv: string, marker = "title"): { header: Map<string, number>; body: Row[]; preamble: Row[] } {
  const all = rows(csv);
  const hi = all.findIndex((r) => r.some((c) => c.toLowerCase() === marker));
  if (hi < 0) return { header: new Map(), body: [], preamble: all };
  const header = new Map<string, number>();
  all[hi].forEach((c, i) => {
    const k = normKey(c);
    if (k && !header.has(k)) header.set(k, i);
  });
  return { header, body: all.slice(hi + 1), preamble: all.slice(0, hi) };
}

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function col(header: Map<string, number>, ...names: string[]): (r: Row) => string {
  for (const n of names) {
    const k = normKey(n);
    const exact = header.get(k);
    if (exact !== undefined) return (r) => r[exact] ?? "";
    for (const [hk, i] of header) if (hk.startsWith(k)) return (r) => r[i] ?? "";
  }
  return () => "";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "August 12, 1991" | "8/12/1991" | "1991" -> "1991-08-12" */
export function parseDate(s: string): string | undefined {
  s = s.trim();
  if (!s || s.startsWith("#")) return;
  let m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return iso(+m[3], mi + 1, +m[2]);
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return iso(+m[3], +m[1], +m[2]);
  m = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return iso(+m[2], mi + 1, 1);
  }
  m = s.match(/^(\d{4})$/);
  if (m) return iso(+m[1], 1, 1);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  return;
}
const iso = (y: number, mo: number, d: number) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const num = (s: string): number | undefined => {
  const v = parseFloat(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(v) ? v : undefined;
};
const yes = (s: string) => /^(y|yes|true|x|✓)$/i.test(s.trim());
const grade = (s: string): Grade | undefined => {
  const g = s.trim().toUpperCase();
  return (["A+", "A", "B", "C", "D", "F"] as const).find((x) => x === g);
};

export function parseLibrary(csvs: Record<TabName, string>): Library {
  const games: Game[] = [];
  const ids = new Set<string>();
  const add = (g: Omit<Game, "id" | "artKey">) => {
    const p = platformOf(g.platform);
    const artKey = `${p.slug}/${slugify(g.title)}`;
    const prefix = g.status === "wishlist" ? "w" : "g";
    let id = `${prefix}:${artKey}`;
    for (let n = 2; ids.has(id); n++) id = `${prefix}:${artKey}~${n}`;
    ids.add(id);
    games.push({ ...g, platform: p.id, id, artKey });
  };

  // --- Backlog --------------------------------------------------------------
  const bl = table(csvs.Backlog);
  {
    const h = bl.header;
    const title = col(h, "Title"), consoleC = col(h, "Console"), genre = col(h, "Genre"), dev = col(h, "Developer"),
      rel = col(h, "Release Date"), hrs = col(h, "Avg Completion Time", "Avg Completion"), pri = col(h, "Priority"),
      inProg = col(h, "In Progress"), done = col(h, "Completed");
    bl.body.forEach((r, row) => {
      const t = title(r);
      if (!t) return;
      const released = parseDate(rel(r));
      const status: Status = yes(done(r)) ? "completed" : yes(inProg(r)) ? "playing" : "backlog";
      add({
        title: t, platform: consoleC(r), genre: genre(r), developer: dev(r), released, year: released ? +released.slice(0, 4) : undefined,
        status, row, priority: num(pri(r)), hours: num(hrs(r)),
      });
    });
  }
  let sheetUpdated: string | undefined;
  for (const r of bl.preamble) for (const c of r) {
    const m = c.match(/last updated:\s*(.+)/i);
    if (m) sheetUpdated = parseDate(m[1]) ?? m[1];
  }

  // --- Completed --------------------------------------------------------------
  const cp = table(csvs.Completed);
  {
    const h = cp.header;
    const title = col(h, "Title"), consoleC = col(h, "Console"), genre = col(h, "Genre"), dev = col(h, "Developer"),
      rel = col(h, "Release Date"), doneOn = col(h, "Date of Completion"), gr = col(h, "Grade"),
      phys = col(h, "Own Physical Copy"), val = col(h, "Value"), notes = col(h, "Notes");
    cp.body.forEach((r, row) => {
      const t = title(r);
      if (!t) return;
      const released = parseDate(rel(r));
      add({
        title: t, platform: consoleC(r), genre: genre(r), developer: dev(r), released, year: released ? +released.slice(0, 4) : undefined,
        status: "completed", row, completedOn: parseDate(doneOn(r)), grade: grade(gr(r)), ownPhysical: yes(phys(r)),
        value: num(val(r)), review: notes(r) || undefined,
      });
    });
  }

  // --- Shopping list ----------------------------------------------------------
  const sl = table(csvs["Shopping List"]);
  {
    const h = sl.header;
    const title = col(h, "Title"), consoleC = col(h, "Console"), genre = col(h, "Genre"), dev = col(h, "Developer"),
      rel = col(h, "Release Date"), hrs = col(h, "Avg Completion"), pri = col(h, "Priority"), rar = col(h, "Rarity"),
      loose = col(h, "Loose Value"), cib = col(h, "CIB Value"), score = col(h, "Holistic Score");
    sl.body.forEach((r, row) => {
      const t = title(r);
      if (!t) return;
      const released = parseDate(rel(r));
      add({
        title: t, platform: consoleC(r), genre: genre(r), developer: dev(r), released, year: released ? +released.slice(0, 4) : undefined,
        status: "wishlist", row, hours: num(hrs(r)), priority: num(pri(r)), rarity: num(rar(r)), looseValue: num(loose(r)),
        cibValue: num(cib(r)), score: num(score(r)),
      });
    });
  }

  // --- Machinery: console list + release dates --------------------------------------
  const consoles: ConsoleInfo[] = [];
  const mach = rows(csvs.Machinery);
  const ci = mach[0]?.findIndex((c) => /console list/i.test(c)) ?? -1;
  if (ci >= 0) {
    for (const r of mach.slice(1)) {
      const name = r[ci];
      if (!name) continue;
      consoles.push({ platform: platformOf(name).id, released: parseDate(r[ci + 1] ?? "") });
    }
  }

  return { sheetUpdated, fetchedAt: new Date().toISOString(), games, consoles };
}
