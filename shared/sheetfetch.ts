// Fetching Cooper's published Google Sheet as raw CSV text per tab. No parsing here (the Worker
// uses this and stays tiny + cheap on CPU; parsing happens in the browser, see sheet.ts).

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
