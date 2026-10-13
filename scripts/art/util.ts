// Small helpers for the art pipeline: disk-cached fetches, polite concurrency.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const ROOT = join(import.meta.dir, "../..");
export const CACHE = join(ROOT, ".cache/art");
export const UA = "CoopersGameLibrary/0.1 (personal fan project; https://github.com/)";

export const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** Per-host spacing so we stay well inside public API rate limits. */
const hostNext = new Map<string, number>();
const HOST_GAP: Record<string, number> = {
  "store.steampowered.com": 700,
  "api.steampowered.com": 250,
  "images.launchbox-app.com": 25,
  "en.wikipedia.org": 60,
  "thumbnails.libretro.com": 40,
};
async function pace(url: string) {
  const host = new URL(url).hostname;
  const gap = HOST_GAP[host] ?? 0;
  if (!gap) return;
  const now = Date.now();
  const next = Math.max(now, hostNext.get(host) ?? 0);
  hostNext.set(host, next + gap);
  if (next > now) await sleep(next - now);
}

export async function fetchRetry(url: string, init: RequestInit = {}, tries = 5): Promise<Response> {
  let wait = 2000;
  for (let i = 0; ; i++) {
    await pace(url);
    try {
      const res = await fetch(url, { ...init, headers: { "user-agent": UA, ...(init.headers ?? {}) } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (i >= tries - 1) throw err;
      await sleep(wait);
      wait *= 2;
    }
  }
}

/** Fetch text with a permanent disk cache (delete .cache/art/http to refresh). */
export async function cachedText(url: string, opts: { refresh?: boolean } = {}): Promise<string | null> {
  const file = join(CACHE, "http", sha(url) + ".txt");
  const f = Bun.file(file);
  if (!opts.refresh && (await f.exists())) {
    const t = await f.text();
    return t === "\u0000404" ? null : t;
  }
  const res = await fetchRetry(url);
  ensureDir(dirname(file));
  if (res.status === 404) {
    await Bun.write(file, "\u0000404");
    return null;
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  await Bun.write(file, text);
  return text;
}

export async function cachedJson<T = any>(url: string, opts: { refresh?: boolean } = {}): Promise<T | null> {
  const t = await cachedText(url, opts);
  return t === null ? null : (JSON.parse(t) as T);
}

/** Download a binary into the cache; returns the local path or null when missing. */
export async function download(url: string): Promise<string | null> {
  const ext = (url.split("?")[0].match(/\.(png|jpe?g|webp|gif)$/i)?.[1] ?? "img").toLowerCase();
  const file = join(CACHE, "img", sha(url) + "." + ext);
  const miss = file + ".404";
  if (await Bun.file(file).exists()) return file;
  if (await Bun.file(miss).exists()) return null;
  const res = await fetchRetry(url);
  ensureDir(dirname(file));
  if (!res.ok) {
    await Bun.write(miss, String(res.status));
    return null;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 200) {
    await Bun.write(miss, "tiny");
    return null;
  }
  await Bun.write(file, buf);
  return file;
}

/** Map with bounded concurrency. */
export async function pmap<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>, onProgress?: (done: number) => void): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
        onProgress?.(++done);
      }
    }),
  );
  return out;
}

export function progress(label: string, total: number) {
  let last = 0;
  return (done: number) => {
    const now = Date.now();
    if (done === total || now - last > 2000) {
      last = now;
      process.stdout.write(`\r${label}: ${done}/${total}   `);
      if (done === total) process.stdout.write("\n");
    }
  };
}
