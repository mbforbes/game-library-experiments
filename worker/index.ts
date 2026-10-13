// Cloudflare Worker: serves the static site (via assets) and a small API. Built to sit on the free
// plan untouched for years: tiny CPU per request, everything cached at the edge, and anything
// worth keeping (sheet snapshots, art lookups, art images) stored permanently in KV.
//
//   GET /api/library      -> the sheet's tabs as raw CSV text, ≤ 5 min old (the browser parses).
//                            If Google is down, the last good copy (kept in KV) is served.
//   GET /api/art?platform=&title=&year=  -> cover art for a game the build-time pipeline hasn't
//                            seen (new sheet rows), via Wikipedia + Steam. Looked up once, kept forever.
//   GET /api/img?u=<url>  -> image proxy for allow-listed art hosts. Fetched once, kept forever.

import { fetchTabCsvs } from "../shared/sheetfetch";
import { configureArtIO, wikipedia, steamSearch, steamCover, type Candidate } from "../shared/artsources";
import { platformOf } from "../shared/platforms";

interface Env {
  ASSETS: Fetcher;
  /** Permanent store: sheet snapshot, art lookups, art images (Workers KV, free tier). */
  STORE: KVNamespace;
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
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

// ---- library ---------------------------------------------------------------------------------

async function library(req: Request, env: Env, ctx: ExecutionContext, forceFresh: boolean): Promise<Response> {
  const cache = caches.default;
  const key = new Request(new URL("/api/library?v=2", req.url).toString());
  const cached = forceFresh ? undefined : await cache.match(key);
  const age = cached ? (Date.now() - Date.parse(cached.headers.get("x-fetched-at") ?? "0")) / 1000 : Infinity;
  if (cached && age <= LIBRARY_FRESH_S) return withClientCache(cached, "hit");

  const refresh = async (): Promise<Response> => {
    const tabs = await fetchTabCsvs();
    const fetchedAt = new Date().toISOString();
    const body = JSON.stringify({ v: 2, fetchedAt, tabs });
    const res = sheetResponse(body, fetchedAt);
    await cache.put(key, res.clone());
    // keep the latest good copy forever (only written when the sheet actually changed)
    const sig = String(await digest(JSON.stringify(tabs)));
    const prev = await env.STORE.get("sheet:sig");
    if (prev !== sig) {
      await env.STORE.put("sheet:last", body);
      await env.STORE.put("sheet:sig", sig);
    }
    return res;
  };

  if (cached) {
    // stale: answer instantly, refresh in the background
    ctx.waitUntil(refresh().catch(() => {}));
    return withClientCache(cached, "stale");
  }
  try {
    return withClientCache(await refresh(), "miss");
  } catch (err) {
    // Google unreachable and nothing at this edge: fall back to the permanent copy
    const last = await env.STORE.get("sheet:last");
    if (last) {
      const fetchedAt = (JSON.parse(last) as { fetchedAt: string }).fetchedAt;
      return withClientCache(sheetResponse(last, fetchedAt), "kv");
    }
    return json({ error: String(err) }, 502);
  }
}

function sheetResponse(body: string, fetchedAt: string) {
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=31536000",
      "x-fetched-at": fetchedAt,
    },
  });
}

function withClientCache(res: Response, state: string): Response {
  const out = new Response(res.body, res);
  // browsers may reuse it for a minute; the edge copy does the heavy lifting
  out.headers.set("cache-control", "public, max-age=60");
  out.headers.set("x-cache", state);
  return out;
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

// ---- util ------------------------------------------------------------------------------------

async function digest(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
