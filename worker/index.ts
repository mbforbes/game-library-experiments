// Cloudflare Worker: serves the static site (via assets) and a small API.
//   GET /api/library      -> normalized library JSON (edge-cached, stale-while-revalidate)
//   GET /api/img?u=<url>  -> image proxy for allow-listed art hosts (edge-cached for a week)
//   GET /api/art?platform=&title=&year=  -> cover art for a game the build-time pipeline hasn't
//        seen yet (new sheet rows), via Wikipedia + Steam; results cached at the edge

import { fetchLibrary } from "../shared/sheet";
import { configureArtIO, wikipedia, steamSearch, steamCover, type Candidate } from "../shared/artsources";
import { platformOf } from "../shared/platforms";

interface Env {
  ASSETS: Fetcher;
}

const LIBRARY_FRESH_S = 300; // serve from cache without revalidating for 5 min
const LIBRARY_STALE_S = 60 * 60 * 24 * 7; // after that, serve stale while refreshing in background

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
    if (url.pathname === "/api/library") return library(req, ctx, url.searchParams.has("fresh"));
    if (url.pathname === "/api/img") return img(req, ctx, url.searchParams.get("u") ?? "");
    if (url.pathname === "/api/art") return art(req, ctx, url.searchParams);
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

async function library(req: Request, ctx: ExecutionContext, forceFresh: boolean): Promise<Response> {
  const cache = caches.default;
  const key = new Request(new URL("/api/library?v=1", req.url).toString());
  const cached = forceFresh ? undefined : await cache.match(key);
  const refresh = async () => {
    const lib = await fetchLibrary();
    const body = JSON.stringify(lib);
    const res = new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${LIBRARY_STALE_S}`,
        "x-fetched-at": lib.fetchedAt,
      },
    });
    await cache.put(key, res.clone());
    return res;
  };

  if (cached) {
    const age = (Date.now() - Date.parse(cached.headers.get("x-fetched-at") ?? "0")) / 1000;
    if (age > LIBRARY_FRESH_S) ctx.waitUntil(refresh().catch(() => {}));
    return withClientCache(cached, age > LIBRARY_FRESH_S ? "stale" : "hit");
  }
  try {
    return withClientCache(await refresh(), "miss");
  } catch (err) {
    return json({ error: String(err) }, 502);
  }
}

function withClientCache(res: Response, state: string): Response {
  const out = new Response(res.body, res);
  // Browsers may reuse for a minute; the edge copy does the heavy lifting.
  out.headers.set("cache-control", "public, max-age=60");
  out.headers.set("x-cache", state);
  return out;
}

async function img(req: Request, ctx: ExecutionContext, target: string): Promise<Response> {
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
  const upstream = await fetch(u.toString(), { headers: { "user-agent": "CoopersGameLibrary/1.0 (personal fan project)" } });
  if (!upstream.ok) return json({ error: `upstream ${upstream.status}` }, 502);
  const res = new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      "cache-control": "public, max-age=604800, immutable",
      "access-control-allow-origin": "*",
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ---- runtime art for new games -------------------------------------------------------------

const ART_TTL = 60 * 60 * 24 * 30;
const MISS_TTL = 60 * 60 * 24 * 2;

async function art(req: Request, ctx: ExecutionContext, q: URLSearchParams): Promise<Response> {
  const platform = q.get("platform") ?? "", title = (q.get("title") ?? "").slice(0, 200), year = +(q.get("year") ?? 0) || undefined;
  if (!title) return json({ error: "title required" }, 400);
  const cache = caches.default;
  const key = new Request(new URL(`/api/art?v=1&p=${encodeURIComponent(platform)}&t=${encodeURIComponent(title.toLowerCase())}&y=${year ?? ""}`, req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  // lookups go through the edge cache too, so repeat visitors cost nothing
  configureArtIO({
    json: async (u: string) => {
      const k = new Request(new URL(`/api/_json?u=${encodeURIComponent(u)}`, req.url).toString());
      const c = await cache.match(k);
      if (c) return c.json();
      const r = await fetch(u, { headers: { "user-agent": "CoopersGameLibrary/1.0 (personal fan project)" } });
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
  const res = new Response(JSON.stringify(best ? { cover: best.url, source: best.source, score: +best.score.toFixed(2) } : { cover: null }), {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${best ? ART_TTL : MISS_TTL}`, "access-control-allow-origin": "*" },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
