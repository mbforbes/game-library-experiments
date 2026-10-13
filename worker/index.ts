// Cloudflare Worker: serves the static site (via assets) and a small API.
//   GET /api/library      -> normalized library JSON (edge-cached, stale-while-revalidate)
//   GET /api/img?u=<url>  -> image proxy for allow-listed art hosts (edge-cached for a week)

import { fetchLibrary } from "../shared/sheet";

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
