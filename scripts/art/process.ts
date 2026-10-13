// Download + process resolved art into web-ready assets (public/art/):
//   covers/  hi-res box fronts            carts/   cartridge photos (alpha cut-outs)
//   backs/   real back covers              spines/  real spine scans (hi-res, for close-ups)
//   logos/   clear logos (alpha)            discs/   disc art (alpha)
//   snaps/   gameplay screenshots / title screens
//   atlas-N-{hi,lo}   every box front + cartridge photo, packed (RGBA)
//   spines-N-{hi,lo}  every real spine scan, packed
//   manifest.json     artKey -> atlas rects, files, colour, year, rating, publisher
// The hi tier is for desktop (4096² pages); lo is the same layout at half size (phones, first paint).

import sharp from "sharp";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { Resolved } from "./resolve";
import { download, ensureDir, pmap, progress, ROOT, sha } from "./util";
import { mediaFor, platformOf } from "../../shared/platforms";

export const OUT = join(ROOT, "public/art");
const PAGE = 4096;
const COVER_H = 176; // cover thumb height in the hi atlas
const SPINE_H = 400; // spine height in the hi spine atlas
const GUT = 4;
const COVER_MAX = 640;
const SNAP_MAX_W = 480;

type Rect = [number, number, number, number, number]; // page, u, v, w, h

export interface ArtEntry {
  a?: Rect; // box front in the cover atlas
  c?: string; // hi-res box front
  w?: number;
  h?: number;
  col?: string;
  s?: string[];
  t?: string;
  px?: 1;
  y?: number;
  src?: string;
  ka?: Rect; // cartridge photo in the cover atlas
  k?: string; // hi-res cartridge photo
  kb?: string; // cartridge back
  sp?: Rect; // real spine in the spine atlas
  spc?: string; // hi-res spine
  b?: string; // back cover
  l?: string; // clear logo
  d?: string; // disc
  r?: string; // ESRB short code
  pub?: string; // publisher
  pl?: number; // max players
}

export interface Manifest {
  version: string;
  atlas: { hi: string[]; lo: string[]; size: number };
  spines: { hi: string[]; lo: string[]; size: number };
  games: Record<string, ArtEntry>;
}

