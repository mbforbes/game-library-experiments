// Neon Den decor: real vinyl jackets, old Game Informer covers and perler-bead sprites, packed into
// ONE sprite sheet.
//
//   bun scripts/decor/den-assets.ts [--preview out.png]
//
// Reads scripts/decor/den-sources.json, downloads each source once into .cache/decor/ (never
// re-fetched while cached), crops / keys / resizes it, and writes
//   public/art/decor/den-<8-char content hash>.webp   the packed sheet
//   public/art/decor/den.json                         { sheet, w, h, records[], magazines[], sprites[] } (rects in sheet px)
// Records are 256x256, magazines 160x216, sprites stay at native resolution with hard alpha (one
// pixel = one bead). The sheet is lossless WebP, so sprite colours survive exactly (lossy WebP's
// chroma subsampling shifted nearly every sprite pixel, by up to ~200 levels). Re-running with a
// warm cache rewrites byte-identical files.

import sharp from "sharp";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, fetchRetry, ROOT, sha, sleep } from "../art/util";

const UA = "TheBacklog/1.0 (personal fan project)";
const CACHE = join(ROOT, ".cache/decor");
const OUT = join(ROOT, "public/art/decor");
const SOURCES = join(import.meta.dir, "den-sources.json");

const SHEET_W = 2048;
const MAX_H = 2048;
const RECORD = 256;
const MAG_W = 160;
const MAG_H = 216;
const GUT = 2; // gutter around every rect: edge-extended for covers, transparent for sprites
const PHOTO_STEP = 4;

type Box = [number, number, number, number];
interface Base { key: string; url: string; page: string; credit: string; size?: [number, number]; crop?: Box }
interface RecordSrc extends Base { game: string; title: string; label: string; catalog?: string; year?: number }
interface MagSrc extends Base { issue: string; date: string; cover: string }
interface SpriteSrc extends Base { name: string; game: string; frame?: number; transparent?: string[] }
interface Sources { records: RecordSrc[]; magazines: MagSrc[]; sprites: SpriteSrc[] }

interface Tile { kind: "records" | "magazines" | "sprites"; key: string; w: number; h: number; rgba: Buffer; opaque: boolean; x?: number; y?: number }

/** Download once into .cache/decor (keyed by URL); later runs never touch the network. */
async function cached(url: string): Promise<string> {
  const ext = url.split("?")[0].match(/\.(png|jpe?g|gif|webp)$/i)?.[1]?.toLowerCase() ?? "bin";
  const file = join(CACHE, `${sha(url)}.${ext}`);
  if (existsSync(file)) return file;
  ensureDir(CACHE);
  const res = await fetchRetry(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 100) throw new Error(`${url}: suspiciously small (${buf.length} bytes)`);
  await Bun.write(file, buf);
  console.log(`  fetched ${url} (${(buf.length / 1024).toFixed(0)} KB)`);
  await sleep(400); // sequential + polite
  return file;
}

async function load(src: Base & { frame?: number }) {
  const file = await cached(src.url);
  const img = sharp(file, { page: src.frame ?? 0, failOn: "none" });
  const meta = await img.metadata();
  const w = meta.width!, h = meta.pageHeight ?? meta.height!;
  if (src.size && (src.size[0] !== w || src.size[1] !== h)) {
    throw new Error(`${src.key}: source is ${w}x${h}, crop was measured on ${src.size[0]}x${src.size[1]}; re-check the crop`);
  }
  return { img, w, h };
}

