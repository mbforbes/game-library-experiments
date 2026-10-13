// Spines. Real spine scans (LaunchBox) come from a build-time atlas; everything else gets a
// spine printed here at runtime in its platform's retail design: band + wordmark, title,
// publisher, ESRB box, and edition banners (Greatest Hits, Player's Choice...).
// Cooper's grade stickers are separate 3D decals (see stickers in field.ts), so they appear on
// real and printed spines alike.

import * as THREE from "three/webgpu";
import type { Game } from "../../shared/types";
import { mediaFor, platformOf } from "../../shared/platforms";
import { TEMPLATES } from "./templates";
import type { ArtStore } from "../library/art";
import { editionOf, editionStyle, esrbBox, spineDesign, wordmark } from "./branding";

export const GRADE_COLORS: Record<string, string> = { "A+": "#ffd23f", A: "#3ddc84", B: "#38b6ff", C: "#c9c9c9", D: "#ff9f1c", F: "#ff3b3b" };

export class SpineAtlas {
  canvas = document.createElement("canvas");
  texture: THREE.CanvasTexture;
  rects = new Map<string, [number, number, number, number]>();
  readonly size: number;

  constructor(mobile: boolean, private art: ArtStore) {
    this.size = mobile ? 2048 : 4096;
    this.canvas.width = this.canvas.height = this.size;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false;
    this.texture.anisotropy = 8;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  /** Real scan available and no special edition to show (scans are standard releases). */
  usesReal(g: Game): boolean {
    return !!this.art.realSpine(g) && !editionOf(g);
  }

  build(games: Game[]) {
    const art = this.art;
    const items: { g: Game; w: number; h: number; horiz: boolean }[] = [];
    const ctx = this.canvas.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.size, this.size);
    const specs = games
      .filter((g) => !this.usesReal(g))
      .map((g) => ({ g, t: TEMPLATES[mediaFor(platformOf(g.platform), art.year(g))] }))
      .filter((x) => x.t.spine);
    // choose spine pixel height so the whole set fits one page (~82% packing efficiency)
    let area = 0;
    for (const { t } of specs) {
      const [sw, sh] = t.spine!;
      area += sh >= sw ? sw / sh : sh / sw;
    }
    const H = Math.min(512, Math.floor(Math.sqrt((this.size * this.size * 0.82) / Math.max(1, area))));
    for (const { g, t } of specs) {
      const [sw, sh] = t.spine!;
      const horiz = sw > sh; // arcade marquees
      const h = horiz ? Math.max(8, Math.round(H * (sh / sw))) : H;
      const w = horiz ? H : Math.max(6, Math.round(H * (sw / sh)));
      items.push({ g, w, h, horiz });
    }
    items.sort((a, b) => b.h - a.h);
    let x = 0, y = 0, rowH = 0;
    for (const it of items) {
      if (x + it.w > this.size) {
        x = 0;
        y += rowH + 1;
        rowH = 0;
      }
      if (y + it.h > this.size) break;
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
  const d = spineDesign(p);
  let bg = d.bg, fg = d.fg;
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

  if (d.pattern === "grid") {
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = Math.max(1, w * 0.03);
    for (let gy = y; gy < y + h; gy += w * 0.5) {
      ctx.beginPath();
      ctx.moveTo(x, gy);
      ctx.lineTo(x + w, gy);
      ctx.stroke();
    }
  }

  // platform band with a rotated wordmark (reads along the spine)
  const edition = editionOf(g);
  const band = Math.round(Math.min(h * 0.17, w * 3.2));
  if (kind === "slab") {
    ctx.fillStyle = p.neon;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x, y + band - Math.max(1, w * 0.06), w, Math.max(1, w * 0.06));
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = d.band;
    ctx.fillRect(x, y, w, band);
  }
  ctx.save();
  ctx.translate(x + w / 2, y + band / 2);
  ctx.rotate(Math.PI / 2);
  wordmark(ctx, p, -band * 0.46, -w * 0.42, band * 0.92, w * 0.84, kind === "slab" ? p.neon : d.bandFg);
  ctx.restore();

  let top = y + band + w * 0.35;
  let bottom = y + h - w * 0.3;
  // edition banner under the platform band (Greatest Hits etc.)
  if (edition) {
    const es = editionStyle(edition, p);
    const eb = Math.round(Math.min(h * 0.14, w * 2.6));
    ctx.fillStyle = es.bg;
    ctx.fillRect(x, y + band, w, eb);
    ctx.fillStyle = es.fg;
    ctx.save();
    ctx.translate(x + w / 2, y + band + eb / 2);
    ctx.rotate(Math.PI / 2);
    fitText(ctx, es.text, 0, 0, eb * 0.9, w * 0.5, `"Barlow Condensed", sans-serif`, "center", 700);
    ctx.restore();
    top += eb;
  }
  // bottom: ESRB box + publisher (only on spines wide enough to read)
  const rating = art.esrb(g);
  if (rating && kind !== "slab" && kind !== "bigbox") {
    // upright, like the little rating icon at the foot of real spines
    const eh = Math.min((w * 0.78) / 0.68, h * 0.09);
    esrbBox(ctx, rating, x + (w - eh * 0.68) / 2, bottom - eh, eh);
    bottom -= eh + w * 0.25;
  }
  const pub = art.publisher(g);
  if (pub && kind !== "slab") {
    const len = Math.min(h * 0.18, (bottom - top) * 0.3);
    ctx.fillStyle = fg;
    ctx.globalAlpha = 0.75;
    ctx.save();
    ctx.translate(x + w / 2, bottom - len);
    ctx.rotate(Math.PI / 2);
    fitText(ctx, pub.toUpperCase(), 0, 0, len, w * 0.34, `"Barlow Condensed", sans-serif`, "left", 600);
    ctx.restore();
    ctx.globalAlpha = 1;
    bottom -= len + w * 0.3;
  }

  // title, rotated to read top-to-bottom
  const len = bottom - top;
  ctx.fillStyle = fg;
  if (kind === "slab") {
    ctx.shadowColor = p.neon;
    ctx.shadowBlur = w * 0.25;
  }
  ctx.save();
  ctx.translate(x + w / 2, top);
  ctx.rotate(Math.PI / 2);
  fitText(ctx, g.title, 0, 0, len, w * 0.62, `"Oswald", "Barlow Condensed", sans-serif`, "left", 500);
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

export { luminance };
