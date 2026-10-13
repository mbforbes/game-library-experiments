// Platform branding for things we generate ourselves (used wherever no real scan exists):
// platform wordmarks, spine designs per console family, ESRB boxes, edition banners
// (Greatest Hits, Player's Choice, ...), generated back covers and cartridge backs,
// and special cartridge shells (gold Zelda carts, the crystal Pokémon cart...).
// Wordmarks are typographic approximations, not logo images.

import type { Game } from "../../shared/types";
import { platformOf, type Platform } from "../../shared/platforms";

// ---------------------------------------------------------------------------------------------
// Special shells: real carts that came in unusual plastic.

export interface ShellStyle {
  color: string;
  metalness: number;
  roughness: number;
}

export const SPECIAL_SHELLS: Record<string, ShellStyle> = {
  "nes/the-legend-of-zelda": { color: "#c9a23a", metalness: 0.85, roughness: 0.32 },
  "nes/zelda-ii-the-adventure-of-link": { color: "#c9a23a", metalness: 0.85, roughness: 0.32 },
  "n64/the-legend-of-zelda-ocarina-of-time": { color: "#c9a23a", metalness: 0.85, roughness: 0.3 },
  "n64/the-legend-of-zelda-majoras-mask": { color: "#c9a23a", metalness: 0.85, roughness: 0.3 },
  "n64/donkey-kong-64": { color: "#e8c21a", metalness: 0.0, roughness: 0.45 },
  "gameboy/pokemon-crystal": { color: "#8fd3f0", metalness: 0.1, roughness: 0.12 },
  "gameboy/pokemon-red-version": { color: "#c8282d", metalness: 0, roughness: 0.45 },
  "gameboy/pokemon-blue-version": { color: "#2a4fbf", metalness: 0, roughness: 0.45 },
  "gameboy/pokemon-yellow-version": { color: "#f2c51b", metalness: 0, roughness: 0.45 },
  "gameboy/pokemon-gold-version": { color: "#c9a23a", metalness: 0.6, roughness: 0.35 },
  "gameboy/pokemon-silver-version": { color: "#b9bfc8", metalness: 0.6, roughness: 0.35 },
  "gba/pokemon-ruby": { color: "#c8283a", metalness: 0.1, roughness: 0.15 },
  "gba/pokemon-sapphire": { color: "#2a56c9", metalness: 0.1, roughness: 0.15 },
  "gba/pokemon-emerald": { color: "#1fa35a", metalness: 0.1, roughness: 0.15 },
  "gba/pokemon-firered": { color: "#d8442c", metalness: 0.1, roughness: 0.15 },
  "gba/pokemon-leafgreen": { color: "#3fbf4a", metalness: 0.1, roughness: 0.15 },
};

// ---------------------------------------------------------------------------------------------
// Editions (read from an optional "Edition" column in the sheet).

export type EditionId = "greatest-hits" | "players-choice" | "platinum-hits" | "nintendo-selects" | "playstation-hits" | "essentials" | "sega-classics" | "collectors" | "limited";

export function editionOf(g: Game): EditionId | undefined {
  const e = (g as Game & { edition?: string }).edition?.toLowerCase().replace(/[^a-z]/g, "");
  if (!e) return;
  if (e.includes("greatesthit")) return "greatest-hits";
  if (e.includes("playerschoice") || e.includes("playerchoice")) return "players-choice";
  if (e.includes("platinum")) return "platinum-hits";
  if (e.includes("nintendoselect")) return "nintendo-selects";
  if (e.includes("playstationhit")) return "playstation-hits";
  if (e.includes("essential")) return "essentials";
  if (e.includes("classic")) return "sega-classics";
  if (e.includes("collector")) return "collectors";
  if (e.includes("limited") || e.includes("special")) return "limited";
}

/** Banner colours + text for an edition on a given platform (the real ones vary by console). */
export function editionStyle(ed: EditionId, p: Platform): { bg: string; fg: string; text: string } {
  switch (ed) {
    case "greatest-hits":
      return p.id === "PS1" ? { bg: "#1f9a3a", fg: "#fff", text: "GREATEST HITS" } : { bg: "#d1121b", fg: "#fff", text: "GREATEST HITS" };
    case "players-choice":
      return { bg: "#f6c200", fg: "#c4161c", text: "PLAYER'S CHOICE" };
    case "platinum-hits":
      return { bg: "#c9ced6", fg: "#111", text: "PLATINUM HITS" };
    case "nintendo-selects":
      return { bg: "#e4000f", fg: "#fff", text: "NINTENDO SELECTS" };
    case "playstation-hits":
      return { bg: "#e5262e", fg: "#fff", text: "PLAYSTATION HITS" };
    case "essentials":
      return { bg: "#0a0a0a", fg: "#fff", text: "ESSENTIALS" };
    case "sega-classics":
      return { bg: "#1b4bd1", fg: "#fff", text: "SEGA CLASSICS" };
    case "collectors":
      return { bg: "#c9a23a", fg: "#1a1206", text: "COLLECTOR'S EDITION" };
    default:
      return { bg: "#6b1fd1", fg: "#fff", text: "LIMITED EDITION" };
  }
}

