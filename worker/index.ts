// Cloudflare Worker: serves the static site (via assets) and a small API. Built to sit on the free
// plan untouched for years: tiny CPU per request, everything cached at the edge, and anything
// worth keeping (sheet snapshots, art lookups, art images) stored permanently in KV.
//
//   GET /api/library      -> the sheet's tabs as raw CSV text, ≤ 5 min old (the browser parses).
//                            If Google is down, the last good copy (kept in KV) is served.
//   GET /api/art?platform=&title=&year=  -> cover art for a game the build-time pipeline hasn't
//                            seen (new sheet rows), via Wikipedia + Steam. Looked up once, kept forever.
//   GET /api/img?u=<url>  -> image proxy for allow-listed art hosts. Fetched once, kept forever.
//   GET/POST /api/seen    -> when each game was first seen / first owned (drives "NEW!" badges)
//   POST /api/vault/unlock, GET /api/vault/data -> the password-protected collection value
//   POST /api/profile     -> performance test results from the profiler room (kept in KV)

import { fetchTabCsvs } from "../shared/sheetfetch";
import { configureArtIO, wikipedia, steamSearch, steamCover, type Candidate } from "../shared/artsources";
import { platformOf } from "../shared/platforms";

interface Env {
  ASSETS: Fetcher;
  /** Permanent store: sheet snapshot, art lookups, art images (Workers KV, free tier). */
  STORE: KVNamespace;
  /** Days a newly added game counts as "new" (wrangler.jsonc vars). */
  NEW_DAYS?: string;
  /** The vault password (secret) and the key that signs vault cookies (secret). */
  VAULT_PASSWORD?: string;
  VAULT_KEY?: string;
}

const UA = "TheBacklog/1.0 (personal fan project)";
const LIBRARY_FRESH_S = 300; // refresh from Google at most every 5 minutes
const FOREVER = "public, max-age=31536000, immutable";
const MISS_RETRY_S = 60 * 60 * 24 * 7; // a cover that wasn't found is looked for again after a week

const IMG_HOSTS = [
  "upload.wikimedia.org",
  "shared.steamstatic.com",
  "shared.akamai.steamstatic.com",
  "shared.cloudflare.steamstatic.com",
  "cdn.cloudflare.steamstatic.com",
  "thumbnails.libretro.com",
];

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/library") return library(req, env, ctx, url.searchParams.has("fresh"));
    if (url.pathname === "/api/img") return img(req, env, ctx, url.searchParams.get("u") ?? "");
    if (url.pathname === "/api/art") return art(req, env, ctx, url.searchParams);
    if (url.pathname === "/api/seen") return seen(req, env);
    if (url.pathname === "/api/vault/unlock") return vaultUnlock(req, env);
    if (url.pathname === "/api/vault/lock") return vaultLock();
    if (url.pathname === "/api/vault/data") return vaultData(req, env, url.searchParams);
    if (url.pathname === "/api/profile") return profile(req, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

// ---- library ---------------------------------------------------------------------------------

async function library(req: Request, env: Env, ctx: ExecutionContext, forceFresh: boolean): Promise<Response> {
  // KV is the cache (the Cache API is a no-op on *.workers.dev): the latest snapshot is served
  // straight from KV, and refreshed from Google in the background when it's > 5 minutes old.
  void req;
  const [last, checked] = await Promise.all([
    env.STORE.getWithMetadata<{ fetchedAt: string; sig: string }>("sheet:last", { cacheTtl: 60 }),
    env.STORE.get("sheet:checked", { cacheTtl: 60 }),
  ]);
  const body = last.value;
  const age = (Date.now() - Date.parse(checked ?? last.metadata?.fetchedAt ?? "0")) / 1000;

  const refresh = async (): Promise<string> => {
    const tabs = await fetchTabCsvs();
    const fetchedAt = new Date().toISOString();
    const fresh = JSON.stringify({ v: 2, fetchedAt, tabs });
    const sig = await digest(JSON.stringify(tabs));
    const writes: Promise<unknown>[] = [env.STORE.put("sheet:checked", fetchedAt)];
    // the snapshot itself is only rewritten when the sheet actually changed
    if (sig !== last.metadata?.sig) writes.push(env.STORE.put("sheet:last", fresh, { metadata: { fetchedAt, sig } }));
    await Promise.all(writes);
    return fresh;
  };

  if (body && !forceFresh) {
    if (age > LIBRARY_FRESH_S) ctx.waitUntil(refresh().catch(() => {}));
    return sheetResponse(body, last.metadata?.fetchedAt ?? "", age > LIBRARY_FRESH_S ? "stale" : "hit");
  }
  try {
    const fresh = await refresh();
    return sheetResponse(fresh, "", "miss");
  } catch (err) {
    if (body) return sheetResponse(body, last.metadata?.fetchedAt ?? "", "fallback");
    return json({ error: String(err) }, 502);
  }
}

function sheetResponse(body: string, fetchedAt: string, state: string) {
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // browsers may reuse it for a minute
      "cache-control": "public, max-age=60",
      "x-fetched-at": fetchedAt,
      "x-cache": state,
    },
  });
}

