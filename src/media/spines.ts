// Runtime spine atlas: every case/box gets a printed spine (platform band, title, and a
// little sticker showing Cooper's grade or a "now playing" marker). Drawn into one canvas
// texture sized to fit everything on the device's budget.

import * as THREE from "three/webgpu";
import type { Game } from "../../shared/types";
import { mediaFor, platformOf } from "../../shared/platforms";
import { TEMPLATES } from "./templates";
import type { ArtStore } from "../library/art";

export const GRADE_COLORS: Record<string, string> = { "A+": "#ffd23f", A: "#3ddc84", B: "#38b6ff", C: "#c9c9c9", D: "#ff9f1c", F: "#ff3b3b" };

export class SpineAtlas {
  canvas = document.createElement("canvas");
  texture: THREE.CanvasTexture;
  rects = new Map<string, [number, number, number, number]>();
  readonly size: number;

  constructor(mobile: boolean) {
    this.size = mobile ? 2048 : 4096;
    this.canvas.width = this.canvas.height = this.size;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false;
    this.texture.anisotropy = 8;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  build(games: Game[], art: ArtStore) {
    const items: { g: Game; w: number; h: number; horiz: boolean }[] = [];
    const ctx = this.canvas.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.size, this.size);
    const specs = games
      .map((g) => ({ g, t: TEMPLATES[mediaFor(platformOf(g.platform), art.year(g))] }))
      .filter((x) => x.t.spine);
    // choose spine pixel height so the whole set fits one page (~82% packing efficiency)
    let area = 0;
    for (const { t } of specs) {
      const [sw, sh] = t.spine!;
      area += sh >= sw ? (sw / sh) : sh / sw; // relative area at unit height
    }
    const H = Math.min(512, Math.floor(Math.sqrt((this.size * this.size * 0.82) / Math.max(1, area))));
    for (const { g, t } of specs) {
      const [sw, sh] = t.spine!;
      const horiz = sw > sh; // arcade marquees
      const h = horiz ? Math.max(8, Math.round(H * (sh / sw))) : H;
      const w = horiz ? H : Math.max(6, Math.round(H * (sw / sh)));
      items.push({ g, w, h, horiz });
    }
    // shelf packing, tallest first
    items.sort((a, b) => b.h - a.h);
    let x = 0, y = 0, rowH = 0;
    for (const it of items) {
      if (x + it.w > this.size) {
        x = 0;
        y += rowH + 1;
        rowH = 0;
      }
      if (y + it.h > this.size) break; // out of room: remaining spines use the shell colour
      drawSpine(ctx, x, y, it.w, it.h, it.g, art, it.horiz);
      this.rects.set(it.g.id, [x / this.size, y / this.size, it.w / this.size, it.h / this.size]);
      x += it.w + 1;
      rowH = Math.max(rowH, it.h);
    }
    this.texture.needsUpdate = true;
  }
}

function luminance(hex: string) {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Draw one spine. Text reads top-to-bottom (US style); glyph tops face the cover side (+u). */
export function drawSpine(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, g: Game, art: ArtStore, horiz = false) {
  const p = platformOf(g.platform);
  const kind = mediaFor(p, art.year(g));
  let bg = p.spine, fg = p.spineText;
  if (kind === "bigbox") {
    bg = art.color(g);
    fg = luminance(bg) > 0.45 ? "#111" : "#fff";
  }
  if (kind === "slab") {
    bg = "#05070a";
    fg = p.neon;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);

  if (horiz) {
    // arcade marquee: glowing title on black
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = p.neon;
    fitText(ctx, g.title.toUpperCase(), x + w / 2, y + h / 2, w * 0.92, h * 0.62, `"Press Start 2P", monospace`, "center");
    ctx.restore();
    return;
  }

  const band = Math.round(Math.min(h * 0.13, w * 2.4));
  if (kind !== "slab") {
    ctx.fillStyle = p.band;
    ctx.fillRect(x, y, w, band);
  } else {
    ctx.fillStyle = p.neon;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x, y + band - Math.max(1, w * 0.06), w, Math.max(1, w * 0.06));
    ctx.globalAlpha = 1;
  }
  // platform label in the band (horizontal, tiny) — or rotated when the spine is very thin
  ctx.fillStyle = kind === "slab" ? p.neon : p.bandText;
  ctx.save();
  ctx.translate(x + w / 2, y + band / 2);
  ctx.rotate(Math.PI / 2);
  fitText(ctx, p.short, 0, 0, band * 0.86, w * 0.62, `"Barlow Condensed", "Oswald", sans-serif`, "center", 700);
  ctx.restore();

  // status sticker at the bottom
  const sticker = Math.round(Math.min(w * 0.9, h * 0.09));
  let bottom = y + h - Math.round(w * 0.25);
  if (g.status === "completed" && g.grade) {
    const cy = bottom - sticker / 2;
    ctx.fillStyle = GRADE_COLORS[g.grade];
    ctx.beginPath();
    ctx.arc(x + w / 2, cy, sticker / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#111";
    ctx.save();
    ctx.translate(x + w / 2, cy);
    ctx.rotate(Math.PI / 2);
    fitText(ctx, g.grade, 0, 0, sticker * 0.8, sticker * 0.62, `"Oswald", sans-serif`, "center", 700);
    ctx.restore();
    bottom -= sticker + w * 0.3;
  } else if (g.status === "playing") {
    ctx.fillStyle = "#ffb000";
    const sh = sticker * 1.6;
    ctx.fillRect(x + w * 0.18, bottom - sh, w * 0.64, sh);
    ctx.fillStyle = "#111";
    ctx.beginPath();
    const cx = x + w / 2, cy = bottom - sh / 2, r = Math.min(w * 0.22, sh * 0.3);
    ctx.moveTo(cx - r * 0.8, cy - r);
    ctx.lineTo(cx + r * 0.8, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.closePath();
    ctx.fill();
    bottom -= sh + w * 0.3;
  }

  // title, rotated to read top-to-bottom
  const top = y + band + w * 0.35;
  const len = bottom - top;
  ctx.fillStyle = fg;
  if (kind === "slab") {
    ctx.shadowColor = p.neon;
    ctx.shadowBlur = w * 0.25;
  }
  ctx.save();
  ctx.translate(x + w / 2, top);
  ctx.rotate(Math.PI / 2);
  fitText(ctx, g.title, 0, 0, len, w * 0.66, `"Oswald", "Barlow Condensed", sans-serif`, "left", 500);
  ctx.restore();
  ctx.restore();
}

/** Fit a single line into maxW (along the baseline) with font size <= maxSize; condenses if needed. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, maxSize: number, family: string, align: "left" | "center", weight = 400) {
  let size = Math.max(4, Math.floor(maxSize));
  ctx.font = `${weight} ${size}px ${family}`;
  let tw = ctx.measureText(text).width;
  const minSize = Math.max(4, maxSize * 0.55);
  while (tw > maxW && size > minSize) {
    size -= 1;
    ctx.font = `${weight} ${size}px ${family}`;
    tw = ctx.measureText(text).width;
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const sx = tw > maxW ? maxW / tw : 1; // condense horizontally rather than truncate
  ctx.save();
  ctx.translate(x - (align === "center" ? (tw * sx) / 2 : 0), y);
  ctx.scale(sx, 1);
  ctx.fillText(text, 0, size * 0.04);
  ctx.restore();
}