// ---------------------------------------------------------------------------------------------
// Wordmarks: draw a platform name the way its packaging presents it (within a box).

export function wordmark(ctx: CanvasRenderingContext2D, p: Platform, x: number, y: number, w: number, h: number, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const cx = x + w / 2, cy = y + h / 2;
  const fit = (text: string, font: (s: number) => string, maxH = h * 0.8) => {
    let size = maxH;
    ctx.font = font(size);
    const tw = ctx.measureText(text).width;
    if (tw > w * 0.92) size *= (w * 0.92) / tw;
    ctx.font = font(size);
    return size;
  };
  switch (p.family) {
    case "sony": {
      const label = p.id === "PS1" ? "PlayStation" : p.id === "PS2" ? "PlayStation 2" : p.id === "PS3" ? "PS3" : p.id === "PS4" ? "PS4" : "PS5";
      fit(label, (s) => `italic 600 ${s}px "Barlow Condensed", "Oswald", sans-serif`);
      ctx.fillText(label, cx, cy);
      break;
    }
    case "nintendo": {
      if (p.id === "Switch" || p.id === "Switch 2") {
        // the two-Joy-Con mark + wordmark
        const s = Math.min(h * 0.7, w * 0.22);
        const ix = x + w * 0.08, iy = cy - s / 2;
        roundRect(ctx, ix, iy, s * 0.48, s, s * 0.22);
        ctx.fill();
        ctx.lineWidth = Math.max(1, s * 0.09);
        roundRect(ctx, ix + s * 0.56, iy + ctx.lineWidth / 2, s * 0.44, s - ctx.lineWidth, s * 0.2);
        ctx.stroke();
        ctx.textAlign = "left";
        const size = fit(p.id === "Switch" ? "NINTENDO SWITCH" : "NINTENDO SWITCH 2", (sz) => `700 ${sz}px "Barlow Condensed", sans-serif`, h * 0.5);
        void size;
        ctx.fillText(p.id === "Switch" ? "NINTENDO SWITCH" : "NINTENDO SWITCH 2", ix + s * 1.15, cy + h * 0.02, w - (ix - x) - s * 1.25);
      } else {
        const label = { NES: "Nintendo", SNES: "SUPER NINTENDO", N64: "NINTENDO 64", GC: "NINTENDO GAMECUBE", Wii: "Wii", "Wii U": "Wii U", DS: "NINTENDO DS", Gameboy: "GAME BOY", GBA: "GAME BOY ADVANCE" }[p.id] ?? p.short;
        if (p.id === "Wii" || p.id === "Wii U") fit(label, (s) => `500 ${s}px "Inter", sans-serif`);
        else if (p.id === "NES") fit(label, (s) => `800 italic ${s}px "Oswald", sans-serif`);
        else fit(label, (s) => `700 ${s}px "Barlow Condensed", sans-serif`);
        ctx.fillText(label, cx, cy);
      }
      break;
    }
    case "sega": {
      const label = { Genesis: "SEGA GENESIS", "Master System": "SEGA MASTER SYSTEM", Saturn: "SEGA SATURN", Dreamcast: "Dreamcast", "Game Gear": "GAME GEAR" }[p.id] ?? "SEGA";
      fit(label, (s) => (p.id === "Dreamcast" ? `500 ${s}px "Inter", sans-serif` : `800 italic ${s}px "Oswald", sans-serif`));
      ctx.fillText(label, cx, cy);
      break;
    }
    case "microsoft":
      fit(p.short, (s) => `700 ${s}px "Barlow Condensed", sans-serif`);
      ctx.fillText(p.short, cx, cy);
      break;
    default:
      fit(p.short, (s) => `700 ${s}px "Barlow Condensed", sans-serif`);
      ctx.fillText(p.short, cx, cy);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// ESRB rating box: white letter panel, black frame, "ESRB" strip underneath.

export function esrbBox(ctx: CanvasRenderingContext2D, code: string, x: number, y: number, h: number) {
  const w = h * 0.68;
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#fff";
  ctx.fillRect(x + w * 0.08, y + w * 0.08, w * 0.84, h * 0.66);
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const letter = code === "E10+" ? "E10+" : code === "K-A" ? "K-A" : code;
  ctx.font = `900 ${h * (letter.length > 2 ? 0.26 : letter.length > 1 ? 0.34 : 0.52)}px "Inter", "Oswald", sans-serif`;
  ctx.fillText(letter, x + w / 2, y + w * 0.08 + h * 0.33);
  ctx.fillStyle = "#fff";
  ctx.font = `800 ${h * 0.13}px "Inter", sans-serif`;
  ctx.fillText("ESRB", x + w / 2, y + h * 0.86);
  ctx.restore();
  return w;
}

export function barcode(ctx: CanvasRenderingContext2D, seed: string, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#000";
  let s = 0;
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  let bx = x + w * 0.06;
  while (bx < x + w * 0.94) {
    s = (s * 1103515245 + 12345) >>> 0;
    const bw = ((s >> 16) % 3) + 1;
    if ((s >> 8) & 1) ctx.fillRect(bx, y + h * 0.08, bw * (w / 120), h * 0.72);
    bx += (bw + 1) * (w / 120);
  }
  ctx.font = `${h * 0.16}px "Inter", monospace`;
  ctx.textAlign = "center";
  ctx.fillText(String(s).padStart(12, "0").slice(0, 12), x + w / 2, y + h * 0.94);
  ctx.restore();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Spine colours by platform family (what the real retail spines look like, roughly). */
export function spineDesign(p: Platform): { bg: string; fg: string; band: string; bandFg: string; bandAtTop: boolean; pattern?: "grid" | "swirl" } {
  switch (p.id) {
    case "PS1":
      return { bg: "#0d0d0d", fg: "#f2f2f2", band: "#0d0d0d", bandFg: "#ffffff", bandAtTop: true };
    case "PS2":
      return { bg: "#0b0b0d", fg: "#f2f2f2", band: "#0b0b0d", bandFg: "#ffffff", bandAtTop: true };
    case "PS3":
      return { bg: "#141518", fg: "#f2f2f2", band: "#000000", bandFg: "#ffffff", bandAtTop: true };
    case "PS4":
      return { bg: "#0b3d91", fg: "#ffffff", band: "#0b3d91", bandFg: "#ffffff", bandAtTop: true };
    case "PS5":
      return { bg: "#1b1f2a", fg: "#ffffff", band: "#f4f4f4", bandFg: "#111111", bandAtTop: true };
    case "Switch":
      return { bg: "#ffffff", fg: "#111111", band: "#e60012", bandFg: "#ffffff", bandAtTop: true };
    case "Switch 2":
      return { bg: "#ffffff", fg: "#111111", band: "#1a1a1a", bandFg: "#ff3d4e", bandAtTop: true };
    case "Wii":
      return { bg: "#f6f6f6", fg: "#222222", band: "#d5d5d5", bandFg: "#5a5a5a", bandAtTop: true };
    case "Wii U":
      return { bg: "#1a8fd6", fg: "#ffffff", band: "#ffffff", bandFg: "#1a8fd6", bandAtTop: true };
    case "GC":
      return { bg: "#101012", fg: "#f1f1f1", band: "#5a4fcf", bandFg: "#ffffff", bandAtTop: true };
    case "DS":
      return { bg: "#f2f2f2", fg: "#222222", band: "#8a8a8a", bandFg: "#ffffff", bandAtTop: true };
    case "Genesis":
      return { bg: "#101010", fg: "#f4f4f4", band: "#c4161c", bandFg: "#ffffff", bandAtTop: true, pattern: "grid" };
    case "Master System":
      return { bg: "#101010", fg: "#ffffff", band: "#e8e8e8", bandFg: "#c4161c", bandAtTop: true, pattern: "grid" };
    case "Saturn":
      return { bg: "#111111", fg: "#ffffff", band: "#1d1d22", bandFg: "#6fa8ff", bandAtTop: true };
    case "Dreamcast":
      return { bg: "#f4f4f4", fg: "#1a1a1a", band: "#f4f4f4", bandFg: "#ff6a00", bandAtTop: true, pattern: "swirl" };
    case "XBOX":
      return { bg: "#101010", fg: "#ffffff", band: "#107c10", bandFg: "#ffffff", bandAtTop: true };
    case "XBOX 360":
      return { bg: "#f2f2f2", fg: "#222", band: "#5dc21e", bandFg: "#ffffff", bandAtTop: true };
    default:
      return { bg: p.spine, fg: p.spineText, band: p.band, bandFg: p.bandText, bandAtTop: true };
  }
}

export { platformOf };