async function cover(src: Base, outW: number, outH: number): Promise<Buffer> {
  const { img, w, h } = await load(src);
  let box = src.crop;
  if (!box) {
    const s = Math.min(w, h); // centre square
    box = [Math.floor((w - s) / 2), Math.floor((h - s) / 2), s, s];
  }
  const rgba = await img
    .extract({ left: box[0], top: box[1], width: box[2], height: box[3] })
    .flatten({ background: "#000" })
    .resize(outW, outH, { fit: "fill", kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  // Round photo channels to multiples of PHOTO_STEP (at most ±2 levels, invisible): the sheet is
  // lossless for the sprites' sake, and this trims about a third off its size. Sprites are untouched.
  for (let i = 0; i < rgba.length; i += 4)
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.min(255, Math.round(rgba[i + c] / PHOTO_STEP) * PHOTO_STEP);
  return rgba;
}

/** Crop, key listed colours to transparent, binarise alpha, trim to the opaque bounds. */
async function sprite(src: SpriteSrc): Promise<{ w: number; h: number; rgba: Buffer }> {
  const { img, w, h } = await load(src);
  const [cx, cy, cw, ch] = src.crop ?? [0, 0, w, h];
  const data = await img.extract({ left: cx, top: cy, width: cw, height: ch }).ensureAlpha().raw().toBuffer();
  const keyed = new Set((src.transparent ?? []).map((c) => c.toLowerCase()));
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      const hex = data.subarray(i, i + 3).toString("hex");
      if (data[i + 3] < 128 || keyed.has(hex)) {
        data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
        continue;
      }
      data[i + 3] = 255;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (x1 < 0) throw new Error(`${src.key}: nothing left after keying`);
  const tw = x1 - x0 + 1, th = y1 - y0 + 1;
  const out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) data.copy(out, y * tw * 4, ((y + y0) * cw + x0) * 4, ((y + y0) * cw + x1 + 1) * 4);
  return { w: tw, h: th, rgba: out };
}

/** Shelf packing, tallest first (stable), each tile padded by GUT on every side. */
function pack(tiles: Tile[]): number {
  const order = tiles.map((t, i) => [t, i] as const).sort((a, b) => b[0].h - a[0].h || a[1] - b[1]).map(([t]) => t);
  let x = 0, y = 0, shelf = 0;
  for (const t of order) {
    const pw = t.w + GUT * 2, ph = t.h + GUT * 2;
    if (x + pw > SHEET_W) { y += shelf; x = 0; shelf = 0; }
    t.x = x + GUT;
    t.y = y + GUT;
    x += pw;
    shelf = Math.max(shelf, ph);
  }
  const used = y + shelf;
  let h = 256;
  while (h < used) h *= 2;
  if (h > MAX_H) throw new Error(`sheet needs ${used}px of height, more than ${MAX_H}`);
  return h;
}

async function main() {
  const previewArg = process.argv.indexOf("--preview");
  const preview = previewArg > 0 ? process.argv[previewArg + 1] : undefined;
  const src: Sources = JSON.parse(await Bun.file(SOURCES).text());
  const keys = [...src.records, ...src.magazines, ...src.sprites].map((s) => s.key);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw new Error(`duplicate key "${dup}" in den-sources.json (keys must be unique across all three lists)`);
  const tiles: Tile[] = [];

  console.log(`records (${src.records.length})`);
  for (const r of src.records) tiles.push({ kind: "records", key: r.key, w: RECORD, h: RECORD, rgba: await cover(r, RECORD, RECORD), opaque: true });
  console.log(`magazines (${src.magazines.length})`);
  for (const m of src.magazines) tiles.push({ kind: "magazines", key: m.key, w: MAG_W, h: MAG_H, rgba: await cover(m, MAG_W, MAG_H), opaque: true });
  console.log(`sprites (${src.sprites.length})`);
  for (const s of src.sprites) {
    const sp = await sprite(s);
    tiles.push({ kind: "sprites", key: s.key, ...sp, opaque: false });
    console.log(`  ${s.key}: ${sp.w}x${sp.h}`);
  }

  const sheetH = pack(tiles);
  const comps = [];
  for (const t of tiles) {
    // opaque covers get their edge pixels copied into the gutter so filtering never pulls in neighbours
    const padded = await sharp(t.rgba, { raw: { width: t.w, height: t.h, channels: 4 } })
      .extend(t.opaque ? { top: GUT, bottom: GUT, left: GUT, right: GUT, extendWith: "copy" } : { top: GUT, bottom: GUT, left: GUT, right: GUT, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .raw()
      .toBuffer();
    comps.push({ input: padded, raw: { width: t.w + GUT * 2, height: t.h + GUT * 2, channels: 4 as const }, left: t.x! - GUT, top: t.y! - GUT });
  }
  const sheetRaw = await sharp({ create: { width: SHEET_W, height: sheetH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(comps).raw().toBuffer();
  // Lossless: sprite pixels must keep their exact colours (each one becomes a bead) and lossy WebP's
  // chroma subsampling smears them. "quality" here is lossless effort, not fidelity.
  const webp = await sharp(sheetRaw, { raw: { width: SHEET_W, height: sheetH, channels: 4 } }).webp({ lossless: true, quality: 88, effort: 6 }).toBuffer();
  const hash = createHash("sha256").update(webp).digest("hex").slice(0, 8);
  const sheet = `den-${hash}.webp`;

  ensureDir(OUT);
  for (const f of readdirSync(OUT)) if (/^den-[0-9a-f]{8}\.webp$/.test(f) && f !== sheet) rmSync(join(OUT, f));
  await Bun.write(join(OUT, sheet), webp);

  const rect = (kind: Tile["kind"], k: string) => {
    const t = tiles.find((t) => t.kind === kind && t.key === k)!;
    return { x: t.x!, y: t.y!, w: t.w, h: t.h };
  };
  const manifest = {
    sheet,
    w: SHEET_W,
    h: sheetH,
    records: src.records.map((r) => ({ key: r.key, game: r.game, title: r.title, label: r.label, ...rect("records", r.key) })),
    magazines: src.magazines.map((m) => ({ key: m.key, issue: m.issue, date: m.date, ...rect("magazines", m.key) })),
    sprites: src.sprites.map((s) => ({ key: s.key, name: s.name, game: s.game, ...rect("sprites", s.key) })),
  };
  await Bun.write(join(OUT, "den.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote public/art/decor/${sheet} (${SHEET_W}x${sheetH}, ${(webp.length / 1024).toFixed(0)} KB) + den.json`);

  if (preview) {
    // contact sheet: the packed sheet over a checkerboard so transparent sprite pixels show
    const checker = Buffer.alloc(SHEET_W * sheetH * 3);
    for (let y = 0; y < sheetH; y++)
      for (let x = 0; x < SHEET_W; x++) {
        const v = ((x >> 3) + (y >> 3)) & 1 ? 70 : 50;
        checker.fill(v, (y * SHEET_W + x) * 3, (y * SHEET_W + x) * 3 + 3);
      }
    await sharp(checker, { raw: { width: SHEET_W, height: sheetH, channels: 3 } })
      .composite([{ input: sheetRaw, raw: { width: SHEET_W, height: sheetH, channels: 4 } }])
      .png()
      .toFile(preview);
    console.log(`preview ${preview}`);
  }
}

await main();