const fileBase = (key: string) => key.replace(/\//g, "__");

async function fetchImg(url: string): Promise<string | null> {
  let f = await download(url);
  if (!f && url.includes("library_600x900_2x")) f = await download(url.replace("_2x", ""));
  return f;
}

async function writeWebp(dir: string, key: string, buf: Buffer) {
  const name = `${dir}/${fileBase(key)}.${sha(buf.toString("base64")).slice(0, 8)}.webp`;
  await Bun.write(join(OUT, name), buf);
  return name;
}

const ESRB: Record<string, string> = { "EC - Early Childhood": "EC", "E - Everyone": "E", "E10+ - Everyone 10+": "E10+", "T - Teen": "T", "M - Mature": "M", "AO - Adults Only 18+": "AO", "RP - Rating Pending": "RP", "K-A - Kids to Adults": "K-A" };

interface Thumb {
  key: string;
  buf: Buffer; // raw RGBA incl. gutter
  w: number; // content width (excl. gutter)
  h: number;
}

export async function processAll(resolved: Record<string, Resolved>, ownedKeys?: Set<string>): Promise<Manifest> {
  rmSync(OUT, { recursive: true, force: true });
  for (const d of ["covers", "snaps", "carts", "backs", "spines", "logos", "discs"]) ensureDir(join(OUT, d));
  const keys = Object.keys(resolved);
  const games: Record<string, ArtEntry> = {};
  const coverThumbs: Thumb[] = [];
  const spineThumbs: Thumb[] = [];

  await pmap(
    keys,
    8,
    async (key) => {
      const r = resolved[key];
      const e: ArtEntry = {};
      const kind = mediaFor(platformOf(r.platform), r.year);
      if (r.year) e.y = r.year;
      // --- box front
      if (r.cover) {
        try {
          const file = await fetchImg(r.cover.url);
          if (file) {
            const base = sharp(file, { failOn: "none" }).flatten({ background: "#111111" });
            const meta = await base.metadata();
            const aspect = Math.min(2, Math.max(0.5, (meta.width ?? 1) / (meta.height ?? 1)));
            const cover = await base.clone().resize(COVER_MAX, COVER_MAX, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
            e.c = await writeWebp("covers", key, cover.data);
            e.w = cover.info.width;
            e.h = cover.info.height;
            e.src = r.cover.source;
            const tw = Math.round(COVER_H * aspect);
            coverThumbs.push({ key, w: tw, h: COVER_H, buf: await base.clone().resize(tw, COVER_H, { fit: "fill" }).ensureAlpha().extend({ top: GUT, bottom: GUT, left: GUT, right: GUT, extendWith: "copy" }).raw().toBuffer() });
            const { dominant } = await sharp(file).stats();
            e.col = "#" + [dominant.r, dominant.g, dominant.b].map((v) => v.toString(16).padStart(2, "0")).join("");
          }
        } catch (err) {
          console.error(`\ncover ${key}: ${err}`);
        }
      }
      const lb = r.lb;
      if (lb) {
        if (lb.esrb && ESRB[lb.esrb]) e.r = ESRB[lb.esrb];
        if (lb.publisher) e.pub = lb.publisher;
        if (lb.players) e.pl = lb.players;
        // --- cartridge photo (alpha cut-out), trimmed to the cart
        if (lb.cart) {
          try {
            const f = await download(lb.cart);
            if (f) {
              const trimmed = await sharp(f, { failOn: "none" }).ensureAlpha().trim({ threshold: 4 }).toBuffer();
              const img = sharp(trimmed);
              const meta = await img.metadata();
              const hi = await img.clone().resize(COVER_MAX, COVER_MAX, { fit: "inside", withoutEnlargement: true }).webp({ quality: 84, alphaQuality: 90 }).toBuffer();
              e.k = await writeWebp("carts", key, hi);
              // only owned games stand on the cart wall; wishlist games render as holograms of the box
              if (ownedKeys && !ownedKeys.has(key)) throw "skip-atlas";
              const aspect = Math.min(2.2, Math.max(0.4, (meta.width ?? 1) / (meta.height ?? 1)));
              const tw = Math.round(COVER_H * aspect);
              coverThumbs.push({ key: "cart:" + key, w: tw, h: COVER_H, buf: await img.clone().resize(tw, COVER_H, { fit: "fill" }).extend({ top: GUT, bottom: GUT, left: GUT, right: GUT, background: { r: 0, g: 0, b: 0, alpha: 0 } }).raw().toBuffer() });
            }
          } catch (err) {
            if (err !== "skip-atlas") console.error(`\ncart ${key}: ${err}`);
          }
        }
        if (lb.cartBack) e.kb = await small(lb.cartBack, "carts", key + "~back", 640, true);
        // --- real spine (vertical, reading top to bottom)
        if (lb.spine && kind !== "slab") {
          try {
            const f = await download(lb.spine);
            if (f) {
              let img = sharp(f, { failOn: "none" }).flatten({ background: "#111111" });
              const meta = await img.metadata();
              if ((meta.width ?? 0) > (meta.height ?? 0)) img = sharp(await img.rotate(90).toBuffer());
              const m2 = await img.metadata();
              const aspect = (m2.width ?? 1) / (m2.height ?? 1);
              if (aspect < 0.5) {
                e.spc = await writeWebp("spines", key, await img.clone().resize(undefined, 1024, { withoutEnlargement: true }).webp({ quality: 84 }).toBuffer());
                const tw = Math.max(8, Math.round(SPINE_H * aspect));
                spineThumbs.push({ key, w: tw, h: SPINE_H, buf: await img.clone().resize(tw, SPINE_H, { fit: "fill" }).ensureAlpha().extend({ top: GUT, bottom: GUT, left: GUT, right: GUT, extendWith: "copy" }).raw().toBuffer() });
              }
            }
          } catch (err) {
            console.error(`\nspine ${key}: ${err}`);
          }
        }
        // --- back cover (jewel-case inserts carry folded spine strips on both sides: crop them)
        if (lb.back) {
          try {
            const f = await download(lb.back);
            if (f) {
              let img = sharp(f, { failOn: "none" }).flatten({ background: "#111111" });
              if (kind === "jewel") {
                const m = await img.metadata();
                const cut = Math.round((m.width ?? 0) * 0.055);
                img = sharp(await img.extract({ left: cut, top: 0, width: (m.width ?? 0) - cut * 2, height: m.height ?? 0 }).toBuffer());
              }
              e.b = await writeWebp("backs", key, await img.resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer());
            }
          } catch (err) {
            console.error(`\nback ${key}: ${err}`);
          }
        }
        if (lb.logo) e.l = await small(lb.logo, "logos", key, 512, true, true);
        if (lb.disc) e.d = await small(lb.disc, "discs", key, 512, true);
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
          const name = await writeWebp("snaps", `${key}-${i}`, buf);
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

  const covers = await packAtlas("atlas", coverThumbs, COVER_H);
  for (const [k, rect] of covers.rects) {
    if (k.startsWith("cart:")) games[k.slice(5)].ka = rect;
    else games[k].a = rect;
  }
  const spines = await packAtlas("spines", spineThumbs, SPINE_H);
  for (const [k, rect] of spines.rects) games[k].sp = rect;

  const sorted = Object.fromEntries(Object.entries(games).sort(([a], [b]) => a.localeCompare(b)));
  const manifest: Manifest = {
    version: sha(JSON.stringify(sorted)).slice(0, 10),
    atlas: { hi: covers.hi, lo: covers.lo, size: PAGE },
    spines: { hi: spines.hi, lo: spines.lo, size: PAGE },
    games: sorted,
  };
  await Bun.write(join(OUT, "manifest.json"), JSON.stringify(manifest));
  return manifest;

  async function small(url: string, dir: string, key: string, max: number, alpha = false, trim = false): Promise<string | undefined> {
    try {
      const f = await download(url);
      if (!f) return;
      let img = sharp(f, { failOn: "none" });
      if (alpha) img = img.ensureAlpha();
      if (trim) img = sharp(await img.trim({ threshold: 4 }).toBuffer());
      const buf = await img.resize(max, max, { fit: "inside", withoutEnlargement: true }).webp({ quality: 84, alphaQuality: 90 }).toBuffer();
      return await writeWebp(dir, key, buf);
    } catch (err) {
      console.error(`\n${dir} ${key}: ${err}`);
    }
  }
}

/** Shelf-pack fixed-height thumbs into RGBA pages; writes hi (4096²) + lo (2048²) webp tiers. */
async function packAtlas(name: string, thumbs: Thumb[], rowContentH: number) {
  thumbs.sort((a, b) => a.key.localeCompare(b.key));
  const rowH = rowContentH + 2 * GUT;
  const pages: { input: Buffer; left: number; top: number; raw: { width: number; height: number; channels: 4 } }[][] = [[]];
  const rects = new Map<string, Rect>();
  let x = 0, y = 0;
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  for (const t of thumbs) {
    const w = t.w + 2 * GUT;
    if (x + w > PAGE) {
      x = 0;
      y += rowH;
    }
    if (y + rowH > PAGE) {
      pages.push([]);
      x = 0;
      y = 0;
    }
    const page = pages.length - 1;
    pages[page].push({ input: t.buf, left: x, top: y, raw: { width: w, height: rowH, channels: 4 } });
    rects.set(t.key, [page, r5((x + GUT) / PAGE), r5((y + GUT) / PAGE), r5(t.w / PAGE), r5(t.h / PAGE)]);
    x += w;
  }
  const hi: string[] = [], lo: string[] = [];
  if (!thumbs.length) return { hi, lo, rects };
  for (const [i, comps] of pages.entries()) {
    // crop the last page to the used height to save bytes
    const used = i === pages.length - 1 ? Math.min(PAGE, Math.ceil((y + rowH) / 64) * 64) : PAGE;
    const page = await sharp({ create: { width: PAGE, height: PAGE, channels: 4, background: { r: 16, g: 16, b: 16, alpha: 0 } } }).composite(comps).png().toBuffer();
    void used;
    const hiBuf = await sharp(page).webp({ quality: 74, alphaQuality: 80, effort: 5 }).toBuffer();
    const loBuf = await sharp(page).resize(PAGE / 2, PAGE / 2, { kernel: "lanczos3" }).webp({ quality: 72, alphaQuality: 70, effort: 6 }).toBuffer();
    const hn = `${name}-${i}-hi.${sha(hiBuf.toString("base64")).slice(0, 8)}.webp`;
    const ln = `${name}-${i}-lo.${sha(loBuf.toString("base64")).slice(0, 8)}.webp`;
    await Bun.write(join(OUT, hn), hiBuf);
    await Bun.write(join(OUT, ln), loBuf);
    hi.push(hn);
    lo.push(ln);
    console.log(`${name} ${i}: ${comps.length} items, hi ${(hiBuf.length / 1e6).toFixed(2)}MB, lo ${(loBuf.length / 1e6).toFixed(2)}MB`);
  }
  return { hi, lo, rects };
}
