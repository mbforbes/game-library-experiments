// Download + process resolved art into web-ready assets:
//   public/art/covers/*.webp   hi-res covers (inspect view), content-hashed names
//   public/art/snaps/*.webp    gameplay screenshots / title screens
//   public/art/atlas-*.webp    all covers packed into 2 atlas tiers (hi 4096², lo 2048²)
//   public/art/manifest.json   artKey -> atlas rect, files, colour, year

import sharp from "sharp";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { Resolved } from "./resolve";
import { download, ensureDir, pmap, progress, ROOT, sha } from "./util";

export const OUT = join(ROOT, "public/art");
const ATLAS = 4096;
const CELL_H = 176; // thumb height in the hi atlas (lo atlas is exactly half)
const GUT = 4; // extruded gutter on each side (keeps mipmaps from bleeding)
const COVER_MAX = 640;
const SNAP_MAX_W = 480;

export interface ArtEntry {
  /** atlas page + normalized rect [page, u, v, w, h] (v from top) */
  a?: [number, number, number, number, number];
  /** hi-res cover file (relative to /art/) and its pixel size */
  c?: string;
  w?: number;
  h?: number;
  /** dominant colour */
  col?: string;
  /** gameplay snaps and title screen (relative to /art/) */
  s?: string[];
  t?: string;
  /** snaps are low-res pixel art: render with nearest filtering */
  px?: 1;
  /** release year enrichment */
  y?: number;
  /** art source for the cover */
  src?: string;
}

export interface Manifest {
  version: string;
  atlas: { hi: string[]; lo: string[]; size: number };
  games: Record<string, ArtEntry>;
}

const fileBase = (key: string) => key.replace(/\//g, "__");

async function coverInput(url: string): Promise<string | null> {
  let f = await download(url);
  if (!f && url.includes("library_600x900_2x")) f = await download(url.replace("_2x", ""));
  return f;
}

export async function processAll(resolved: Record<string, Resolved>): Promise<Manifest> {
  rmSync(OUT, { recursive: true, force: true });
  ensureDir(join(OUT, "covers"));
  ensureDir(join(OUT, "snaps"));
  const keys = Object.keys(resolved);
  const games: Record<string, ArtEntry> = {};
  const thumbs: { key: string; buf: Buffer; w: number }[] = [];

  await pmap(
    keys,
    8,
    async (key) => {
      const r = resolved[key];
      const e: ArtEntry = {};
      if (r.year) e.y = r.year;
      // --- cover
      if (r.cover) {
        try {
          const file = await coverInput(r.cover.url);
          if (file) {
            const base = sharp(file, { failOn: "none" }).flatten({ background: "#111111" });
            const meta = await base.metadata();
            const aspect = Math.min(2, Math.max(0.5, (meta.width ?? 1) / (meta.height ?? 1)));
            const cover = await base.clone().resize(COVER_MAX, COVER_MAX, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
            const name = `covers/${fileBase(key)}.${sha(cover.data.toString("base64")).slice(0, 8)}.webp`;
            await Bun.write(join(OUT, name), cover.data);
            e.c = name;
            e.w = cover.info.width;
            e.h = cover.info.height;
            e.src = r.cover.source;
            const tw = Math.round(CELL_H * aspect);
            const thumb = await base.clone().resize(tw, CELL_H, { fit: "fill" }).extend({ top: GUT, bottom: GUT, left: GUT, right: GUT, extendWith: "copy" }).raw().toBuffer();
            thumbs.push({ key, buf: thumb, w: tw });
            const { dominant } = await sharp(file).stats();
            e.col = "#" + [dominant.r, dominant.g, dominant.b].map((v) => v.toString(16).padStart(2, "0")).join("");
          }
        } catch (err) {
          console.error(`\ncover ${key}: ${err}`);
        }
      }
      // --- snaps
      const snapUrls = [...r.snaps.slice(0, 3)];
      const out: string[] = [];
      let pixel = false;
      for (const [i, u] of [...snapUrls, ...(r.titleScreen ? [r.titleScreen] : [])].entries()) {
        try {
          const f = await download(u);
          if (!f) continue;
          const img = sharp(f, { failOn: "none" }).flatten({ background: "#000" });
          const meta = await img.metadata();
          if (u.includes("libretro") && (meta.width ?? 999) <= 720) pixel = true;
          const buf = await img.resize(SNAP_MAX_W, undefined, { withoutEnlargement: true }).webp({ quality: pixel ? 90 : 78 }).toBuffer();
          const name = `snaps/${fileBase(key)}-${i}.${sha(buf.toString("base64")).slice(0, 8)}.webp`;
          await Bun.write(join(OUT, name), buf);
          if (i < snapUrls.length) out.push(name);
          else e.t = name;
        } catch (err) {
          console.error(`\nsnap ${key}: ${err}`);
        }
      }
      if (out.length) e.s = out;
      if (pixel) e.px = 1;
      games[key] = e;
    },
    progress("process", keys.length),
  );

  // --- atlas packing (shelf packer, sorted by key for stable layout)
  thumbs.sort((a, b) => a.key.localeCompare(b.key));
  const rowH = CELL_H + 2 * GUT;
  const pages: { input: Buffer; left: number; top: number; raw: { width: number; height: number; channels: 3 } }[][] = [[]];
  let x = 0, y = 0;
  for (const t of thumbs) {
    const w = t.w + 2 * GUT;
    if (x + w > ATLAS) {
      x = 0;
      y += rowH;
    }
    if (y + rowH > ATLAS) {
      pages.push([]);
      x = 0;
      y = 0;
    }
    const page = pages.length - 1;
    pages[page].push({ input: t.buf, left: x, top: y, raw: { width: w, height: rowH, channels: 3 } });
    const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
    games[t.key].a = [page, r5((x + GUT) / ATLAS), r5((y + GUT) / ATLAS), r5(t.w / ATLAS), r5(CELL_H / ATLAS)];
    x += w;
  }
  const hi: string[] = [];
  const lo: string[] = [];
  for (const [i, comps] of pages.entries()) {
    const page = await sharp({ create: { width: ATLAS, height: ATLAS, channels: 3, background: "#101010" } }).composite(comps).png().toBuffer();
    const hiBuf = await sharp(page).webp({ quality: 74, effort: 5 }).toBuffer();
    const loBuf = await sharp(page).resize(ATLAS / 2, ATLAS / 2, { kernel: "lanczos3" }).webp({ quality: 78, effort: 5 }).toBuffer();
    const hn = `atlas-${i}-hi.${sha(hiBuf.toString("base64")).slice(0, 8)}.webp`;
    const ln = `atlas-${i}-lo.${sha(loBuf.toString("base64")).slice(0, 8)}.webp`;
    await Bun.write(join(OUT, hn), hiBuf);
    await Bun.write(join(OUT, ln), loBuf);
    hi.push(hn);
    lo.push(ln);
    console.log(`atlas ${i}: ${comps.length} covers, hi ${(hiBuf.length / 1e6).toFixed(2)}MB, lo ${(loBuf.length / 1e6).toFixed(2)}MB`);
  }
  const sorted = Object.fromEntries(Object.entries(games).sort(([a], [b]) => a.localeCompare(b)));
  const manifest: Manifest = { version: sha(JSON.stringify(sorted)).slice(0, 10), atlas: { hi, lo, size: ATLAS }, games: sorted };
  await Bun.write(join(OUT, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}
