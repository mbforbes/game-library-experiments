// bun scripts/art/contact-sheets.ts [--flagged] [--platform=PS5]
// Renders review grids (art/review/sheet-NN.jpg): every cover with its title, platform and
// match source/score, so a human (or Claude) can eyeball each one. Flagged items get red frames.

import sharp, { type OverlayOptions } from "sharp";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { Resolved } from "./resolve";
import type { Manifest } from "./process";
import { ensureDir, ROOT } from "./util";

const args = process.argv.slice(2);
const onlyFlagged = args.includes("--flagged");
const plat = args.find((a) => a.startsWith("--platform="))?.split("=")[1];
const lbMode = args.includes("--lb");
const COLS = lbMode ? 4 : 8, ROWS = lbMode ? 4 : 5, TW = lbMode ? 420 : 170, TH = 200, CAP = 64, PAD = 8;

const resolved: Record<string, Resolved> = await Bun.file(join(ROOT, "art/resolved.json")).json();
const manifest: Manifest = await Bun.file(join(ROOT, "public/art/manifest.json")).json();
const outDir = join(ROOT, "art/review");
rmSync(outDir, { recursive: true, force: true });
ensureDir(outDir);

let items = Object.values(resolved).sort((a, b) => a.platform.localeCompare(b.platform) || a.title.localeCompare(b.title));
if (plat) items = items.filter((r) => r.platform === plat);
if (onlyFlagged) items = items.filter((r) => r.flags.length || !r.cover || (r.cover.score < 0.95));
const keysFile = args.find((a) => a.startsWith("--keys="))?.split("=")[1];
if (keysFile) {
  const keep = new Set((await Bun.file(keysFile).text()).split("\n").filter(Boolean));
  items = items.filter((r) => keep.has(r.key));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const per = COLS * ROWS;
const index: string[] = [];
for (let s = 0; s * per < items.length; s++) {
  const chunk = items.slice(s * per, (s + 1) * per);
  const W = COLS * (TW + PAD) + PAD, H = ROWS * (TH + CAP + PAD) + PAD;
  const comps: OverlayOptions[] = [];
  for (const [i, r] of chunk.entries()) {
    const x = PAD + (i % COLS) * (TW + PAD), y = PAD + Math.floor(i / COLS) * (TH + CAP + PAD);
    const e = manifest.games[r.key];
    const flagged = r.flags.length > 0 || !e?.c;
    if (lbMode) {
      // front | spine | back | cart, side by side
      const files = [e?.c, (e as any)?.spc, (e as any)?.b, (e as any)?.k];
      const widths = [120, 30, 150, 110];
      let ox = x;
      for (const [j, f] of files.entries()) {
        if (f) {
          const img = await sharp(join(ROOT, "public/art", f)).resize(widths[j], TH, { fit: "contain", background: "#222" }).flatten({ background: "#335" }).toBuffer();
          comps.push({ input: img, left: ox, top: y });
        }
        ox += widths[j] + 3;
      }
    } else if (e?.c) {
      const img = await sharp(join(ROOT, "public/art", e.c)).resize(TW, TH, { fit: "contain", background: "#222" }).toBuffer();
      comps.push({ input: img, left: x, top: y });
    }
    const n = s * per + i;
    const title = r.title.length > 26 ? [r.title.slice(0, 26), r.title.slice(26, 52)] : [r.title, ""];
    const src = (r.cover ? `${r.cover.source} ${r.cover.score.toFixed(2)}` : "NO COVER") + (lbMode && r.lb ? `  LB:${r.lb.name.slice(0, 34)} ${r.lb.score}` : "");
    const svg = `<svg width="${TW}" height="${TH + CAP}" xmlns="http://www.w3.org/2000/svg">
      ${flagged ? `<rect x="1" y="1" width="${TW - 2}" height="${TH - 2}" fill="none" stroke="#ff2040" stroke-width="4"/>` : ""}
      <rect x="0" y="0" width="34" height="16" fill="#000" opacity="0.8"/><text x="3" y="12" font-family="Helvetica" font-size="11" fill="#ff0">${n}</text>
      <text x="2" y="${TH + 14}" font-family="Helvetica" font-size="12" font-weight="bold" fill="#fff">${esc(title[0])}</text>
      <text x="2" y="${TH + 28}" font-family="Helvetica" font-size="12" font-weight="bold" fill="#fff">${esc(title[1])}</text>
      <text x="2" y="${TH + 43}" font-family="Helvetica" font-size="11" fill="#8cf">${esc(r.platform)}</text>
      <text x="2" y="${TH + 57}" font-family="Helvetica" font-size="11" fill="${flagged ? "#f66" : "#9c9"}">${esc(src + (r.flags.length ? " " + r.flags.join(",") : ""))}</text>
    </svg>`;
    comps.push({ input: Buffer.from(svg), left: x, top: y });
    index.push(`${n}\t${r.key}\t${r.cover?.source ?? "-"}\t${r.cover?.score.toFixed(2) ?? "-"}\t${r.cover?.label ?? ""}`);
  }
  const file = join(outDir, `sheet-${String(s).padStart(2, "0")}.jpg`);
  await sharp({ create: { width: W, height: H, channels: 3, background: "#151515" } }).composite(comps).jpeg({ quality: 82 }).toFile(file);
}
await Bun.write(join(outDir, "index.tsv"), index.join("\n"));
console.log(`${Math.ceil(items.length / per)} sheets for ${items.length} items -> art/review/`);