// ---- image proxy -----------------------------------------------------------------------------

async function img(req: Request, env: Env, ctx: ExecutionContext, target: string): Promise<Response> {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return json({ error: "bad url" }, 400);
  }
  if (u.protocol !== "https:" || !IMG_HOSTS.includes(u.hostname)) return json({ error: "host not allowed" }, 403);
  const cache = caches.default;
  const key = new Request(new URL(`/api/img?u=${encodeURIComponent(u.toString())}`, req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const kvKey = `img:${await digest(u.toString())}`;
  const stored = await env.STORE.getWithMetadata<{ type: string }>(kvKey, "arrayBuffer");
  let res: Response;
  if (stored.value) {
    res = imageResponse(stored.value, stored.metadata?.type ?? "image/jpeg");
  } else {
    const upstream = await fetch(u.toString(), { headers: { "user-agent": UA } });
    if (!upstream.ok) return json({ error: `upstream ${upstream.status}` }, 502);
    const type = upstream.headers.get("content-type") ?? "image/jpeg";
    const bytes = await upstream.arrayBuffer();
    if (!type.startsWith("image/")) return json({ error: "not an image" }, 502);
    // keep it forever (KV values can be up to 25 MiB; covers are ~100-500 KB)
    if (bytes.byteLength < 20_000_000) ctx.waitUntil(env.STORE.put(kvKey, bytes, { metadata: { type } }));
    res = imageResponse(bytes, type);
  }
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

const imageResponse = (bytes: ArrayBuffer, type: string) =>
  new Response(bytes, { headers: { "content-type": type, "cache-control": FOREVER, "access-control-allow-origin": "*" } });

// ---- runtime art for new games ---------------------------------------------------------------

async function art(req: Request, env: Env, ctx: ExecutionContext, q: URLSearchParams): Promise<Response> {
  const platform = q.get("platform") ?? "", title = (q.get("title") ?? "").slice(0, 200), year = +(q.get("year") ?? 0) || undefined;
  if (!title) return json({ error: "title required" }, 400);
  const id = `${platform}|${title.toLowerCase()}|${year ?? ""}`;
  const cache = caches.default;
  const key = new Request(new URL(`/api/art?v=2&k=${encodeURIComponent(id)}`, req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const kvKey = `art:${id}`;
  const stored = await env.STORE.get(kvKey);
  if (stored) {
    const res = artResponse(stored, !JSON.parse(stored).cover);
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }

  // lookups go through the edge cache too, so a retry costs nothing upstream
  configureArtIO({
    json: async (u: string) => {
      const k = new Request(new URL(`/api/_json?u=${encodeURIComponent(u)}`, req.url).toString());
      const c = await cache.match(k);
      if (c) return c.json();
      const r = await fetch(u, { headers: { "user-agent": UA } });
      if (!r.ok) return null;
      const body = await r.text();
      ctx.waitUntil(cache.put(k, new Response(body, { headers: { "cache-control": "public, max-age=604800", "content-type": "application/json" } })));
      return JSON.parse(body);
    },
  });
  const p = platformOf(platform);
  const pc = p.family === "pc";
  const cands: Candidate[] = [];
  try {
    const wp = await wikipedia(title, [p.name, p.short], year);
    if (wp) cands.push({ ...wp, score: wp.score + (pc ? 0 : 0.05) });
    const st = await steamSearch(title);
    if (st && st.score >= 0.85) {
      const url = await steamCover(st.appid);
      if (url) cands.push({ source: "steam", url, label: st.name, score: st.score + (pc ? 0.1 : -0.06) });
    }
  } catch {}
  cands.sort((a, b) => b.score - a.score);
  const best = cands.find((c) => c.score >= 0.85);
  const body = JSON.stringify(best ? { cover: best.url, source: best.source, score: +best.score.toFixed(2), at: new Date().toISOString() } : { cover: null, at: new Date().toISOString() });
  // found: kept forever. Not found: remembered for a week, then looked for again.
  ctx.waitUntil(env.STORE.put(kvKey, body, best ? undefined : { expirationTtl: MISS_RETRY_S }));
  const res = artResponse(body, !best);
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

const artResponse = (body: string, miss: boolean) =>
  new Response(body, {
    headers: { "content-type": "application/json", "cache-control": miss ? "public, max-age=86400" : FOREVER, "access-control-allow-origin": "*" },
  });

// ---- "new" games: first-seen / first-owned dates ---------------------------------------------
// The sheet has no "date added" column, so the site keeps its own registry. Browsers parse the
// sheet anyway; when one sees game ids the registry doesn't know yet it reports them here (a
// handful of tiny KV writes, only when the sheet gains games). The very first report becomes the
// baseline: everything already in the sheet then is "old".

interface SeenRegistry {
  baseline: string;
  items: Record<string, { seen: string; owned?: string }>;
}
const SEEN_KEY = "seen:v1";
const ID_RE = /^g:[a-z0-9-]{1,40}\/[a-z0-9~-]{1,120}$/;

async function seen(req: Request, env: Env): Promise<Response> {
  const newDays = Math.max(1, +(env.NEW_DAYS ?? 30) || 30);
  const reg = (await env.STORE.get<SeenRegistry>(SEEN_KEY, { type: "json", cacheTtl: 60 })) ?? null;
  if (req.method === "GET") {
    return new Response(JSON.stringify({ newDays, baseline: reg?.baseline ?? null, items: reg?.items ?? {} }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
    });
  }
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: { items?: { id: string; owned?: boolean }[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const now = new Date().toISOString();
  const next: SeenRegistry = reg ? { baseline: reg.baseline, items: { ...reg.items } } : { baseline: now, items: {} };
  let changed = !reg;
  for (const it of (body.items ?? []).slice(0, 3000)) {
    if (typeof it?.id !== "string" || !ID_RE.test(it.id)) continue;
    const cur = next.items[it.id];
    if (!cur) {
      if (Object.keys(next.items).length >= 8000) break; // sanity cap
      next.items[it.id] = it.owned ? { seen: now, owned: now } : { seen: now };
      changed = true;
    } else if (it.owned && !cur.owned) {
      // a wishlist game moved into the collection: acquired now
      cur.owned = now;
      changed = true;
    }
  }
  if (changed) await env.STORE.put(SEEN_KEY, JSON.stringify(next));
  return json({ ok: true, newDays, baseline: next.baseline, items: next.items });
}

// ---- the vault -----------------------------------------------------------------------------
// Server-checked password (a Worker secret, never in the repo) -> an HMAC-signed, HttpOnly cookie
// scoped to /api/vault. The collection value is only ever served with that cookie.

const VAULT_COOKIE = "vault";
const VAULT_DAYS = 30;

async function hmac(keyText: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const normPass = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function sameText(a: string, b: string) {
  // constant-time-ish compare
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

async function vaultUnlock(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!env.VAULT_PASSWORD || !env.VAULT_KEY) return json({ ok: false, error: "vault not configured" }, 503);
  let pw = "";
  try {
    pw = String(((await req.json()) as { password?: string }).password ?? "").slice(0, 200);
  } catch {}
  if (!sameText(normPass(pw), normPass(env.VAULT_PASSWORD))) {
    await new Promise((r) => setTimeout(r, 700)); // slow down guessing
    return json({ ok: false }, 401);
  }
  const exp = Date.now() + VAULT_DAYS * 864e5;
  const payload = `v1.${exp}`;
  const token = `${payload}.${await hmac(env.VAULT_KEY, payload)}`;
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": `${VAULT_COOKIE}=${token}; Path=/api/vault; Max-Age=${VAULT_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`,
    },
  });
}

function vaultLock(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json", "set-cookie": `${VAULT_COOKIE}=; Path=/api/vault; Max-Age=0; HttpOnly; Secure; SameSite=Strict` },
  });
}

async function vaultAuthed(req: Request, env: Env): Promise<boolean> {
  if (!env.VAULT_KEY) return false;
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)vault=([^;]+)/);
  if (!m) return false;
  const [v, exp, sig] = m[1].split(".");
  if (v !== "v1" || !exp || !sig || +exp < Date.now()) return false;
  return sameText(sig, await hmac(env.VAULT_KEY, `${v}.${exp}`));
}

async function vaultData(req: Request, env: Env, q: URLSearchParams): Promise<Response> {
  if (!(await vaultAuthed(req, env))) return json({ ok: false, locked: true }, 401);
  const index = (await env.STORE.get<{ date: string }[]>("vault:index", "json")) ?? [];
  const date = q.get("date") ?? index[index.length - 1]?.date;
  const snapshot = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? await env.STORE.get(`vault:snap:${date}`, "json") : null;
  return new Response(JSON.stringify({ ok: true, index, snapshot }), { headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}

// ---- profiler uploads ------------------------------------------------------------------------

async function profile(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const text = await req.text();
  if (text.length > 400_000) return json({ ok: false, error: "too big" }, 413);
  try {
    JSON.parse(text);
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }
  const id = `${new Date().toISOString()}-${crypto.randomUUID().slice(0, 8)}`;
  await env.STORE.put(`profile:${id}`, text, { metadata: { ua: (req.headers.get("user-agent") ?? "").slice(0, 200), country: (req as any).cf?.country ?? "" } });
  return json({ ok: true, id });
}

// ---- util ------------------------------------------------------------------------------------

async function digest(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
