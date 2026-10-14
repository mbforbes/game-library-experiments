// THE NEON DEN: the lived-in layer.
//
// Everything static in here is baked into ONE DecorBuilder mesh (one material, one atlas texture,
// one draw call). The few moving parts (ceiling fan, spinning record, lava-lamp blobs, clock
// hands) are sub-builders that share that material, animated from ctx.onUpdate. No lights, no
// extra materials or textures, nothing on positionNode.
//
// Props stay out of the browsing space in front of the game walls: they live on the TV stand,
// the free stretch of back wall between the TV nook and the console bookcases, the battlestation
// desk, under the cartridge wall, in the corners, on the window sill, around the couch and up on
// the ceiling.

import * as THREE from "three/webgpu";
import { DecorBuilder, roundedRect, rand, type Vec3, type UVRect, type PropOpts, type Color } from "../../world/kit/decorkit";
import type { LevelCtx } from "../types";
import { NO } from "../../engine/flags";
import { loadImage } from "../../library/art";

export interface DenLayout {
  X0: number;
  X1: number;
  Z0: number;
  Z1: number;
  CEIL: number;
  /** TV nook centre (x); the TV stand's front-centre sits at z = Z0 + 0.42 */
  nookX: number;
  /** left end (x) of the console bookcases on the back wall */
  consoleX0: number;
  /** PC bookcases span (z) on the left wall, and the battlestation desk centre (z) */
  pcZ0: number;
  pcZ1: number;
  deskZ: number;
  /** cartridge wall span (z) on the right wall, and the y of its lowest row */
  cartZ0: number;
  cartZ1: number;
  cartBase: number;
  /** arcade cabinet centres (x) along the front wall (cabinets are 0.68 wide, 0.8 deep, 1.85 tall) */
  arcadeXs: number[];
  /** Want-O-Matic centre (x); it is 1.0 wide and stands 0.8 deep against the front wall */
  vendingX: number;
  /** couch centre (z), facing -z, and the holo-table centre (z); both sit on x = 0 */
  couchZ: number;
  tableZ: number;
}

const PI = Math.PI;
const HAND = `"Marker Felt", "Chalkboard SE", "Comic Sans MS", "Segoe Print", cursive`;
const PIX = `"Press Start 2P", "Silkscreen", monospace`;
const SILK = `"Silkscreen", monospace`;
const NEON = `"Tilt Neon", "Oswald", sans-serif`;
const OSW = `"Oswald", "Barlow Condensed", sans-serif`;

const C = {
  walnut: "#80522f",
  walnutDark: "#4e3220",
  ink: "#141218",
  charcoal: "#24222a",
  plum: "#3a1f4a",
  chrome: "#c9ced8",
  brass: "#c99a3c",
  beige: "#d2c8b0",
  cream: "#ece4d0",
  magenta: "#ff3d9a",
  cyan: "#4fd8ff",
  purple: "#a35cff",
  green: "#3dffa8",
  amber: "#ffb000",
  warm: "#ffc98a",
  leaf: "#2f7a3e",
  terracotta: "#b8643c",
  cardboard: "#a8794a",
};

type Tick = (dt: number, t: number) => void;

// ---------------------------------------------------------------------------------------------
// Real art (album covers of game soundtracks on vinyl, Game Informer covers, sprites for the perler
// beads) comes from one sprite sheet + manifest. Fetched as soon as this module loads so it's in
// hand by the time the room is dressed; if it's missing, the drawn stand-ins are used instead.

interface SheetRect {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface DenArtManifest {
  sheet: string;
  w: number;
  h: number;
  records?: (SheetRect & { game: string; title: string; label?: string })[];
  magazines?: (SheetRect & { issue?: string | number; date?: string })[];
  sprites?: (SheetRect & { name: string; game: string })[];
}
type DenArt = { man: Required<DenArtManifest>; img: ImageBitmap | HTMLImageElement };

const DECOR_ART = "/art/decor/";
async function loadDenArt(): Promise<DenArt | null> {
  if (NO.has("decorart")) return null;
  try {
    const res = await fetch(DECOR_ART + "den.json", { cache: "no-cache", signal: AbortSignal.timeout(8000) });
    // (a missing file comes back as the dev server's index.html)
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
    const text = await res.text();
    const man = JSON.parse(text) as DenArtManifest;
    if (!man?.sheet) return null;
    let v = 0;
    for (let i = 0; i < text.length; i++) v = (v * 31 + text.charCodeAt(i)) | 0;
    const img = await loadImage(`${DECOR_ART}${man.sheet}?v=${(v >>> 0).toString(36)}`);
    const ok = (r: SheetRect) => r && r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= img.width && r.y + r.h <= img.height;
    return { man: { ...man, records: (man.records ?? []).filter(ok), magazines: (man.magazines ?? []).filter(ok), sprites: (man.sprites ?? []).filter(ok) }, img };
  } catch (err) {
    console.warn("[den] decor art unavailable, using drawn stand-ins", err);
    return null;
  }
}
let denArt: Promise<DenArt | null> | null = null;
/** Starts the download (once); called at module load and again (no-op) when the room is dressed. */
const denArtOnce = () => (denArt ??= loadDenArt());
if (!NO.has("decor")) denArtOnce();

/** Perler bead piece: bead texture, its halo backer, and its size in beads (incl. the halo margin). */
interface Perler {
  rect: UVRect;
  halo: UVRect;
  bw: number;
  bh: number;
  name: string;
  game: string;
}
type RO = PropOpts & { r?: number; bevel?: number; axis?: "x" | "y" | "z"; segs?: number };

let seed = 1;
const rnd = () => rand(seed++ * 1.618 + 0.5);
/** Yields to the frame loop once ~10 ms of work has piled up (set by decorateDen). */
let tick: () => Promise<void> = async () => {};

// ---------------------------------------------------------------------------------------------
// geometry helpers

function extrudeRounded(w: number, h: number, depth: number, r: number, bevel: number, segs: number) {
  const b = Math.max(0, Math.min(bevel, w / 2 - 0.001, h / 2 - 0.001, depth / 2 - 0.0005));
  const iw = w - 2 * b, ih = h - 2 * b;
  const rr = Math.max(0.0005, Math.min(r - b, iw / 2 - 0.0002, ih / 2 - 0.0002));
  const dz = Math.max(0.0005, depth - 2 * b);
  const g = new THREE.ExtrudeGeometry(roundedRect(iw, ih, rr), { depth: dz, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 1, curveSegments: segs });
  g.translate(0, 0, -dz / 2);
  return g;
}

/** Box with rounded edges around `axis` ("y" = rounded vertical edges, seen from above). */
function rbox(d: DecorBuilder, size: Vec3, at: Vec3, color: Color, o: RO = {}) {
  const [w, h, dp] = size;
  const axis = o.axis ?? "z";
  const r = o.r ?? 0.2 * Math.min(w, h, dp);
  const segs = o.segs ?? 3;
  const bevel = o.bevel ?? 0;
  let g: THREE.BufferGeometry;
  if (axis === "z") g = extrudeRounded(w, h, dp, r, bevel, segs);
  else if (axis === "y") {
    g = extrudeRounded(w, dp, h, r, bevel, segs);
    g.rotateX(-PI / 2);
  } else {
    g = extrudeRounded(dp, h, w, r, bevel, segs);
    g.rotateY(PI / 2);
  }
  d.geo(g, at, color, o);
}

/** A cylinder from a to b (legs, arms, rails, posts). */
function rod(d: DecorBuilder, a: Vec3, b: Vec3, r: number, color: Color, o: PropOpts & { seg?: number; r2?: number } = {}) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  const m = va.add(vb).multiplyScalar(0.5);
  d.cyl(o.r2 ?? r, r, len, [m.x, m.y, m.z], color, { ...o, seg: o.seg ?? 8, rot: [e.x, e.y, e.z] });
}

/** Extrude a closed outline (XY) by `depth` along +Z, centred on z. */
function slabShape(d: DecorBuilder, s: THREE.Shape, depth: number, at: Vec3, color: Color, o: PropOpts & { bevel?: number; segs?: number } = {}) {
  const b = o.bevel ?? 0;
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 1, curveSegments: o.segs ?? 4 });
  g.translate(0, 0, -depth / 2);
  d.geo(g, at, color, o);
}

/** A thick band following a polyline (XY), as a Shape (blankets, cables draped over edges). */
function bandShape(path: [number, number][], t: number) {
  const outer: THREE.Vector2[] = [], inner: THREE.Vector2[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i], a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    const nx = -ty / l, ny = tx / l;
    outer.push(new THREE.Vector2(p[0] + (nx * t) / 2, p[1] + (ny * t) / 2));
    inner.push(new THREE.Vector2(p[0] - (nx * t) / 2, p[1] - (ny * t) / 2));
  }
  return new THREE.Shape([...outer, ...inner.reverse()]);
}

const potProfile = (r: number, h: number): [number, number][] => [
  [0, 0],
  [r * 0.78, 0],
  [r * 0.84, h * 0.06],
  [r, h * 0.9],
  [r * 1.07, h * 0.94],
  [r * 1.07, h],
  [r * 0.93, h],
  [r * 0.9, h * 0.9],
  [0, h * 0.88],
];

function cable(d: DecorBuilder, pts: Vec3[], color: Color = "#101014", r = 0.0035) {
  d.tube(pts, r, color, { rough: 0.6, seg: Math.max(10, pts.length * 7) });
}

// ---------------------------------------------------------------------------------------------
// canvas helpers

type Ctx2D = CanvasRenderingContext2D;
const disc = (c: Ctx2D, x: number, y: number, r: number) => {
  c.beginPath();
  c.arc(x, y, r, 0, PI * 2);
};
function rrect(c: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function pixels(c: Ctx2D, rows: string[], x0: number, y0: number, s: number, pal: Record<string, string>) {
  rows.forEach((row, j) =>
    [...row].forEach((ch, i) => {
      const col = pal[ch];
      if (!col) return;
      c.fillStyle = col;
      c.fillRect(x0 + i * s, y0 + j * s, s + 0.3, s + 0.3);
    }),
  );
}
function scribble(c: Ctx2D, x: number, y: number, w: number, lines: number, color: string, gap = 7) {
  c.strokeStyle = color;
  c.lineWidth = 1.4;
  for (let i = 0; i < lines; i++) {
    c.beginPath();
    const len = w * (0.55 + rnd() * 0.45);
    for (let k = 0; k <= len; k += 3) c.lineTo(x + k, y + i * gap + Math.sin(k * 0.7 + i) * 1.2);
    c.stroke();
  }
}

/** Average colour of a sheet rect (for record spines). */
function averageColor(img: CanvasImageSource, r: SheetRect) {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, 1, 1);
  const [R, G, B] = g.getImageData(0, 0, 1, 1).data;
  // spines are darker and a touch more saturated than the averaged cover
  const k = 0.8;
  return `rgb(${Math.round(R * k)},${Math.round(G * k)},${Math.round(B * k)})`;
}

/**
 * Perler beads from a pixel-art sprite: one bead (rounded, with a centre hole) per opaque pixel on a
 * clear pegboard over a white backing. Returns the canvas size and a draw function (batched paths:
 * one fill per bead colour, so even big sprites are a few dozen canvas calls).
 */
function beadPattern(img: CanvasImageSource, sp: SheetRect) {
  const src = document.createElement("canvas");
  src.width = sp.w;
  src.height = sp.h;
  const g = src.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, sp.x, sp.y, sp.w, sp.h, 0, 0, sp.w, sp.h);
  const data = g.getImageData(0, 0, sp.w, sp.h).data;
  // big sprites (not native resolution) are sampled down to at most ~96 beads a side
  const step = Math.max(1, Math.ceil(Math.max(sp.w, sp.h) / 96));
  const W = Math.floor(sp.w / step), H = Math.floor(sp.h / step);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  const at = (i: number, j: number) => ((j * step) * sp.w + i * step) * 4;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++)
      if (data[at(i, j) + 3] > 127) {
        x0 = Math.min(x0, i);
        y0 = Math.min(y0, j);
        x1 = Math.max(x1, i);
        y1 = Math.max(y1, j);
      }
  if (x1 < 0) return null;
  // only real pixel art makes sense as beads: a photo/cover (no transparency, thousands of colours) is skipped
  const colors = new Set<number>();
  let clear = 0;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const o = at(i, j);
      if (data[o + 3] <= 127) clear++;
      else colors.add((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
    }
  if (colors.size > 128 || clear < W * H * 0.05) return null;
  const m = 2; // margin (beads) for the halo
  const bw = x1 - x0 + 1 + 2 * m, bh = y1 - y0 + 1 + 2 * m;
  const cell = Math.max(4, Math.min(10, Math.floor(280 / Math.max(bw, bh))));
  const beads = new Map<string, [number, number][]>();
  const all: [number, number][] = [];
  for (let j = y0; j <= y1; j++)
    for (let i = x0; i <= x1; i++) {
      const o = at(i, j);
      if (data[o + 3] <= 127) continue;
      const key = `rgb(${data[o]},${data[o + 1]},${data[o + 2]})`;
      let list = beads.get(key);
      if (!list) beads.set(key, (list = []));
      const b: [number, number] = [i - x0 + m, j - y0 + m];
      list.push(b);
      all.push(b);
    }
  // The beads alone, cut out (transparent between beads and in the centre holes, so the dark backer
  // shows through): ironed beads are rounded, slightly shaded at the rim, with a soft highlight.
  const draw = (c: Ctx2D) => {
    const r = cell * 0.49;
    for (const [col, list] of beads) {
      c.beginPath();
      for (const [i, j] of list) {
        c.moveTo((i + 0.5) * cell + r, (j + 0.5) * cell);
        c.arc((i + 0.5) * cell, (j + 0.5) * cell, r, 0, PI * 2);
      }
      c.fillStyle = col;
      c.fill();
    }
    c.beginPath();
    for (const [i, j] of all) {
      c.moveTo((i + 0.5) * cell + r * 0.8, (j + 0.5) * cell);
      c.arc((i + 0.5) * cell, (j + 0.5) * cell, r * 0.8, 0, PI * 2);
    }
    c.strokeStyle = "rgba(0,0,0,0.16)";
    c.lineWidth = Math.max(0.7, cell * 0.11);
    c.stroke();
    c.beginPath();
    for (const [i, j] of all) {
      const cx = (i + 0.5) * cell, cy = (j + 0.5) * cell;
      c.moveTo(cx + Math.cos(3.6) * r * 0.55, cy + Math.sin(3.6) * r * 0.55);
      c.arc(cx, cy, r * 0.55, 3.6, 4.8);
    }
    c.strokeStyle = "rgba(255,255,255,0.4)";
    c.lineWidth = Math.max(0.8, cell * 0.11);
    c.stroke();
    // punch the centre holes
    c.globalCompositeOperation = "destination-out";
    c.beginPath();
    const hr = Math.max(0.7, cell * 0.13);
    for (const [i, j] of all) {
      c.moveTo((i + 0.5) * cell + hr, (j + 0.5) * cell);
      c.arc((i + 0.5) * cell, (j + 0.5) * cell, hr, 0, PI * 2);
    }
    c.fill();
    c.globalCompositeOperation = "source-over";
  };
  // The backer just behind the beads, also cut out: a near-black core under the sprite (dark gaps and
  // holes) ringed by a soft neon rim about a bead wide, which is what glows.
  const hc = Math.max(2, Math.round(cell / 2));
  const drawHalo = (neon: string) => (c: Ctx2D) => {
    c.beginPath();
    for (const [i, j] of all) {
      c.moveTo((i + 0.5) * hc + hc * 1.35, (j + 0.5) * hc);
      c.arc((i + 0.5) * hc, (j + 0.5) * hc, hc * 1.35, 0, PI * 2);
    }
    c.fillStyle = neon;
    c.fill();
    c.beginPath();
    for (const [i, j] of all) c.rect((i - 0.2) * hc, (j - 0.2) * hc, hc * 1.4, hc * 1.4);
    c.fillStyle = "#07060b";
    c.fill();
  };
  return { w: bw * cell, h: bh * cell, hw: bw * hc, hh: bh * hc, bw, bh, draw, drawHalo };
}

/** Halo colours behind the perler pieces (the room's neon tones). */
const PERLER_NEON = ["#ff3d9a", "#4fd8ff", "#a35cff", "#3dffa8", "#ffb000", "#ff7a1a"];

const SHROOM = ["....RRRR....", "..RRWWRRRR..", ".RRWWWWRRRR.", ".RRRWWRRRWR.", "RRRRRRRRWWWR", "RWWRRRRRRWWR", "RWWWRRRRRRRR", ".RRRRRWWRRR.", "...SSSSSS...", "...SSSSSS...", "...SSSSSS...", "....SSSS...."];
const BLOB = ["....XXX....", "..XXXXXXX..", ".XXXXXXXXX.", "XX..XXX..XX", "XXOOXXXOOXX", "XXXXXXXXXXX", "XXXXXXXXXXX", "X.XX.X.XX.X"];
const HEART = [".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."];
const CAT = ["X...X...", "XX.XX...", "XXXXX...", "XOXOX..X", "XXXXX..X", ".XXXXXXX", ".XXXXXXX", ".X.X.X.X"];

// ---------------------------------------------------------------------------------------------
// textures (all in the builder's one atlas)

async function paint(d: DecorBuilder, ctx: LevelCtx, art: DenArt | null) {
  // Canvases are queued, then packed tallest-first so everything fits a 1024² atlas (the biggest
  // few are drawn at 0.9 scale).
  type Draw = (c: Ctx2D, w: number, h: number) => void;
  const queue: { w: number; h: number; k: number; draw: Draw; rect: UVRect }[] = [];
  const cv = (w: number, h: number, draw: Draw, k = 1): UVRect => {
    const rect = { u0: 0, v0: 0, u1: 0, v1: 0 };
    queue.push({ w, h, k, draw, rect });
    return rect;
  };
  const big = (w: number, h: number, draw: Draw) => cv(w, h, draw, 0.9);
  const st = ctx.store.stats;
  const playing = ctx.store.games.filter((g) => g.status === "playing");
  const nowTitle = (playing[0]?.title ?? "that one RPG").replace(/\s*[:(].*$/, "").slice(0, 18);
  const today = new Date();

  const record = cv(128, 128, (c) => {
    disc(c, 64, 64, 63);
    c.fillStyle = "#0c0b0f";
    c.fill();
    c.lineWidth = 0.8;
    for (let r = 23; r < 62; r += 1.5) {
      c.strokeStyle = `rgba(255,255,255,${0.03 + rand(r) * 0.06})`;
      disc(c, 64, 64, r);
      c.stroke();
    }
    disc(c, 64, 64, 21);
    c.fillStyle = "#ff3d9a";
    c.fill();
    c.beginPath();
    c.moveTo(64, 64);
    c.arc(64, 64, 21, -PI / 2, PI / 2);
    c.fillStyle = "#ffd23f";
    c.fill();
    c.fillStyle = "#1a1020";
    c.font = `7px ${SILK}`;
    c.textAlign = "center";
    c.fillText("SIDE A", 64, 55);
    c.fillText("33", 64, 80);
    disc(c, 64, 64, 2.5);
    c.fillStyle = "#000";
    c.fill();
  });

  const whiteboard = big(512, 320, (c, w, h) => {
    c.fillStyle = "#eef1f4";
    c.fillRect(0, 0, w, h);
    c.globalAlpha = 0.07;
    c.fillStyle = "#4a5a8a";
    for (let i = 0; i < 10; i++) {
      c.beginPath();
      c.ellipse(rnd() * w, rnd() * h, 30 + rnd() * 70, 8 + rnd() * 14, rnd() * 0.4, 0, PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
    c.font = `bold 38px ${HAND}`;
    c.fillStyle = "#d4213d";
    c.fillText("THE BACKLOG PLAN", 22, 50, 330);
    c.strokeStyle = "#d4213d";
    c.lineWidth = 3;
    c.beginPath();
    for (let x = 22; x < 350; x += 4) c.lineTo(x, 62 + Math.sin(x * 0.12) * 2.5);
    c.stroke();
    const items: [string, string, number][] = [
      [`beat ${nowTitle}`, "#1d3fa6", 0],
      ["buy more shelves", "#1d7a3a", 1],
      ["stop buying games", "#1d3fa6", 2],
      ["100% something. anything.", "#1d3fa6", 0],
    ];
    items.forEach(([t, col, kind], i) => {
      const y = 104 + i * 38;
      c.strokeStyle = col;
      c.lineWidth = 2.5;
      c.strokeRect(24, y - 19, 18, 18);
      if (kind === 1) {
        c.beginPath();
        c.moveTo(26, y - 10);
        c.lineTo(33, y - 2);
        c.lineTo(46, y - 26);
        c.stroke();
      }
      c.font = `25px ${HAND}`;
      c.fillStyle = col;
      c.fillText(t, 52, y - 2, 290);
      if (kind === 2) {
        const tw = Math.min(290, c.measureText(t).width);
        c.strokeStyle = "#d4213d";
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(50, y - 10);
        c.lineTo(54 + tw, y - 12);
        c.stroke();
        c.fillStyle = "#d4213d";
        c.font = `21px ${HAND}`;
        c.fillText("lol no", 62 + tw, y - 16);
      }
    });
    c.fillStyle = "#26262a";
    c.font = `22px ${HAND}`;
    c.fillText(`backlog: ${st.backlogHours.toLocaleString()} hrs`, 24, 276, 300);
    c.fillText(st.clearYear ? `done by: ${st.clearYear} (?!)` : "done by: never", 24, 304, 300);
    // graph doodle: the backlog wins
    const gx = 372, gy = 250;
    c.strokeStyle = "#26262a";
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(gx, 110);
    c.lineTo(gx, gy);
    c.lineTo(gx + 124, gy);
    c.stroke();
    c.strokeStyle = "#d4213d";
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(gx + 4, gy - 20);
    for (let k = 1; k <= 8; k++) c.lineTo(gx + 4 + k * 14, gy - 20 - k * k * 1.7 + (k % 2) * 6);
    c.stroke();
    c.strokeStyle = "#1d7a3a";
    c.beginPath();
    c.moveTo(gx + 4, gy - 12);
    for (let k = 1; k <= 8; k++) c.lineTo(gx + 4 + k * 14, gy - 12 - k * 1.6 - (k % 2) * 3);
    c.stroke();
    c.font = `17px ${HAND}`;
    c.fillStyle = "#d4213d";
    c.fillText("games", gx + 66, 120);
    c.fillStyle = "#1d7a3a";
    c.fillText("time", gx + 84, gy - 34);
    c.fillStyle = "#26262a";
    c.fillText("uh oh", gx + 10, 290);
    pixels(c, HEART, 470, 280, 4, { X: "#e8306a" });
  });

  const cork = big(320, 240, (c, w, h) => {
    c.fillStyle = "#a87a4c";
    c.fillRect(0, 0, w, h);
    // cork grain: two batched paths (one fill each) instead of hundreds of fills
    for (const col of ["rgba(70,40,15,0.35)", "rgba(235,195,145,0.3)"]) {
      c.beginPath();
      for (let i = 0; i < 700; i++) c.rect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2);
      c.fillStyle = col;
      c.fill();
    }
    const note = (x: number, y: number, nw: number, nh: number, rot: number, bg: string, pin: string, draw: () => void) => {
      c.save();
      c.translate(x + nw / 2, y + nh / 2);
      c.rotate(rot);
      c.translate(-nw / 2, -nh / 2);
      c.fillStyle = "rgba(0,0,0,0.3)";
      c.fillRect(2, 3, nw, nh);
      c.fillStyle = bg;
      c.fillRect(0, 0, nw, nh);
      draw();
      disc(c, nw / 2, 7, 4.5);
      c.fillStyle = pin;
      c.fill();
      disc(c, nw / 2 - 1.2, 5.8, 1.4);
      c.fillStyle = "rgba(255,255,255,0.7)";
      c.fill();
      c.restore();
    };
    note(16, 14, 92, 86, -0.06, "#ffe45c", "#e8306a", () => {
      // hand-drawn arrows (glyphs like these trigger slow font fallback): up up down down, left right left right
      c.strokeStyle = "#2a2a30";
      c.lineWidth = 2.5;
      c.lineCap = "round";
      const arrow = (x: number, y: number, dx: number, dy: number) => {
        const L = 7, px = -dy, py = dx;
        c.beginPath();
        c.moveTo(x - dx * L, y - dy * L);
        c.lineTo(x + dx * L, y + dy * L);
        c.moveTo(x + dx * (L - 5) + px * 4, y + dy * (L - 5) + py * 4);
        c.lineTo(x + dx * L, y + dy * L);
        c.lineTo(x + dx * (L - 5) - px * 4, y + dy * (L - 5) - py * 4);
        c.stroke();
      };
      [[0, -1], [0, -1], [0, 1], [0, 1]].forEach(([dx, dy], i) => arrow(16 + i * 20, 32, dx, dy));
      [[-1, 0], [1, 0], [-1, 0], [1, 0]].forEach(([dx, dy], i) => arrow(16 + i * 20, 56, dx, dy));
      c.fillStyle = "#2a2a30";
      c.font = `bold 20px ${HAND}`;
      c.fillText("B  A", 26, 82);
    });
    note(124, 10, 84, 102, 0.05, "#f4f2ec", "#4fd8ff", () => {
      c.fillStyle = "#3a2a5c";
      c.fillRect(7, 14, 70, 62);
      pixels(c, CAT, 20, 26, 5.5, { X: "#15121c", O: "#7dff9a" });
      c.fillStyle = "#2a2a30";
      c.font = `15px ${HAND}`;
      c.textAlign = "center";
      c.fillText("the boss", 42, 94);
      c.textAlign = "left";
    });
    note(220, 22, 88, 46, 0.1, "#ff9a3d", "#3dffa8", () => {
      c.fillStyle = "#2a1408";
      c.font = `9px ${PIX}`;
      c.fillText("ADMIT ONE", 8, 24);
      c.font = `8px ${SILK}`;
      c.fillText("RETRO EXPO 26", 8, 38);
      c.fillStyle = "#ffd9b0";
      for (let k = 4; k < 46; k += 6) c.fillRect(70, k, 2, 3);
    });
    note(212, 92, 92, 84, -0.05, "#ff8ac8", "#ffd23f", () => {
      c.fillStyle = "#2a2a30";
      c.font = `19px ${HAND}`;
      c.fillText("tap the", 10, 36);
      c.fillText("window ;)", 10, 60);
    });
    note(20, 116, 112, 74, 0.03, "#fbfbf6", "#a35cff", () => {
      c.strokeStyle = "#9ec3ff";
      c.lineWidth = 1;
      for (let k = 22; k < 74; k += 10) {
        c.beginPath();
        c.moveTo(0, k);
        c.lineTo(112, k);
        c.stroke();
      }
      c.fillStyle = "#d4213d";
      c.font = `bold 17px ${HAND}`;
      c.fillText("LAN PARTY!", 8, 34);
      c.fillStyle = "#1d3fa6";
      c.font = `14px ${HAND}`;
      c.fillText("sat 8pm", 8, 52);
      c.fillText("Quincy + Miles in!", 8, 68, 100);
    });
    note(146, 124, 60, 104, -0.07, "#fdfdfb", "#e8306a", () => {
      c.fillStyle = "#333";
      c.font = `7px ${SILK}`;
      c.fillText("GAME SHOP", 6, 20);
      for (let k = 0; k < 6; k++) {
        c.fillRect(6, 30 + k * 10, 26 + rnd() * 10, 2);
        c.fillRect(44, 30 + k * 10, 10, 2);
      }
      c.fillText("TOTAL", 6, 96);
      c.fillText("$$$", 36, 96);
    });
    note(226, 186, 70, 46, 0.12, "#7af0ff", "#ff3d9a", () => {
      c.fillStyle = "#1a3040";
      c.font = `13px ${HAND}`;
      c.fillText("rematch vs", 6, 26, 60);
      c.fillText("Miles fri!", 6, 40, 60);
    });
  });

  const nightDrive = big(192, 256, (c, w, h) => {
    const hz = h * 0.62;
    const g = c.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, "#12052e");
    g.addColorStop(0.6, "#5a1a6e");
    g.addColorStop(1, "#ff4f8b");
    c.fillStyle = g;
    c.fillRect(0, 0, w, hz);
    for (let i = 0; i < 40; i++) {
      c.fillStyle = `rgba(255,255,255,${0.3 + rnd() * 0.6})`;
      c.fillRect(rnd() * w, rnd() * h * 0.35, 1.5, 1.5);
    }
    const sy = h * 0.5, sr = 50;
    c.save();
    disc(c, w / 2, sy, sr);
    c.clip();
    const sg = c.createLinearGradient(0, sy - sr, 0, sy + sr);
    sg.addColorStop(0, "#ffe14f");
    sg.addColorStop(1, "#ff3d9a");
    c.fillStyle = sg;
    c.fillRect(0, sy - sr, w, sr * 2);
    c.fillStyle = "#6a1c70";
    for (let i = 0; i < 6; i++) c.fillRect(0, sy + 2 + i * 8, w, 2 + i * 0.9);
    c.restore();
    c.fillStyle = "#26093c";
    c.beginPath();
    c.moveTo(0, hz);
    [[0, hz - 18], [24, hz - 34], [44, hz - 14], [70, hz - 40], [96, hz - 12], [130, hz - 30], [158, hz - 8], [176, hz - 26], [192, hz - 14], [192, hz]].forEach(([x, y]) => c.lineTo(x, y));
    c.fill();
    c.fillStyle = "#0b0418";
    c.fillRect(0, hz, w, h - hz);
    c.strokeStyle = "#ff3d9a";
    c.lineWidth = 1.4;
    for (let i = 0; i < 9; i++) {
      const y = hz + Math.pow(i / 8, 1.8) * (h - hz);
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }
    for (let i = -8; i <= 8; i++) {
      c.beginPath();
      c.moveTo(w / 2 + i * 6, hz);
      c.lineTo(w / 2 + i * 40, h);
      c.stroke();
    }
    c.font = `30px ${NEON}`;
    c.textAlign = "center";
    c.fillStyle = "#bff4ff";
    c.shadowColor = "#4fd8ff";
    c.shadowBlur = 10;
    c.fillText("NIGHT", w / 2, 40);
    c.fillText("DRIVE", w / 2, 72);
    c.shadowBlur = 0;
  });

  const hiScores = big(192, 256, (c, w, h) => {
    c.fillStyle = "#07070c";
    c.fillRect(0, 0, w, h);
    c.strokeStyle = "#a35cff";
    c.lineWidth = 4;
    c.strokeRect(6, 6, w - 12, h - 12);
    pixels(c, BLOB, w / 2 - 33, 24, 6, { X: "#3dffa8", O: "#07070c" });
    c.textAlign = "center";
    c.font = `13px ${PIX}`;
    c.fillStyle = "#ffd23f";
    c.fillText("HI-SCORES", w / 2, 104);
    const rows: [string, string, string, string][] = [
      ["1ST", "COOPER", "999990", "#ff3d9a"],
      ["2ND", "QUINCY", "512400", "#4fd8ff"],
      ["3RD", "MILES", "248600", "#ffffff"],
      ["4TH", "???", "000000", "#777788"],
    ];
    c.font = `8px ${PIX}`;
    rows.forEach(([r, n, s, col], i) => {
      const y = 134 + i * 24;
      c.fillStyle = col;
      c.textAlign = "left";
      c.fillText(r, 16, y);
      c.fillText(n, 52, y);
      c.textAlign = "right";
      c.fillText(s, w - 16, y);
    });
    c.textAlign = "center";
    c.fillStyle = "#ff3d9a";
    c.fillText("INSERT COIN", w / 2, h - 20);
  });

  const extraLife = big(192, 256, (c, w, h) => {
    c.fillStyle = "#1f2a86";
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#26339c";
    for (let y = 0; y < h; y += 16) for (let x = (y / 16) % 2 ? 0 : 16; x < w; x += 32) c.fillRect(x, y, 16, 16);
    c.fillStyle = "rgba(0,0,0,0.35)";
    pixels(c, SHROOM, 34 + 6, 44 + 6, 10.5, { R: "rgba(0,0,0,0.35)", W: "rgba(0,0,0,0.35)", S: "rgba(0,0,0,0.35)" });
    pixels(c, SHROOM, 34, 44, 10.5, { R: "#e8303a", W: "#fff4e4", S: "#f2dcb6" });
    c.textAlign = "center";
    c.font = `14px ${PIX}`;
    c.fillStyle = "#000";
    c.fillText("EXTRA LIFE", w / 2 + 2, 216);
    c.fillStyle = "#fff";
    c.fillText("EXTRA LIFE", w / 2, 214);
    c.font = `22px ${PIX}`;
    c.fillStyle = "#ffd23f";
    c.fillText("+1", w - 30, 34);
  });

  const blueprint = big(192, 256, (c, w, h) => {
    c.fillStyle = "#16438f";
    c.fillRect(0, 0, w, h);
    c.strokeStyle = "rgba(255,255,255,0.12)";
    c.lineWidth = 1;
    for (let x = 0; x < w; x += 12) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
    }
    for (let y = 0; y < h; y += 12) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }
    c.strokeStyle = "#eef4ff";
    c.lineWidth = 2;
    rrect(c, 24, 100, 144, 60, 28);
    c.stroke();
    c.strokeRect(46, 122, 22, 8);
    c.strokeRect(53, 115, 8, 22);
    disc(c, 130, 134, 8);
    c.stroke();
    disc(c, 150, 122, 8);
    c.stroke();
    c.strokeRect(84, 126, 10, 5);
    c.strokeRect(100, 126, 10, 5);
    c.font = `8px ${SILK}`;
    c.fillStyle = "#eef4ff";
    c.lineWidth = 1;
    const label = (t: string, x: number, y: number, tx: number, ty: number) => {
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(tx, ty);
      c.stroke();
      c.fillText(t, tx - 8, ty + (ty < y ? -4 : 10));
    };
    label("D-PAD", 57, 116, 40, 80);
    label("A", 150, 114, 158, 84);
    label("B", 130, 142, 140, 186);
    label("START", 105, 131, 96, 190);
    c.font = `12px ${SILK}`;
    c.fillText("CONTROLLER", 14, 28);
    c.font = `8px ${SILK}`;
    c.fillText("MK-II  SCHEMATIC", 14, 44);
    c.fillText("SHEET 1/1   REV C", 14, 240);
    c.strokeRect(8, 8, w - 16, h - 16);
  });

  const clock = cv(128, 128, (c) => {
    disc(c, 64, 64, 63);
    c.fillStyle = "#120d1c";
    c.fill();
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * PI * 2, big = i % 5 === 0;
      c.strokeStyle = big ? "#ff3d9a" : "#6a5a80";
      c.lineWidth = big ? 3 : 1.2;
      c.beginPath();
      c.moveTo(64 + Math.sin(a) * (big ? 48 : 53), 64 - Math.cos(a) * (big ? 48 : 53));
      c.lineTo(64 + Math.sin(a) * 58, 64 - Math.cos(a) * 58);
      c.stroke();
    }
    c.font = `13px ${SILK}`;
    c.fillStyle = "#7fe6ff";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("12", 64, 32);
    c.fillText("6", 64, 97);
    c.fillText("3", 96, 65);
    c.fillText("9", 32, 65);
    c.font = `6px ${SILK}`;
    c.fillStyle = "#a35cff";
    c.fillText("LATE NITE", 64, 82);
  });

  const calendar = big(160, 224, (c, w, h) => {
    c.fillStyle = "#f4f1ea";
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#2a0f3e";
    c.fillRect(0, 0, w, 96);
    c.fillStyle = "#ff3d9a";
    c.fillRect(0, 70, w, 26);
    pixels(c, BLOB, 18, 14, 4.5, { X: "#4fd8ff", O: "#2a0f3e" });
    c.font = `12px ${PIX}`;
    c.fillStyle = "#ffd23f";
    c.fillText(`LVL ${today.getMonth() + 1}`, 76, 44);
    c.font = `11px ${SILK}`;
    c.fillStyle = "#fff";
    const month = today.toLocaleString("en", { month: "long" }).toUpperCase();
    c.fillText(`${month} ${today.getFullYear()}`, 8, 88, w - 16);
    const first = new Date(today.getFullYear(), today.getMonth(), 1).getDay();
    const days = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    c.font = `8px ${SILK}`;
    c.fillStyle = "#555";
    "SMTWTFS".split("").forEach((ch, i) => c.fillText(ch, 8 + i * 21, 110));
    for (let day = 1; day <= days; day++) {
      const k = first + day - 1;
      const x = 6 + (k % 7) * 21, y = 126 + Math.floor(k / 7) * 18;
      c.fillStyle = "#333";
      c.fillText(String(day), x + 2, y);
      if (day < today.getDate()) {
        c.strokeStyle = "#d4213d";
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(x, y - 9);
        c.lineTo(x + 14, y + 3);
        c.moveTo(x + 14, y - 9);
        c.lineTo(x, y + 3);
        c.stroke();
      } else if (day === today.getDate()) {
        c.strokeStyle = "#1d3fa6";
        c.lineWidth = 2;
        disc(c, x + 7, y - 3, 9);
        c.stroke();
      }
      // plans with the crew a few days out
      const who = day === today.getDate() + 3 ? "Quincy" : day === today.getDate() + 8 ? "Miles" : "";
      if (who) {
        c.strokeStyle = "#ff3d9a";
        c.lineWidth = 1.5;
        c.strokeRect(x - 2, y - 11, 21, 18);
        c.fillStyle = "#c2186b";
        c.font = `8px ${HAND}`;
        c.fillText(who, x - 1, y + 6, 21);
        c.font = `8px ${SILK}`;
      }
    }
    for (let i = 0; i < 6; i++) {
      disc(c, 18 + i * 25, 6, 3);
      c.fillStyle = "#777";
      c.fill();
    }
  });

  const MAGS: [string, string, string][] = [
    ["PIXEL", "#ff3d9a", "#2b0b3d"],
    ["8-BIT", "#ffd23f", "#0d2b5c"],
    ["CHEAT!", "#3dffa8", "#14141c"],
    ["NXT LVL", "#4fd8ff", "#3a0b2a"],
    ["BOSS", "#ff7a1a", "#151515"],
    ["RETRO", "#a35cff", "#f2e8d0"],
  ];
  const mags = MAGS.map(([name, accent, bg], i) =>
    cv(72, 96, (c, w, h) => {
      c.fillStyle = bg;
      c.fillRect(0, 0, w, h);
      const g = c.createRadialGradient(w * 0.6, h * 0.6, 4, w * 0.6, h * 0.6, 40);
      g.addColorStop(0, accent);
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.fillRect(0, 20, w, h - 20);
      if (i % 2) pixels(c, BLOB, 28, 44, 3.2, { X: "#ffffff", O: bg });
      else pixels(c, HEART, 32, 46, 4.5, { X: "#ffffff" });
      c.font = `700 19px ${OSW}`;
      c.fillStyle = accent;
      c.fillText(name, 4, 19, w - 8);
      c.fillStyle = i === 5 ? "#333" : "#fff";
      for (let k = 0; k < 4; k++) c.fillRect(4, 30 + k * 8, 14 + rnd() * 10, 3);
      c.font = `7px ${SILK}`;
      c.fillText(`#${12 + i * 7}`, 4, h - 6);
    }),
  );

  const TITLES = ["QUEST", "RACER", "SAGA", "BLAST", "ODYSSEY", "TACTICS"];
  const cases = TITLES.map((title, i) =>
    cv(48, 66, (c, w, h) => {
      const hue = (i * 61 + 190) % 360;
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, `hsl(${hue},65%,45%)`);
      g.addColorStop(1, `hsl(${(hue + 40) % 360},70%,18%)`);
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      c.fillStyle = "#eef0f4";
      c.fillRect(0, 0, w, 8);
      c.fillStyle = `hsl(${(hue + 180) % 360},80%,60%)`;
      c.fillRect(0, 8, w, 2);
      disc(c, w / 2, h * 0.55, 12 + rnd() * 6);
      c.fillStyle = `hsl(${(hue + 150) % 360},85%,62%)`;
      c.fill();
      c.font = `7px ${SILK}`;
      c.fillStyle = "#fff";
      c.textAlign = "center";
      c.fillText(title, w / 2, 22);
    }),
  );

  // Happy Juice: the den's drink of choice (a smiling sun, bubbly type, a wave band)
  const JUICE: [string, string, string][] = [
    ["#ff4f9a", "#ffe45c", "#ffffff"],
    ["#2fc8ff", "#ff3d9a", "#ffffff"],
    ["#8a3dff", "#3dffa8", "#ffffff"],
    ["#ffd23f", "#ff5a1f", "#5a1030"],
  ];
  const juiceLabel = ([bg, accent, ink]: [string, string, string]) => (c: Ctx2D, w: number, h: number) => {
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    // wave band along the bottom + pinstripe on top
    c.fillStyle = accent;
    c.beginPath();
    c.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) c.lineTo(x, h - 7 + Math.sin((x / w) * PI * 8) * 2);
    c.lineTo(w, h);
    c.fill();
    c.fillRect(0, 3, w, 2);
    // two faces around the can (each half the circumference): a smiling sun over "Happy / Juice"
    for (const ox of [0, w / 2]) {
      const cx = ox + w / 4, sy = 13;
      c.fillStyle = accent;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * PI * 2;
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * 6, sy + Math.sin(a) * 6);
        c.lineTo(cx + Math.cos(a + 0.22) * 9.5, sy + Math.sin(a + 0.22) * 9.5);
        c.lineTo(cx + Math.cos(a - 0.22) * 9.5, sy + Math.sin(a - 0.22) * 9.5);
        c.fill();
      }
      disc(c, cx, sy, 6);
      c.fill();
      c.strokeStyle = bg;
      c.lineWidth = 1.2;
      c.beginPath();
      c.arc(cx, sy + 0.5, 3.2, 0.25, PI - 0.25);
      c.stroke();
      c.fillStyle = bg;
      c.fillRect(cx - 2.6, sy - 2.6, 1.4, 1.8);
      c.fillRect(cx + 1.2, sy - 2.6, 1.4, 1.8);
      c.textAlign = "center";
      c.lineWidth = 3;
      c.strokeStyle = accent;
      c.fillStyle = ink;
      c.font = `bold 13px ${HAND}`;
      c.strokeText("Happy", cx, 33, w / 2 - 6);
      c.fillText("Happy", cx, 33, w / 2 - 6);
      c.font = `bold 12px ${HAND}`;
      c.strokeText("Juice", cx, 45, w / 2 - 10);
      c.fillText("Juice", cx, 45, w / 2 - 10);
      c.textAlign = "left";
    }
  };
  const cans = JUICE.map((pal) => cv(128, 56, juiceLabel(pal)));

  const BINS = ["CABLES", "PADS", "MANUALS", "MEMORY", "ADAPTERS", "MISC", "SPARES", "???"];
  const bins = BINS.map((t) =>
    cv(112, 32, (c, w, h) => {
      c.fillStyle = "#e2d2a8";
      c.fillRect(0, 0, w, h);
      c.fillStyle = "#2a2018";
      c.font = `19px ${HAND}`;
      c.textAlign = "center";
      c.fillText(t, w / 2, 23, w - 8);
    }),
  );

  const keyboard = cv(256, 80, (c, w, h) => {
    c.fillStyle = "#cfc5ac";
    c.fillRect(0, 0, w, h);
    const key = (x: number, y: number, kw: number) => {
      c.fillStyle = "#a99f88";
      c.fillRect(x, y + 1.5, kw, 9);
      c.fillStyle = "#ece5d2";
      c.fillRect(x, y, kw, 8.5);
    };
    for (let i = 0; i < 13; i++) key(6 + i * 14.5, 4, 11);
    for (let r = 0; r < 4; r++) for (let i = 0; i < 13 - (r === 3 ? 2 : 0); i++) key(6 + r * 3 + i * 14.5, 18 + r * 12, 12);
    key(40, 66, 110);
    for (let r = 0; r < 5; r++) for (let i = 0; i < 3; i++) key(204 + i * 14, 18 + r * 12, 11);
    c.fillStyle = "#3dff6a";
    c.fillRect(206, 6, 4, 3);
    c.fillRect(218, 6, 4, 3);
  });

  const pizza = cv(128, 128, (c) => {
    disc(c, 64, 64, 62);
    c.fillStyle = "#c98a45";
    c.fill();
    disc(c, 64, 64, 54);
    c.fillStyle = "#b83a1e";
    c.fill();
    for (let i = 0; i < 46; i++) {
      const a = rnd() * PI * 2, r = rnd() * 48;
      c.fillStyle = rnd() < 0.5 ? "#f4c95a" : "#f7d878";
      c.beginPath();
      c.ellipse(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 6 + rnd() * 6, 4 + rnd() * 4, rnd() * 3, 0, PI * 2);
      c.fill();
    }
    for (let i = 0; i < 10; i++) {
      const a = i * 2.4, r = 14 + (i % 3) * 13;
      disc(c, 64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 6.5);
      c.fillStyle = "#9e2a1e";
      c.fill();
    }
    c.strokeStyle = "rgba(90,40,10,0.6)";
    c.lineWidth = 1.2;
    for (let i = 0; i < 8; i++) {
      c.beginPath();
      c.moveTo(64, 64);
      c.lineTo(64 + Math.cos((i * PI) / 4) * 62, 64 + Math.sin((i * PI) / 4) * 62);
      c.stroke();
    }
    c.globalCompositeOperation = "destination-out";
    c.beginPath();
    c.moveTo(64, 64);
    c.arc(64, 64, 70, 0, PI / 2);
    c.closePath();
    c.fill();
    c.globalCompositeOperation = "source-over";
  });

  const pizzaLid = cv(128, 128, (c, w, h) => {
    c.fillStyle = "#efe6d2";
    c.fillRect(0, 0, w, h);
    // tricolore corners
    for (const [i, col] of ["#1d8a3a", "#f4f1ea", "#c8262c"].entries()) {
      c.fillStyle = col;
      c.fillRect(i * 10, 0, 10, 6);
      c.fillRect(w - 30 + i * 10, h - 6, 10, 6);
    }
    c.strokeStyle = "#c8262c";
    c.lineWidth = 3;
    disc(c, w / 2, h / 2, 50);
    c.stroke();
    c.lineWidth = 1.2;
    disc(c, w / 2, h / 2, 45);
    c.stroke();
    // Vesuvius + a pie
    c.fillStyle = "#1d8a3a";
    c.beginPath();
    c.moveTo(w / 2 - 24, 70);
    c.lineTo(w / 2 - 6, 50);
    c.lineTo(w / 2 + 6, 50);
    c.lineTo(w / 2 + 24, 70);
    c.fill();
    c.fillStyle = "#c8262c";
    for (const [x, y, r] of [[-2, 45, 3], [3, 40, 2.5], [-1, 35, 2]]) disc(c, w / 2 + x, y, r), c.fill();
    // arched NAPOLI
    c.font = `700 15px ${OSW}`;
    c.fillStyle = "#c8262c";
    c.textAlign = "center";
    c.textBaseline = "middle";
    const word = "NAPOLI";
    [...word].forEach((ch, i) => {
      const a = -PI / 2 + (i - (word.length - 1) / 2) * 0.32;
      c.save();
      c.translate(w / 2 + Math.cos(a) * 34, h / 2 + Math.sin(a) * 34);
      c.rotate(a + PI / 2);
      c.fillText(ch, 0, 0);
      c.restore();
    });
    c.font = `700 12px ${OSW}`;
    c.fillText("PIZZERIA", w / 2, 82);
    c.font = `6px ${SILK}`;
    c.fillStyle = "#1d8a3a";
    c.fillText("FORNO A LEGNA  -  DAL 1987", w / 2, 95);
    c.textBaseline = "alphabetic";
  });
  const pizzaSide = cv(256, 24, (c, w, h) => {
    c.fillStyle = "#e8dcc2";
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#1d8a3a";
    c.fillRect(0, 0, w, 3);
    c.fillStyle = "#c8262c";
    c.fillRect(0, h - 3, w, 3);
    c.font = `700 14px ${OSW}`;
    c.fillStyle = "#c8262c";
    c.textAlign = "center";
    c.fillText("NAPOLI PIZZERIA", w / 2, 18);
    c.font = `7px ${SILK}`;
    c.fillStyle = "#1d8a3a";
    c.fillText("HOT  &  FRESH", 34, 15);
    c.fillText("CALL 555-0187", w - 38, 15);
  });

  const leaf = cv(128, 128, (c) => {
    c.beginPath();
    c.moveTo(64, 122);
    c.bezierCurveTo(2, 112, -2, 28, 60, 6);
    c.bezierCurveTo(72, 2, 132, 22, 122, 82);
    c.bezierCurveTo(116, 108, 82, 118, 64, 122);
    const g = c.createRadialGradient(64, 70, 10, 64, 64, 70);
    g.addColorStop(0, "#3e9a4a");
    g.addColorStop(1, "#1f5e2c");
    c.fillStyle = g;
    c.fill();
    c.globalCompositeOperation = "destination-out";
    c.lineCap = "round";
    c.lineWidth = 4.5;
    for (const [x0, y0, x1, y1] of [
      [8, 52, 40, 60], [12, 80, 44, 82], [28, 30, 50, 44], [26, 104, 52, 98],
      [120, 56, 86, 62], [116, 86, 84, 84], [100, 26, 76, 42], [104, 106, 78, 100],
    ]) {
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(x1, y1);
      c.stroke();
    }
    c.globalCompositeOperation = "source-over";
    c.strokeStyle = "#7cc47e";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(64, 122);
    c.quadraticCurveTo(58, 60, 60, 8);
    c.stroke();
  });

  const stickers = [
    cv(48, 48, (c) => {
      pixels(c, HEART, 3, 7, 6, { X: "#ffffff" });
      pixels(c, HEART, 7, 10, 4.9, { X: "#ff2d6a" });
    }),
    cv(48, 48, (c) => {
      const star = (r1: number, r2: number) => {
        c.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * PI * 2 - PI / 2, r = i % 2 ? r2 : r1;
          c.lineTo(24 + Math.cos(a) * r, 25 + Math.sin(a) * r);
        }
        c.closePath();
      };
      star(23, 11);
      c.fillStyle = "#fff";
      c.fill();
      star(18, 8);
      c.fillStyle = "#ffd23f";
      c.fill();
    }),
    cv(48, 48, (c) => {
      const bolt = () => {
        c.beginPath();
        [[28, 2], [10, 27], [22, 27], [16, 46], [38, 18], [26, 18], [32, 2]].forEach(([x, y]) => c.lineTo(x, y));
        c.closePath();
      };
      c.lineWidth = 6;
      c.strokeStyle = "#fff";
      bolt();
      c.stroke();
      c.fillStyle = "#4fd8ff";
      c.fill();
    }),
    cv(48, 48, (c) => {
      rrect(c, 3, 6, 42, 30, 10);
      c.fillStyle = "#fff";
      c.fill();
      rrect(c, 6, 9, 36, 24, 8);
      c.fillStyle = "#ff3d9a";
      c.fill();
      c.beginPath();
      c.moveTo(12, 32);
      c.lineTo(8, 44);
      c.lineTo(22, 32);
      c.fill();
      c.font = `11px ${PIX}`;
      c.fillStyle = "#fff";
      c.textAlign = "center";
      c.fillText("GG", 24, 27);
    }),
  ];

  const deck = cv(64, 256, (c, w, h) => {
    rrect(c, 0, 0, w, h, 31);
    c.save();
    c.clip();
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#ff3d9a");
    g.addColorStop(0.5, "#6a1fb0");
    g.addColorStop(1, "#18c8e8");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = "rgba(255,255,255,0.18)";
    for (let i = 0; i < 9; i++) c.fillRect(0, 20 + i * 26, w, 6);
    pixels(c, BLOB, 10, 92, 4, { X: "#0d0a14", O: "#ffd23f" });
    c.save();
    c.translate(w / 2 + 6, 200);
    c.rotate(-PI / 2);
    c.font = `16px ${PIX}`;
    c.fillStyle = "#fff";
    c.textAlign = "center";
    c.fillText("DEN", 0, 0);
    c.restore();
    c.restore();
  });

  const boxLabel = cv(128, 72, (c, w, h) => {
    c.fillStyle = "#f5f0e6";
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#c8262c";
    c.font = `bold 26px ${HAND}`;
    c.fillText("BACKLOG", 8, 30, w - 14);
    c.fillStyle = "#26262a";
    c.font = `16px ${HAND}`;
    c.fillText("do not open", 10, 50);
    c.fillText(`(until ${st.clearYear ?? "????"})`, 10, 66);
  });

  const fragile = cv(96, 36, (c, w, h) => {
    c.strokeStyle = "#c8262c";
    c.lineWidth = 3;
    c.strokeRect(3, 3, w - 6, h - 6);
    c.fillStyle = "#c8262c";
    c.font = `700 20px ${OSW}`;
    c.textAlign = "center";
    c.fillText("FRAGILE", w / 2, 26);
  });

  const sleeves = [0, 1, 2, 3].map((i) =>
    cv(64, 64, (c, w, h) => {
      const pal = [["#1a0b2e", "#ff3d9a"], ["#f2e3c4", "#2b5f8a"], ["#0b2a2a", "#3dffa8"], ["#2a1a0b", "#ffb000"]][i];
      c.fillStyle = pal[0];
      c.fillRect(0, 0, w, h);
      c.strokeStyle = pal[1];
      c.fillStyle = pal[1];
      if (i === 0) for (let k = 0; k < 6; k++) c.fillRect(0, 34 + k * 5, w, 2 + k * 0.4);
      if (i === 1) {
        disc(c, 32, 30, 18);
        c.fill();
      }
      if (i === 2) {
        c.lineWidth = 2;
        for (let k = 0; k < 5; k++) {
          disc(c, 32, 32, 6 + k * 5);
          c.stroke();
        }
      }
      if (i === 3) for (let k = 0; k < 8; k++) c.fillRect(k * 8, 64 - (8 + rnd() * 40), 6, 64);
      c.font = `7px ${SILK}`;
      c.fillStyle = i === 1 ? "#222" : "#fff";
      c.fillText(["SYNTH CITY", "LO-FI BEATS", "CHIPTUNE", "ARCADE OST"][i], 4, 10);
    }),
  );

  const heart = cv(64, 64, (c) => pixels(c, HEART, 4, 10, 8, { X: "#ff3d9a" }));

  const notes = ["#ffe45c", "#ff8ac8", "#7af0ff"].map((bg) =>
    cv(40, 40, (c, w, h) => {
      c.fillStyle = bg;
      c.fillRect(0, 0, w, h);
      scribble(c, 5, 12, 28, 3, "#2a2a40", 8);
    }),
  );

  const screen = cv(80, 48, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#4fb6ff");
    g.addColorStop(1, "#bfe8ff");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#3a9a3a";
    c.fillRect(0, 36, w, 12);
    c.fillStyle = "#8a5a2a";
    c.fillRect(0, 42, w, 6);
    c.fillStyle = "#fff";
    c.fillRect(10, 8, 14, 5);
    c.fillRect(50, 12, 18, 5);
    pixels(c, [".XX.", "XXXX", "X..X"], 30, 24, 3, { X: "#ff3d9a" });
    c.fillStyle = "#ffd23f";
    for (let k = 0; k < 4; k++) disc(c, 48 + k * 7, 24, 2), c.fill();
    c.fillStyle = "#222";
    c.font = `6px ${SILK}`;
    c.fillText("x03  0420", 4, 6);
  });

  const tokens = cv(64, 24, (c, w, h) => {
    c.fillStyle = "#1a1020";
    c.fillRect(0, 0, w, h);
    c.font = `8px ${PIX}`;
    c.fillStyle = "#ffd23f";
    c.textAlign = "center";
    c.fillText("TOKENS", w / 2, 16);
  });

  const sevenSeg = cv(32, 16, (c, w, h) => {
    c.fillStyle = "#120404";
    c.fillRect(0, 0, w, h);
    c.font = `12px ${PIX}`;
    c.fillStyle = "#ff3b2a";
    c.fillText("66", 3, 14);
  });

  const handBag = cv(64, 64, (c, w, h) => {
    // a chip bag: foil gradient, bold brand-less label
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#ffd23f");
    g.addColorStop(1, "#ff7a1a");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#c8262c";
    c.font = `700 17px ${OSW}`;
    c.textAlign = "center";
    c.fillText("CRUNCH", w / 2, 30);
    c.fillStyle = "#fff";
    c.font = `7px ${SILK}`;
    c.fillText("XTRA CHEESY", w / 2, 44);
  });

  const roundRug = cv(160, 160, (c) => {
    const ring = (r: number, col: string) => {
      disc(c, 80, 80, r);
      c.fillStyle = col;
      c.fill();
    };
    ring(79, "#ff3d9a");
    ring(74, "#2a1440");
    ring(60, "#1e7a8a");
    ring(56, "#2a1440");
    ring(40, "#a35cff");
    ring(36, "#1c0f2e");
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * PI * 2;
      c.fillStyle = i % 2 ? "#ffd23f" : "#4fd8ff";
      c.fillRect(80 + Math.cos(a) * 66 - 2, 80 + Math.sin(a) * 66 - 2, 4, 4);
    }
    pixels(c, HEART, 66, 70, 4, { X: "#ff3d9a" });
  });

  const pegboard = cv(128, 108, (c, w, h) => {
    c.fillStyle = "#e9e2d2";
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#4a4238";
    for (let y = 6; y < h; y += 12) for (let x = 6; x < w; x += 12) c.fillRect(x - 1.5, y - 1.5, 3, 3);
  });

  const pennant = cv(256, 96, (c, w, h) => {
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(w, h / 2);
    c.lineTo(0, h);
    c.closePath();
    c.fillStyle = "#c2186b";
    c.fill();
    c.fillStyle = "#f4f1ea";
    c.fillRect(0, 0, 18, h);
    c.font = `22px ${PIX}`;
    c.fillStyle = "#ffe45c";
    c.fillText("PLAYER 1", 28, h / 2 + 10, w * 0.62);
  });

  // ---- real art: record sleeves + labels, magazine covers, perler bead patterns ----
  let recSleeves = sleeves;
  let recColors = ["#1a1a22", "#d8262f", "#f2e8d0", "#2a5f9a", "#ffb000", "#3a1f4a", "#1d7a5a"];
  let recordDisc = record;
  let magCovers = mags;
  const perlers: Perler[] = [];
  if (art) {
    const { man, img } = art;
    const recs = man.records;
    if (recs.length) {
      // sleeves on show: the platter's, two leaning on the wall, one face-out in the credenza, two by
      // the crate, one framed on the figure shelf; the rest only show their spines
      recSleeves = recs.slice(0, 6).map((r) =>
        cv(160, 160, (c, w, h) => {
          c.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, w, h);
          // a little shelf wear: ring wear + softened edges
          c.strokeStyle = "rgba(255,255,255,0.07)";
          c.lineWidth = 3;
          disc(c, w / 2, h / 2, w * 0.42);
          c.stroke();
          c.strokeStyle = "rgba(0,0,0,0.35)";
          c.lineWidth = 2;
          c.strokeRect(1, 1, w - 2, h - 2);
        }),
      );
      recColors = recs.map((r) => averageColor(img, r));
      const r0 = recs[0];
      recordDisc = cv(128, 128, (c) => {
        disc(c, 64, 64, 63);
        c.fillStyle = "#0c0b0f";
        c.fill();
        c.lineWidth = 0.8;
        for (let r = 25; r < 62; r += 1.5) {
          c.strokeStyle = `rgba(255,255,255,${0.03 + rand(r) * 0.06})`;
          disc(c, 64, 64, r);
          c.stroke();
        }
        // centre label printed with the album art
        c.save();
        disc(c, 64, 64, 23);
        c.clip();
        c.drawImage(img, r0.x, r0.y, r0.w, r0.h, 64 - 23, 64 - 23, 46, 46);
        c.restore();
        disc(c, 64, 64, 2.5);
        c.fillStyle = "#000";
        c.fill();
      });
    }
    const covers = man.magazines.slice(0, 10);
    if (covers.length)
      magCovers = covers.map((m) =>
        cv(120, 160, (c, w, h) => {
          c.drawImage(img, m.x, m.y, m.w, m.h, 0, 0, w, h);
          c.fillStyle = "rgba(255,255,255,0.06)";
          c.fillRect(0, 0, 3, h); // spine crease
        }),
      );
    for (const sp of man.sprites.slice(0, 24)) {
      await tick();
      const bead = beadPattern(img, sp);
      if (!bead) continue;
      const neon = PERLER_NEON[perlers.length % PERLER_NEON.length];
      perlers.push({ rect: cv(bead.w, bead.h, bead.draw), halo: cv(bead.hw, bead.hh, bead.drawHalo(neon)), bw: bead.bw, bh: bead.bh, name: sp.name, game: sp.game });
    }
  }

  queue.sort((a, b) => b.h * b.k - a.h * a.k);
  for (const q of queue) {
    Object.assign(q.rect, d.canvas(q.w * q.k, q.h * q.k, (c) => {
      c.scale(q.k, q.k);
      q.draw(c, q.w, q.h);
    }));
    await tick();
  }

  return { record, whiteboard, cork, nightDrive, hiScores, extraLife, blueprint, clock, calendar, mags, cases, cans, bins, keyboard, pizza, pizzaLid, pizzaSide, leaf, stickers, deck, boxLabel, fragile, sleeves, heart, notes, screen, tokens, sevenSeg, handBag, roundRug, pegboard, pennant, recSleeves, recColors, recordDisc, magCovers, perlers };
}
type Tex = Awaited<ReturnType<typeof paint>>;

// ---------------------------------------------------------------------------------------------
// small props (origin = centre of the footprint on the surface they stand on; front = +z)

function framed(d: DecorBuilder, w: number, h: number, tex: UVRect, frame: Color, o: { border?: number; depth?: number; glow?: number } = {}) {
  const b = o.border ?? 0.022, dp = o.depth ?? 0.024;
  d.box([w + 2 * b, b, dp], [0, h / 2 + b / 2, dp / 2], frame, { rough: 0.45, metal: 0.2 });
  d.box([w + 2 * b, b, dp], [0, -h / 2 - b / 2, dp / 2], frame, { rough: 0.45, metal: 0.2 });
  d.box([b, h, dp], [-w / 2 - b / 2, 0, dp / 2], frame, { rough: 0.45, metal: 0.2 });
  d.box([b, h, dp], [w / 2 + b / 2, 0, dp / 2], frame, { rough: 0.45, metal: 0.2 });
  d.box([w, h, 0.006], [0, 0, 0.003], "#0c0b10");
  d.plane([w, h], [0, 0, 0.0075], "#ffffff", { tex, glow: o.glow ?? 0.07, rough: 0.45 });
}

/** Wall outlet (two sockets), optionally with a plug + cable running to `to` (local coords). */
function outlet(d: DecorBuilder, cableTo?: Vec3[]) {
  rbox(d, [0.075, 0.12, 0.008], [0, 0, 0.004], "#ece6d6", { r: 0.008, rough: 0.5 });
  for (const y of [-0.026, 0.026]) {
    d.box([0.004, 0.014, 0.002], [-0.008, y, 0.0085], "#2a2830");
    d.box([0.004, 0.014, 0.002], [0.008, y, 0.0085], "#2a2830");
  }
  if (cableTo) {
    rbox(d, [0.032, 0.036, 0.022], [0, -0.026, 0.019], "#1a1a20", { r: 0.006 });
    cable(d, [[0, -0.044, 0.02], [0, -0.07, 0.03], ...cableTo]);
  }
}

function nesLike(d: DecorBuilder) {
  const W = 0.25, D = 0.2;
  d.box([W, 0.045, D], [0, 0.0225, 0], "#7b7b82", { rough: 0.55 });
  d.box([W, 0.04, D], [0, 0.065, 0], "#c7c5bf", { rough: 0.55 });
  d.box([W * 0.62, 0.002, D * 0.5], [-W * 0.12, 0.0855, -D * 0.12], "#a3a19b");
  d.box([W * 0.998, 0.03, 0.004], [0, 0.022, D / 2 + 0.001], "#1a1a1e");
  d.box([0.024, 0.012, 0.006], [-W * 0.33, 0.024, D / 2 + 0.003], "#c7c5bf");
  d.box([0.024, 0.012, 0.006], [-W * 0.19, 0.024, D / 2 + 0.003], "#c7c5bf");
  d.box([0.006, 0.005, 0.004], [-W * 0.43, 0.024, D / 2 + 0.003], "#ff2a2a", { glow: 2.5 });
  d.box([0.026, 0.014, 0.003], [W * 0.17, 0.022, D / 2 + 0.003], "#050506");
  d.box([0.026, 0.014, 0.003], [W * 0.33, 0.022, D / 2 + 0.003], "#050506");
  for (let i = 0; i < 6; i++) d.box([0.004, 0.002, D * 0.4], [W * 0.2 + i * 0.011, 0.0855, -D * 0.1], "#8d8b86");
}

function snesLike(d: DecorBuilder) {
  rbox(d, [0.24, 0.045, 0.2], [0, 0.0225, 0], "#c9c7c1", { r: 0.035, axis: "y", rough: 0.55 });
  rbox(d, [0.2, 0.03, 0.16], [0, 0.06, -0.008], "#d0cec9", { r: 0.03, axis: "y", rough: 0.55 });
  d.box([0.12, 0.004, 0.03], [0, 0.0755, -0.02], "#2b2a30");
  d.box([0.022, 0.01, 0.014], [-0.075, 0.078, 0.045], "#7a6ab8");
  d.box([0.022, 0.01, 0.014], [0.075, 0.078, 0.045], "#7a6ab8");
  d.box([0.016, 0.008, 0.012], [0, 0.077, 0.05], "#8e8c88");
  d.box([0.024, 0.014, 0.003], [-0.03, 0.022, 0.1015], "#18181c");
  d.box([0.024, 0.014, 0.003], [0.03, 0.022, 0.1015], "#18181c");
  d.box([0.006, 0.004, 0.003], [-0.07, 0.034, 0.1015], "#ff3030", { glow: 2.5 });
}

function n64Like(d: DecorBuilder, label: Color) {
  rbox(d, [0.26, 0.05, 0.19], [0, 0.025, 0], "#2a2a30", { r: 0.05, axis: "y", rough: 0.45 });
  rbox(d, [0.13, 0.03, 0.13], [0, 0.065, -0.01], "#313138", { r: 0.04, axis: "y", rough: 0.45 });
  rbox(d, [0.11, 0.07, 0.02], [0, 0.105, -0.015], "#4a4a52", { r: 0.008 });
  d.box([0.08, 0.04, 0.002], [0, 0.112, -0.004], label);
  d.box([0.02, 0.012, 0.012], [-0.09, 0.054, 0.05], "#5a5a62");
  d.box([0.016, 0.01, 0.01], [0.09, 0.054, 0.05], "#5a5a62");
  for (let i = 0; i < 4; i++) d.box([0.022, 0.012, 0.003], [-0.075 + i * 0.05, 0.022, 0.0955], "#0a0a0c");
  d.box([0.006, 0.003, 0.006], [-0.06, 0.0505, 0.07], "#ff3030", { glow: 2.5 });
}

function ps1Like(d: DecorBuilder) {
  rbox(d, [0.27, 0.055, 0.19], [0, 0.0275, 0], "#c3c3c8", { r: 0.012, axis: "y", rough: 0.5 });
  d.cyl(0.072, 0.072, 0.006, [-0.045, 0.058, -0.01], "#b9b9be", { seg: 28 });
  d.cyl(0.012, 0.012, 0.004, [-0.045, 0.062, -0.01], "#a6a6ac", { seg: 12 });
  d.cyl(0.012, 0.012, 0.006, [0.075, 0.058, -0.04], "#8a8a90", { seg: 12 });
  d.cyl(0.012, 0.012, 0.006, [0.105, 0.058, -0.04], "#8a8a90", { seg: 12 });
  d.cyl(0.016, 0.016, 0.006, [0.09, 0.058, 0.035], "#8a8a90", { seg: 14 });
  d.box([0.005, 0.004, 0.005], [0.09, 0.0565, -0.012], "#3dff6a", { glow: 2.5 });
  for (const x of [-0.06, 0.06]) {
    d.box([0.05, 0.008, 0.003], [x, 0.038, 0.0955], "#2a2a2e");
    d.box([0.03, 0.012, 0.003], [x, 0.018, 0.0955], "#2a2a2e");
  }
}

function ps2Like(d: DecorBuilder) {
  rbox(d, [0.3, 0.075, 0.178], [0, 0.0375, 0], "#141418", { r: 0.008, rough: 0.35 });
  for (let i = 0; i < 3; i++) d.box([0.302, 0.003, 0.18], [0, 0.017 + i * 0.02, 0], "#08080a", { rough: 0.6 });
  d.box([0.2, 0.004, 0.003], [-0.03, 0.05, 0.0905], "#2a2a32");
  d.box([0.008, 0.008, 0.003], [0.12, 0.05, 0.0905], "#2f6bff", { glow: 2.5 });
  d.box([0.01, 0.01, 0.003], [0.12, 0.028, 0.0905], "#2a2a32");
}

function cubeLike(d: DecorBuilder) {
  d.box([0.146, 0.018, 0.146], [0, 0.009, 0], "#241e48");
  rbox(d, [0.15, 0.1, 0.15], [0, 0.068, 0], "#4b3f92", { r: 0.012, axis: "y", bevel: 0.006, rough: 0.4 });
  d.cyl(0.055, 0.055, 0.005, [0, 0.12, 0.01], "#43388a", { seg: 24 });
  d.cyl(0.012, 0.012, 0.004, [0, 0.124, 0.01], "#7a70c0", { seg: 10 });
  d.torus(0.045, 0.007, [0, 0.112, -0.08], "#3a3072", { arc: PI, seg: 12 });
  for (let i = 0; i < 4; i++) d.box([0.022, 0.016, 0.003], [-0.051 + i * 0.034, 0.032, 0.0765], "#15122a");
  d.cyl(0.009, 0.009, 0.004, [0.05, 0.1205, 0.05], "#2a2450", { seg: 10 });
  d.box([0.005, 0.004, 0.003], [0.06, 0.06, 0.0765], "#3dff6a", { glow: 2 });
}

/** Hybrid console docked: tablet with red/blue side controllers in a dock. */
function dockLike(d: DecorBuilder) {
  rbox(d, [0.175, 0.1, 0.014], [0, 0.1, -0.004], "#1b1b20", { r: 0.008 });
  rbox(d, [0.036, 0.1, 0.016], [-0.1035, 0.1, -0.004], "#ff4a4a", { r: 0.014 });
  rbox(d, [0.036, 0.1, 0.016], [0.1035, 0.1, -0.004], "#2fb5ff", { r: 0.014 });
  d.plane([0.15, 0.085], [0, 0.1, 0.0035], "#0b0b12", { rough: 0.15 });
  rbox(d, [0.18, 0.095, 0.05], [0, 0.0475, 0.006], "#2a2a2f", { r: 0.012, rough: 0.5 });
  d.box([0.01, 0.003, 0.002], [-0.07, 0.012, 0.0316], "#3dff6a", { glow: 2 });
}

/** The same handheld lying screen-up (front edge towards +z). */
function handheldFlat(d: DecorBuilder, screen: UVRect) {
  d.at([0, 0.008, 0], [-PI / 2, 0, 0], () => {
    rbox(d, [0.175, 0.1, 0.014], [0, 0, 0], "#1b1b20", { r: 0.008 });
    rbox(d, [0.036, 0.1, 0.016], [-0.1035, 0, 0], "#ff4a4a", { r: 0.014 });
    rbox(d, [0.036, 0.1, 0.016], [0.1035, 0, 0], "#2fb5ff", { r: 0.014 });
    d.plane([0.15, 0.085], [0, 0, 0.0075], "#ffffff", { tex: screen, glow: 0.5, rough: 0.2 });
    d.cyl(0.008, 0.008, 0.008, [-0.1035, 0.025, 0.009], "#111", { rot: [PI / 2, 0, 0], seg: 10 });
    d.cyl(0.008, 0.008, 0.008, [0.1035, -0.012, 0.009], "#111", { rot: [PI / 2, 0, 0], seg: 10 });
    for (const [x, y] of [[0.1035, 0.035], [0.1035, 0.015], [0.0935, 0.025], [0.1135, 0.025]]) d.cyl(0.0035, 0.0035, 0.006, [x, y, 0.009], "#222", { rot: [PI / 2, 0, 0], seg: 6 });
  });
}

function padClassic(d: DecorBuilder) {
  rbox(d, [0.12, 0.014, 0.052], [0, 0.007, 0], "#c3c3c8", { r: 0.004, axis: "y" });
  d.box([0.112, 0.002, 0.044], [0, 0.0145, 0], "#1d1d22");
  d.box([0.026, 0.003, 0.008], [-0.035, 0.0165, 0], "#0e0e10");
  d.box([0.008, 0.003, 0.026], [-0.035, 0.0165, 0], "#0e0e10");
  d.cyl(0.0065, 0.0065, 0.004, [0.03, 0.0165, 0.006], "#d81e2a", { seg: 10 });
  d.cyl(0.0065, 0.0065, 0.004, [0.046, 0.0165, 0.006], "#d81e2a", { seg: 10 });
  d.box([0.011, 0.002, 0.004], [-0.007, 0.0165, 0.008], "#6a6a70");
  d.box([0.011, 0.002, 0.004], [0.009, 0.0165, 0.008], "#6a6a70");
}

function padShape() {
  const s = new THREE.Shape();
  s.moveTo(-0.045, 0.032);
  s.lineTo(0.045, 0.032);
  s.bezierCurveTo(0.07, 0.034, 0.08, 0.02, 0.078, 0.0);
  s.bezierCurveTo(0.076, -0.03, 0.074, -0.06, 0.056, -0.062);
  s.bezierCurveTo(0.044, -0.064, 0.038, -0.04, 0.03, -0.022);
  s.lineTo(-0.03, -0.022);
  s.bezierCurveTo(-0.038, -0.04, -0.044, -0.064, -0.056, -0.062);
  s.bezierCurveTo(-0.074, -0.06, -0.076, -0.03, -0.078, 0.0);
  s.bezierCurveTo(-0.08, 0.02, -0.07, 0.034, -0.045, 0.032);
  return s;
}

/** A generic dual-grip pad lying flat: triggers towards -z, grips towards +z. */
function padModern(d: DecorBuilder, body: Color, accent: Color) {
  const g = new THREE.ExtrudeGeometry(padShape(), { depth: 0.014, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1, curveSegments: 4 });
  g.rotateX(-PI / 2);
  d.geo(g, [0, 0.006, 0], body, { rough: 0.45 });
  const top = 0.026;
  d.cyl(0.011, 0.012, 0.012, [-0.042, top + 0.004, 0.0], "#18181c", { seg: 10 });
  d.cyl(0.011, 0.012, 0.012, [0.02, top + 0.004, 0.016], "#18181c", { seg: 10 });
  d.box([0.022, 0.004, 0.007], [-0.02, top + 0.001, 0.016], "#18181c");
  d.box([0.007, 0.004, 0.022], [-0.02, top + 0.001, 0.016], "#18181c");
  for (const [x, z, col] of [[0.042, -0.01, "#3dffa8"], [0.042, 0.01, "#ff3d9a"], [0.032, 0, "#4fd8ff"], [0.052, 0, "#ffd23f"]] as [number, number, string][])
    d.sphere(0.0045, [x, top, z], col, { seg: 6 });
  d.box([0.03, 0.003, 0.016], [0, top, -0.012], accent, { glow: 0.6 });
  for (const sx of [-1, 1]) rbox(d, [0.026, 0.012, 0.012], [sx * 0.05, 0.016, -0.036], "#18181c", { r: 0.004 });
}

function beanBag(d: DecorBuilder, color: Color) {
  d.lathe(
    [[0, 0], [0.3, 0.004], [0.38, 0.05], [0.42, 0.14], [0.41, 0.25], [0.35, 0.37], [0.24, 0.45], [0.12, 0.48], [0, 0.47]],
    [0, 0, 0],
    color,
    { seg: 22, rough: 0.42, scale: [1, 1, 0.9] },
  );
  // where someone sat
  d.lathe([[0, 0.38], [0.14, 0.4], [0.24, 0.45], [0.2, 0.47], [0, 0.44]], [0.03, 0.005, 0.06], color, { seg: 16, rough: 0.42 });
}

function pillow(d: DecorBuilder, color: Color, size: number, print?: UVRect) {
  rbox(d, [size, size * 0.92, 0.13], [0, 0, 0], color, { r: size * 0.24, bevel: 0.05, rough: 0.92 });
  if (print) d.plane([size * 0.58, size * 0.58], [0, 0, 0.0655], "#ffffff", { tex: print, rough: 0.9 });
}

function mug(d: DecorBuilder, color: Color, band?: Color) {
  d.lathe([[0, 0], [0.036, 0], [0.04, 0.006], [0.04, 0.095], [0.036, 0.095], [0.036, 0.012], [0, 0.012]], [0, 0, 0], color, { seg: 16, rough: 0.3 });
  if (band) d.cyl(0.0405, 0.0405, 0.012, [0, 0.07, 0], band, { seg: 16, open: true, rough: 0.3 });
  d.cyl(0.0355, 0.0355, 0.002, [0, 0.078, 0], "#3b2416", { seg: 14, rough: 0.12 });
  d.torus(0.024, 0.0055, [0.042, 0.05, 0], color, { arc: PI, rot: [0, 0, -PI / 2], seg: 10 });
}

/** The label's first "Happy Juice" face is centred a quarter of the way round: turn it to face +z. */
const LABEL_TURN = -0.25 * PI * 2;

function sodaCan(d: DecorBuilder, label: UVRect, lying = false) {
  const body = () => {
    d.cyl(0.033, 0.033, 0.104, [0, 0.062, 0], "#ffffff", { seg: 16, open: true, tex: label, metal: 0.45, rough: 0.35, rot: [0, LABEL_TURN + (lying ? PI : 0), 0] });
    d.lathe([[0, 0.004], [0.024, 0], [0.031, 0.004], [0.033, 0.01]], [0, 0, 0], "#b9bec8", { seg: 16, metal: 0.85, rough: 0.3 });
    d.lathe([[0.033, 0.114], [0.027, 0.122], [0.028, 0.125], [0, 0.121]], [0, 0, 0], "#c9ced8", { seg: 16, metal: 0.85, rough: 0.3 });
    d.box([0.012, 0.002, 0.02], [0, 0.124, 0.008], "#aab0ba", { metal: 0.8 });
  };
  if (lying) d.at([0, 0.033, -0.062], [PI / 2, 0, 0], body);
  else body();
}

function juiceBottle(d: DecorBuilder, label: UVRect, tint: Color) {
  d.lathe([[0, 0], [0.028, 0], [0.032, 0.008], [0.032, 0.13], [0.027, 0.158], [0.014, 0.19], [0.0135, 0.214], [0, 0.214]], [0, 0, 0], tint, { seg: 16, rough: 0.08, metal: 0.1 });
  d.cyl(0.0325, 0.0325, 0.07, [0, 0.075, 0], "#ffffff", { seg: 16, open: true, tex: label, rough: 0.4, rot: [0, LABEL_TURN, 0] });
  d.cyl(0.0155, 0.0155, 0.016, [0, 0.222, 0], "#f4f1ea", { seg: 12, rough: 0.4 });
  d.torus(0.0145, 0.002, [0, 0.214, 0], "#f4f1ea", { rot: [PI / 2, 0, 0], seg: 12 });
}

function lavaLampBase(d: DecorBuilder) {
  d.lathe([[0, 0], [0.058, 0], [0.056, 0.012], [0.034, 0.105], [0.031, 0.118], [0, 0.118]], [0, 0, 0], "#3a2a5a", { seg: 18, metal: 0.7, rough: 0.3 });
  d.lathe([[0.031, 0.116], [0.046, 0.2], [0.042, 0.3], [0.022, 0.365], [0, 0.366]], [0, 0, 0], "#ff4fa3", { seg: 18, glow: 0.55, rough: 0.12 });
  d.lathe([[0.023, 0.36], [0.019, 0.41], [0, 0.414]], [0, 0, 0], "#3a2a5a", { seg: 14, metal: 0.7, rough: 0.3 });
  d.sphere(0.03, [0, 0.135, 0], "#ffb36b", { seg: 10, glow: 0.9, scale: [1.45, 0.6, 1.45] });
}

function mushroomFig(d: DecorBuilder) {
  d.lathe([[0, 0], [0.02, 0], [0.018, 0.035], [0.022, 0.045], [0, 0.046]], [0, 0, 0], "#f1e6cf", { seg: 12 });
  d.lathe([[0, 0.036], [0.048, 0.036], [0.05, 0.046], [0.043, 0.066], [0.028, 0.08], [0, 0.085]], [0, 0, 0], "#d8262f", { seg: 16, rough: 0.35 });
  for (let i = 0; i < 6; i++) {
    const a = i * 1.1, r = i === 5 ? 0 : 0.033;
    d.sphere(0.0075, [Math.cos(a) * r, i === 5 ? 0.083 : 0.066, Math.sin(a) * r], "#fff8ec", { seg: 6, scale: [1, 0.5, 1] });
  }
}

function slimeFig(d: DecorBuilder, color: Color) {
  d.lathe([[0, 0], [0.045, 0], [0.05, 0.01], [0.046, 0.03], [0.032, 0.05], [0.012, 0.062], [0, 0.066]], [0, 0, 0], color, { seg: 18, rough: 0.1 });
  d.sphere(0.006, [-0.016, 0.034, 0.039], "#0b0b10", { seg: 6 });
  d.sphere(0.006, [0.016, 0.034, 0.039], "#0b0b10", { seg: 6 });
  d.sphere(0.0022, [-0.014, 0.037, 0.044], "#ffffff", { seg: 4 });
  d.sphere(0.0022, [0.018, 0.037, 0.044], "#ffffff", { seg: 4 });
  d.sphere(0.012, [-0.02, 0.05, 0.02], "#ffffff", { seg: 6, scale: [1, 0.5, 0.6], rough: 0.05 });
}

function robotFig(d: DecorBuilder) {
  d.box([0.016, 0.03, 0.02], [-0.014, 0.015, 0], "#5a6070", { metal: 0.6, rough: 0.35 });
  d.box([0.016, 0.03, 0.02], [0.014, 0.015, 0], "#5a6070", { metal: 0.6, rough: 0.35 });
  rbox(d, [0.055, 0.048, 0.034], [0, 0.054, 0], "#b9c2d0", { r: 0.008, metal: 0.6, rough: 0.35 });
  d.box([0.03, 0.016, 0.002], [0, 0.058, 0.0175], "#20242c");
  d.box([0.006, 0.004, 0.002], [-0.008, 0.06, 0.019], "#ff3d9a", { glow: 1.5 });
  d.box([0.006, 0.004, 0.002], [0.004, 0.056, 0.019], "#ffd23f", { glow: 1.5 });
  rod(d, [-0.03, 0.07, 0], [-0.045, 0.04, 0.01], 0.005, "#8a92a2", { metal: 0.6 });
  rod(d, [0.03, 0.07, 0], [0.045, 0.045, 0.012], 0.005, "#8a92a2", { metal: 0.6 });
  rbox(d, [0.042, 0.032, 0.03], [0, 0.097, 0], "#cfd6e2", { r: 0.008, metal: 0.6, rough: 0.35 });
  d.box([0.008, 0.008, 0.002], [-0.009, 0.099, 0.0155], "#4fd8ff", { glow: 1.8 });
  d.box([0.008, 0.008, 0.002], [0.009, 0.099, 0.0155], "#4fd8ff", { glow: 1.8 });
  rod(d, [0, 0.113, 0], [0, 0.135, 0], 0.0018, "#8a92a2");
  d.sphere(0.0045, [0, 0.137, 0], "#ff3d9a", { seg: 6, glow: 1.4 });
}

function trophy(d: DecorBuilder) {
  d.box([0.06, 0.022, 0.06], [0, 0.011, 0], "#16141a", { rough: 0.3 });
  d.box([0.035, 0.01, 0.002], [0, 0.011, 0.031], "#c99a3c", { metal: 0.9, rough: 0.3 });
  d.lathe([[0, 0.022], [0.016, 0.022], [0.006, 0.03], [0.005, 0.06], [0.01, 0.066], [0.028, 0.08], [0.033, 0.112], [0.03, 0.112], [0.025, 0.084], [0, 0.074]], [0, 0, 0], "#e2b43c", { seg: 16, metal: 0.9, rough: 0.22 });
  for (const sx of [-1, 1]) d.torus(0.012, 0.003, [sx * 0.033, 0.095, 0], "#e2b43c", { arc: PI, rot: [0, 0, sx > 0 ? -PI / 2 : PI / 2], seg: 8, metal: 0.9, rough: 0.22 });
}

function brickHandheld(d: DecorBuilder) {
  d.box([0.05, 0.008, 0.03], [0, 0.004, 0.005], "#16141a");
  d.at([0, 0.008, 0], [-0.18, 0, 0], () => {
    rbox(d, [0.06, 0.1, 0.02], [0, 0.05, 0], "#c9c6bd", { r: 0.006 });
    d.box([0.048, 0.042, 0.002], [0, 0.072, 0.0105], "#4a4a5a");
    d.box([0.032, 0.028, 0.001], [0, 0.072, 0.0118], "#9aae6a", { glow: 0.2 });
    d.box([0.016, 0.005, 0.003], [-0.014, 0.034, 0.0115], "#222");
    d.box([0.005, 0.016, 0.003], [-0.014, 0.034, 0.0115], "#222");
    d.cyl(0.0045, 0.0045, 0.003, [0.012, 0.03, 0.0115], "#a3204a", { rot: [PI / 2, 0, 0], seg: 8 });
    d.cyl(0.0045, 0.0045, 0.003, [0.021, 0.037, 0.0115], "#a3204a", { rot: [PI / 2, 0, 0], seg: 8 });
  });
}

function puzzleCube(d: DecorBuilder) {
  const s = 0.055, cell = s / 3;
  d.box([s, s, s], [0, s / 2, 0], "#111");
  const cols = ["#e8303a", "#ffd23f", "#3dbf5a", "#2f7bff", "#ff8a1a", "#f4f4f4"];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const u = (i - 1) * cell, v = (j - 1) * cell;
      d.box([cell * 0.86, cell * 0.86, 0.002], [u, s / 2 + v, s / 2 + 0.001], cols[(i * 3 + j) % 6]);
      d.box([cell * 0.86, 0.002, cell * 0.86], [u, s + 0.001, v], cols[(i + j * 2 + 1) % 6]);
      d.box([0.002, cell * 0.86, cell * 0.86], [s / 2 + 0.001, s / 2 + v, u], cols[(i * 2 + j + 3) % 6]);
    }
}

function tokenJar(d: DecorBuilder, label: UVRect) {
  // a glassy jar, brimming: tokens heaped over the rim, a few pressed against the glass
  d.lathe([[0, 0], [0.05, 0], [0.054, 0.01], [0.054, 0.115], [0.046, 0.128], [0.046, 0.134], [0, 0.134]], [0, 0, 0], "#9cc8e0", { seg: 20, rough: 0.06, metal: 0.15 });
  d.torus(0.047, 0.005, [0, 0.134, 0], "#d8eef8", { rot: [PI / 2, 0, 0], seg: 18, rough: 0.05 });
  for (let i = 0; i < 16; i++) {
    const a = rnd() * PI * 2, r = Math.sqrt(rnd()) * 0.04, y = 0.137 + (0.04 - r) * 0.5 + rnd() * 0.006;
    d.cyl(0.0125, 0.0125, 0.003, [Math.cos(a) * r, y, Math.sin(a) * r], i % 3 ? "#f2c24a" : "#ffd86a", { seg: 10, metal: 0.45, rough: 0.25, rot: [(rnd() - 0.5) * 0.9, 0, (rnd() - 0.5) * 0.9] });
  }
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * PI * 2 + rnd() * 0.3, y = 0.025 + rnd() * 0.075;
    d.at([Math.cos(a) * 0.0545, y, Math.sin(a) * 0.0545], [0, -a, (rnd() - 0.5) * 0.6], () => d.cyl(0.0125, 0.0125, 0.003, [0, 0, 0], "#f2c24a", { seg: 10, metal: 0.45, rough: 0.25, rot: [0, 0, PI / 2] }));
  }
  d.cyl(0.0548, 0.0548, 0.028, [0, 0.07, 0], "#ffffff", { seg: 20, open: true, tex: label, rough: 0.5 });
}

function cupNoodle(d: DecorBuilder) {
  d.lathe([[0, 0], [0.036, 0], [0.047, 0.1], [0, 0.1]], [0, 0, 0], "#f4f1ea", { seg: 16, rough: 0.6 });
  d.lathe([[0.039, 0.03], [0.044, 0.075]], [0, 0, 0], "#d8262f", { seg: 16, rough: 0.6, scale: [1.01, 1, 1.01] });
  d.cyl(0.049, 0.049, 0.004, [0, 0.102, 0], "#d9dde6", { seg: 16, metal: 0.6, rough: 0.35, rot: [0.08, 0, 0] });
}

function speakerDriver(d: DecorBuilder, r: number, rim: Color = "#9aa0aa") {
  d.lathe([[r, 0], [r * 0.4, -r * 0.32], [0, -r * 0.32]], [0, 0, 0], "#4a4856", { seg: 18, rough: 0.7, rot: [PI / 2, 0, 0] });
  d.torus(r, r * 0.09, [0, 0, 0], rim, { seg: 22, metal: 0.5, rough: 0.3 });
  d.sphere(r * 0.28, [0, 0, -r * 0.25], "#6a6878", { seg: 8, scale: [1, 1, 0.5], rough: 0.4 });
}

function towerSpeaker(d: DecorBuilder) {
  rbox(d, [0.26, 0.92, 0.3], [0, 0.5, 0], C.walnut, { r: 0.025, axis: "y", rough: 0.4 });
  d.box([0.262, 0.012, 0.302], [0, 0.955, 0], "#1a1620", { rough: 0.3 });
  d.box([0.235, 0.88, 0.004], [0, 0.5, 0.151], "#0d0b12", { rough: 0.9 });
  d.at([0, 0, 0.154], null, () => {
    speakerDriver(d, 0.08);
    d.at([0, 0.3, 0], null, () => speakerDriver(d, 0.08));
    d.at([0, 0.56, 0], null, () => speakerDriver(d, 0.08));
    d.at([0, 0.77, 0], null, () => speakerDriver(d, 0.03));
  });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) d.cyl(0.012, 0.004, 0.04, [sx * 0.1, 0.02, sz * 0.11], "#9aa0aa", { seg: 8, metal: 0.8 });
}

function shelfSpeaker(d: DecorBuilder) {
  rbox(d, [0.15, 0.24, 0.19], [0, 0.12, 0], C.walnut, { r: 0.012, axis: "y", rough: 0.45 });
  d.box([0.13, 0.22, 0.003], [0, 0.12, 0.0955], "#141218", { rough: 0.9 });
  d.at([0, 0.085, 0.098], null, () => speakerDriver(d, 0.048, "#c9a35a"));
  d.at([0, 0.19, 0.098], null, () => speakerDriver(d, 0.017, "#c9a35a"));
}

function gameCase(d: DecorBuilder, cover: UVRect) {
  d.box([0.135, 0.014, 0.19], [0, 0.007, 0], "#101014", { rough: 0.4 });
  d.plane([0.13, 0.184], [0, 0.0142, 0], "#ffffff", { tex: cover, rot: [-PI / 2, 0, 0], rough: 0.35 });
}

function openCase(d: DecorBuilder, discColor: Color) {
  d.box([0.135, 0.006, 0.19], [-0.07, 0.003, 0], "#16161c", { rough: 0.4 });
  d.box([0.135, 0.006, 0.19], [0.07, 0.003, 0], "#16161c", { rough: 0.4 });
  d.box([0.11, 0.002, 0.16], [-0.07, 0.007, 0], "#e8e4dc", { rough: 0.6 });
  d.cyl(0.06, 0.06, 0.0025, [0.07, 0.0075, 0], "#d6dce8", { seg: 28, metal: 0.85, rough: 0.12 });
  d.cyl(0.04, 0.04, 0.001, [0.07, 0.0092, 0], discColor, { seg: 24 });
  d.cyl(0.008, 0.008, 0.0012, [0.07, 0.0095, 0], "#16161c", { seg: 12 });
}

function magazine(d: DecorBuilder, cover: UVRect) {
  d.box([0.21, 0.006, 0.28], [0, 0.003, 0], "#efece6", { rough: 0.6 });
  d.plane([0.21, 0.28], [0, 0.0062, 0], "#ffffff", { tex: cover, rot: [-PI / 2, 0, 0], rough: 0.4 });
}

/** Wooden floor rack: two rows of covers face-out (the back row sits higher). */
function magazineRack(d: DecorBuilder, T: Tex) {
  const W = 0.5, wood = C.walnut, n = T.magCovers.length;
  const side = new THREE.Shape([new THREE.Vector2(-0.14, 0), new THREE.Vector2(0.14, 0), new THREE.Vector2(0.14, 0.1), new THREE.Vector2(0.01, 0.52), new THREE.Vector2(-0.13, 0.52), new THREE.Vector2(-0.14, 0.5)]);
  // shape x runs towards -z once turned onto the side
  for (const sx of [-1, 1]) slabShape(d, side, 0.018, [(sx * (W - 0.018)) / 2, 0, 0], wood, { rot: [0, PI / 2, 0], rough: 0.45, bevel: 0.003 });
  d.box([W - 0.03, 0.018, 0.27], [0, 0.009, 0], wood, { rough: 0.5 });
  d.box([W - 0.03, 0.016, 0.13], [0, 0.15, -0.065], wood, { rough: 0.5 });
  d.at([0, 0.15, -0.125], [-0.12, 0, 0], () => d.box([W - 0.03, 0.36, 0.012], [0, 0.18, 0], wood, { rough: 0.5 }));
  rod(d, [-(W - 0.03) / 2, 0.075, 0.13], [(W - 0.03) / 2, 0.075, 0.13], 0.008, C.brass, { metal: 0.8, rough: 0.3 });
  rod(d, [-(W - 0.03) / 2, 0.22, 0.0], [(W - 0.03) / 2, 0.22, 0.0], 0.007, C.brass, { metal: 0.8, rough: 0.3 });
  const cover = (k: number, at: Vec3, tilt: number, yaw: number) =>
    d.at(at, [tilt, yaw, 0], () => d.box([0.21, 0.28, 0.006], [0, 0.14, 0], "#ffffff", { tex: T.magCovers[k % n], face: "front", rough: 0.45 }));
  cover(3, [-0.115, 0.158, -0.03], -0.3, 0.03);
  cover(5, [0.115, 0.158, -0.035], -0.3, -0.04);
  cover(0, [-0.115, 0.02, 0.105], -0.36, -0.02);
  cover(7, [0.115, 0.02, 0.1], -0.36, 0.05);
}

/** A pile of `n` magazines with cover `top` on top (the ones under it count down from there). */
function magazineStack(d: DecorBuilder, T: Tex, n: number, top: number) {
  const len = T.magCovers.length;
  for (let i = 0; i < n; i++)
    d.at([(rnd() - 0.5) * 0.02, i * 0.0065, (rnd() - 0.5) * 0.02], [0, (rnd() - 0.5) * 0.25, 0], () => magazine(d, T.magCovers[(((top - (n - 1 - i)) % len) + len) % len]));
}

function cactus(d: DecorBuilder, pot: Color) {
  d.lathe(potProfile(0.045, 0.075), [0, 0, 0], pot, { seg: 14, rough: 0.7 });
  d.cyl(0.04, 0.04, 0.004, [0, 0.066, 0], "#3a2a1a", { seg: 12 });
  d.cyl(0.024, 0.027, 0.15, [0, 0.14, 0], "#3f8a4a", { seg: 10 });
  d.sphere(0.024, [0, 0.215, 0], "#3f8a4a", { seg: 10 });
  rod(d, [0.015, 0.13, 0], [0.05, 0.14, 0], 0.011, "#3f8a4a");
  rod(d, [0.05, 0.135, 0], [0.05, 0.19, 0], 0.011, "#3f8a4a");
  d.sphere(0.011, [0.05, 0.19, 0], "#3f8a4a", { seg: 8 });
  d.sphere(0.009, [0, 0.24, 0], "#ff5aa8", { seg: 8, scale: [1, 0.6, 1] });
}

function succulent(d: DecorBuilder, pot: Color, ring?: Color) {
  d.lathe(potProfile(0.055, 0.065), [0, 0, 0], pot, { seg: 16, rough: 0.5 });
  if (ring) d.torus(0.058, 0.003, [0, 0.063, 0], ring, { rot: [PI / 2, 0, 0], seg: 24, glow: 1.4 });
  d.cyl(0.05, 0.05, 0.004, [0, 0.058, 0], "#3a2a1a", { seg: 12 });
  for (let i = 0; i < 13; i++) {
    const a = i * 2.4, r = 0.006 + i * 0.0032;
    d.at([Math.cos(a) * r, 0.064 + (12 - i) * 0.0018, Math.sin(a) * r], [0, -a, 0.5 + i * 0.05], () =>
      d.sphere(0.017 - i * 0.0006, [0, 0, 0], i % 2 ? "#78b48e" : "#8cc49a", { seg: 6, scale: [1.6, 0.45, 0.8] }),
    );
  }
}

function snakePlant(d: DecorBuilder, pot: Color) {
  d.lathe(potProfile(0.12, 0.26), [0, 0, 0], pot, { seg: 20, rough: 0.6 });
  d.torus(0.124, 0.004, [0, 0.215, 0], C.magenta, { rot: [PI / 2, 0, 0], seg: 28, glow: 1.5 });
  d.cyl(0.11, 0.11, 0.01, [0, 0.23, 0], "#2a1c12", { seg: 16 });
  for (let i = 0; i < 11; i++) {
    const h = 0.42 + rnd() * 0.42, w = 0.045 + rnd() * 0.025;
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0);
    s.quadraticCurveTo(-w * 0.75, h * 0.55, 0, h);
    s.quadraticCurveTo(w * 0.75, h * 0.55, w / 2, 0);
    s.closePath();
    const a = rnd() * PI * 2, r = rnd() * 0.07;
    slabShape(d, s, 0.006, [Math.cos(a) * r, 0.22, Math.sin(a) * r], i % 3 ? "#3f9a4f" : "#8fc04a", { rot: [(rnd() - 0.5) * 0.35, rnd() * PI, (rnd() - 0.5) * 0.35], rough: 0.45, segs: 3 });
  }
}

function monstera(d: DecorBuilder, leaf: UVRect, pot: Color, ring: Color) {
  d.lathe(potProfile(0.18, 0.4), [0, 0, 0], pot, { seg: 24, rough: 0.5 });
  d.torus(0.188, 0.005, [0, 0.33, 0], ring, { rot: [PI / 2, 0, 0], seg: 36, glow: 1.6 });
  d.cyl(0.165, 0.165, 0.01, [0, 0.355, 0], "#2a1c12", { seg: 20 });
  for (let i = 0; i < 12; i++) {
    const a = i * 2.39996 + rnd() * 0.4;
    const len = 0.35 + rnd() * 0.75;
    const out = 0.12 + rnd() * 0.3;
    const tip: Vec3 = [Math.cos(a) * out, 0.36 + len, Math.sin(a) * out];
    d.tube([[0, 0.36, 0], [tip[0] * 0.3, 0.36 + len * 0.6, tip[2] * 0.3], tip], 0.006, "#3f7a3a", { seg: 8 });
    const s = 0.26 + rnd() * 0.16;
    d.at(tip, [0, PI / 2 - a, 0], () =>
      d.at([0, 0, 0], [0.5 + rnd() * 0.6, 0, (rnd() - 0.5) * 0.4], () => {
        d.plane([s, s], [0, s * 0.46, 0], "#ffffff", { tex: leaf, rough: 0.55 });
        d.plane([s, s], [0, s * 0.46, -0.002], "#ffffff", { tex: leaf, rough: 0.55, rot: [0, PI, 0] });
      }),
    );
  }
}

function tableLamp(d: DecorBuilder, base: Color) {
  d.lathe([[0, 0], [0.07, 0], [0.075, 0.015], [0.05, 0.03], [0.065, 0.1], [0.045, 0.19], [0.012, 0.22], [0.01, 0.3], [0, 0.3]], [0, 0, 0], base, { seg: 18, rough: 0.2 });
  const shade: [number, number][] = [[0.13, 0.25], [0.09, 0.43]];
  d.lathe(shade, [0, 0, 0], "#f2c48a", { seg: 24, glow: 0.45, rough: 0.9 });
  d.lathe([...shade].reverse(), [0, 0, 0], "#ffd9a0", { seg: 24, glow: 0.9, rough: 0.9, scale: [0.985, 1, 0.985] });
  d.sphere(0.028, [0, 0.33, 0], "#fff1d6", { seg: 10, glow: 2 });
}

function tulipTable(d: DecorBuilder, top: Color, base: Color) {
  d.lathe([[0, 0], [0.17, 0], [0.17, 0.012], [0.06, 0.05], [0.028, 0.15], [0.026, 0.4], [0.06, 0.475], [0, 0.48]], [0, 0, 0], base, { seg: 20, rough: 0.3 });
  d.cyl(0.23, 0.23, 0.025, [0, 0.4925, 0], top, { seg: 30, rough: 0.25 });
}

function snackBowl(d: DecorBuilder, color: Color) {
  d.lathe([[0, 0], [0.05, 0], [0.09, 0.05], [0.1, 0.07], [0.094, 0.07], [0.084, 0.052], [0.045, 0.008], [0, 0.008]], [0, 0, 0], color, { seg: 20, rough: 0.2 });
  for (let i = 0; i < 26; i++) {
    const a = rnd() * PI * 2, r = Math.sqrt(rnd()) * 0.075;
    d.sphere(0.011 + rnd() * 0.005, [Math.cos(a) * r, 0.055 + (0.075 - r) * 0.4 + rnd() * 0.01, Math.sin(a) * r], rnd() < 0.7 ? "#f6ecc8" : "#f2cf6a", { seg: 5, rough: 0.8 });
  }
}

function chipBag(d: DecorBuilder, tex: UVRect) {
  rbox(d, [0.18, 0.24, 0.05], [0, 0, 0], "#ffb02a", { r: 0.03, bevel: 0.022, metal: 0.4, rough: 0.3 });
  d.plane([0.13, 0.13], [0, 0.01, 0.0255], "#ffffff", { tex, metal: 0.3, rough: 0.35 });
  d.box([0.18, 0.02, 0.012], [0, 0.118, 0], "#e89a1a", { metal: 0.4, rough: 0.3 });
}

function remote(d: DecorBuilder) {
  rbox(d, [0.045, 0.018, 0.17], [0, 0.009, 0], "#1a1a20", { r: 0.012, axis: "y" });
  d.cyl(0.005, 0.005, 0.003, [0, 0.019, -0.06], "#e8303a", { seg: 8 });
  for (let i = 0; i < 9; i++) d.box([0.008, 0.003, 0.006], [-0.012 + (i % 3) * 0.012, 0.0185, -0.02 + Math.floor(i / 3) * 0.014], "#55555e");
  d.cyl(0.012, 0.012, 0.003, [0, 0.0185, -0.038], "#3a3a44", { seg: 12 });
}

function shoe(d: DecorBuilder, upper: Color, sole: Color, accent: Color) {
  const s = new THREE.Shape();
  s.moveTo(-0.125, 0.018);
  s.lineTo(-0.128, 0.08);
  s.quadraticCurveTo(-0.122, 0.098, -0.1, 0.094);
  s.lineTo(-0.06, 0.078);
  s.lineTo(-0.015, 0.088);
  s.lineTo(0.04, 0.066);
  s.quadraticCurveTo(0.13, 0.05, 0.135, 0.018);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.006, bevelSegments: 1, curveSegments: 3 });
  g.translate(0, 0, -0.035);
  g.rotateY(-PI / 2);
  d.geo(g, [0, 0, 0], upper, { rough: 0.75 });
  const so = new THREE.ExtrudeGeometry(roundedRect(0.28, 0.024, 0.011), { depth: 0.09, bevelEnabled: false, curveSegments: 3 });
  so.translate(0.004, 0.012, -0.045);
  so.rotateY(-PI / 2);
  d.geo(so, [0, 0, 0], sole, { rough: 0.6 });
  for (const sx of [-1, 1]) d.box([0.003, 0.016, 0.1], [sx * 0.0445, 0.048, 0.01], accent);
  for (let i = 0; i < 3; i++) d.box([0.05, 0.004, 0.006], [0, 0.084 - i * 0.008, 0.035 + i * 0.018], sole);
}

function sneakers(d: DecorBuilder, upper: Color, sole: Color, accent: Color) {
  d.at([-0.055, 0, 0], [0, 0.08, 0], () => shoe(d, upper, sole, accent));
  d.at([0.055, 0, 0.01], [0, -0.05, 0], () => shoe(d, upper, sole, accent));
}

function boombox(d: DecorBuilder) {
  rbox(d, [0.5, 0.24, 0.14], [0, 0.12, 0], "#9aa0ae", { r: 0.03, rough: 0.35, metal: 0.3 });
  d.box([0.5, 0.012, 0.142], [0, 0.205, 0], "#2a2830", { rough: 0.4 });
  for (const sx of [-1, 1]) d.cyl(0.085, 0.085, 0.004, [sx * 0.165, 0.11, 0.0705], "#1a1820", { rot: [PI / 2, 0, 0], seg: 22 });
  for (const sx of [-1, 1]) d.at([sx * 0.165, 0.11, 0.071], null, () => speakerDriver(d, 0.07, "#c9ced8"));
  d.box([0.16, 0.1, 0.004], [0, 0.11, 0.071], "#0e0d12");
  d.box([0.1, 0.045, 0.002], [0, 0.11, 0.0735], "#2a2a38", { rough: 0.1 });
  for (const sx of [-1, 1]) d.cyl(0.011, 0.011, 0.002, [sx * 0.024, 0.11, 0.0745], "#f4f1ea", { rot: [PI / 2, 0, 0], seg: 10 });
  for (let i = 0; i < 6; i++) d.box([0.016, 0.01, 0.02], [-0.05 + i * 0.02, 0.245, -0.02], "#c9ced8", { metal: 0.8, rough: 0.3 });
  for (let i = 0; i < 5; i++) d.box([0.012, 0.004, 0.002], [-0.03 + i * 0.015, 0.175, 0.0715], i < 3 ? "#3dff6a" : "#ffb000", { glow: 1.2 });
  rbox(d, [0.4, 0.024, 0.024], [0, 0.31, 0], "#2a2830", { r: 0.01 });
  for (const sx of [-1, 1]) d.box([0.022, 0.07, 0.02], [sx * 0.19, 0.27, 0], "#9aa0ae", { metal: 0.3 });
  rod(d, [0.21, 0.24, -0.05], [0.33, 0.62, -0.06], 0.003, "#c9ced8", { metal: 0.9, seg: 6 });
}

function shippingBox(d: DecorBuilder, size: Vec3, label?: UVRect, stamp?: UVRect) {
  const [w, h, dp] = size;
  d.box(size, [0, h / 2, 0], C.cardboard, { rough: 0.95 });
  d.box([0.055, 0.002, dp + 0.002], [0, h + 0.001, 0], "#c9a46e", { rough: 0.4 });
  d.box([0.055, h * 0.25, 0.002], [0, h * 0.875, dp / 2 + 0.001], "#c9a46e", { rough: 0.4 });
  if (label) d.plane([0.17, 0.096], [-w * 0.18, h * 0.45, dp / 2 + 0.002], "#ffffff", { tex: label, rough: 0.7 });
  if (stamp) d.plane([0.14, 0.052], [w * 0.22, h * 0.25, dp / 2 + 0.002], "#ffffff", { tex: stamp, rough: 0.8, rot: [0, 0, 0.12] });
}

function openBox(d: DecorBuilder, size: Vec3) {
  const [w, h, dp] = size, t = 0.006, col = C.cardboard;
  d.box([w, t, dp], [0, t / 2, 0], col);
  d.box([w, h, t], [0, h / 2, dp / 2 - t / 2], col, { rough: 0.95 });
  d.box([w, h, t], [0, h / 2, -dp / 2 + t / 2], col, { rough: 0.95 });
  d.box([t, h, dp], [w / 2 - t / 2, h / 2, 0], col, { rough: 0.95 });
  d.box([t, h, dp], [-w / 2 + t / 2, h / 2, 0], col, { rough: 0.95 });
  // flaps folded out
  d.at([0, h, dp / 2], [-2.2, 0, 0], () => d.box([w, t, dp / 2], [0, 0, dp / 4], "#b3855a", { rough: 0.95 }));
  d.at([0, h, -dp / 2], [2.0, 0, 0], () => d.box([w, t, dp / 2], [0, 0, -dp / 4], "#b3855a", { rough: 0.95 }));
  d.at([w / 2, h, 0], [0, 0, 2.3], () => d.box([w / 2.2, t, dp], [w / 4.4, 0, 0], "#b3855a", { rough: 0.95 }));
  // game cases standing in it (generic)
  for (let i = 0; i < 7; i++) {
    const x = -w / 2 + 0.05 + i * ((w - 0.1) / 6);
    d.box([0.016, 0.19, 0.136], [x, 0.15 + rnd() * 0.04, (rnd() - 0.5) * 0.04], `hsl(${(i * 53 + 200) % 360},55%,${30 + (i % 3) * 10}%)`, { rot: [0, 0, (rnd() - 0.5) * 0.25], rough: 0.4 });
  }
}

// ---------------------------------------------------------------------------------------------
// zones

/** TV stand: more consoles, a middle shelf, controllers on the floor, lava lamp, speakers, posters. */
async function tvNook(d: DecorBuilder, L: DenLayout, T: Tex, ctx: LevelCtx, anim: Tick[], subs: DecorBuilder[]) {
  const sx = L.nookX, sz = L.Z0 + 0.42;
  d.at([sx, 0, sz], null, () => {
    d.box([0.937, 0.014, 0.44], [0, 0.2605, 0.005], "#15151a", { rough: 0.4, metal: 0.2 });
    d.box([0.92, 0.004, 0.006], [0, 0.505, 0.22], C.purple, { glow: 1.1 });
    d.box([0.92, 0.004, 0.006], [0, 0.251, 0.222], C.cyan, { glow: 1.1 });
    // middle level: N64-ish left, PS1-ish with a slim black PS2-ish on top on the right
    d.at([-0.31, 0.2675, 0.0], [0, 0.05, 0], () => n64Like(d, "#e8a23a"));
    d.at([0.31, 0.2675, 0.0], [0, -0.03, 0], () => ps1Like(d));
    d.at([0.31, 0.3275, 0.005], [0, 0.02, 0], () => ps2Like(d));
    // bottom level: cube, docked hybrid, NES-ish with an SNES-ish on top
    d.at([-0.36, 0.04, 0.02], [0, 0.12, 0], () => cubeLike(d));
    d.at([-0.12, 0.04, 0.0], null, () => dockLike(d));
    d.at([0.27, 0.04, 0.0], null, () => nesLike(d));
    d.at([0.27, 0.125, -0.005], [0, 0.04, 0], () => snesLike(d));
    for (let i = 0; i < 3; i++) d.box([0.014, 0.19, 0.135], [0.425 + i * 0.016, 0.137, 0.02], ["#2a6bd8", "#d8262f", "#1a1a1e"][i], { rough: 0.4 });
  });
  await tick();
  d.at([sx, 0, sz], null, () => {
    // on top, beside the TV
    d.at([-0.42, 0.55, 0.1], null, () => cactus(d, "#ff6aa8"));
    d.at([-0.385, 0.55, -0.1], [0, 0.4, 0], () => slimeFig(d, "#4fd8ff"));
    d.at([0.405, 0.55, 0.02], null, () => lavaLampBase(d));
    // controllers with cables, out onto the floor
    cable(d, [[-0.335, 0.29, 0.096], [-0.33, 0.288, 0.16], [-0.3, 0.26, 0.24], [-0.27, 0.12, 0.27], [-0.22, 0.012, 0.33], [-0.05, 0.012, 0.55], [0.06, 0.04, 0.72], [0.1, 0.13, 0.82]], "#1a1a20");
    d.at([0.12, 0.148, 0.88], [0, 0.5, 0.06], () => padModern(d, "#2a2a32", C.cyan));
    cable(d, [[0.31, 0.062, 0.103], [0.31, 0.06, 0.18], [0.33, 0.03, 0.26], [0.36, 0.012, 0.33], [0.42, 0.012, 0.45], [0.38, 0.012, 0.56]], "#1a1a1e", 0.0028);
    d.at([0.36, 0, 0.6], [0, -0.35, 0], () => padClassic(d));
  });
  await tick();
  d.at([sx, 0, sz], null, () => {
    d.plane([1.25, 1.25], [0.1, 0.004, 0.9], "#ffffff", { tex: T.roundRug, rot: [-PI / 2, 0, 0], rough: 0.95 });
    // floor cushion + scattered cases
    d.lathe([[0, 0], [0.2, 0], [0.26, 0.035], [0.275, 0.075], [0.25, 0.12], [0.15, 0.145], [0, 0.15]], [0.1, 0, 0.88], "#3b1f5a", { seg: 22, rough: 0.92 });
    d.sphere(0.012, [0.1, 0.146, 0.88], "#2a1440", { seg: 6 });
    d.at([-0.35, 0, 0.75], [0, 0.6, 0], () => gameCase(d, T.cases[0]));
    d.at([-0.3, 0.014, 0.78], [0, 0.25, 0], () => gameCase(d, T.cases[1]));
    d.at([0.55, 0, 0.82], [0, -0.4, 0], () => openCase(d, "#ff3d9a"));
  });
  await tick();
  // lava blobs (two subs drifting up and down out of phase, peeking through the glass)
  const lampBase: Vec3 = [sx + 0.405, 0.55, sz + 0.02];
  [[0.6, 0.022, 0.31, 0.0], [2.8, 0.018, 0.23, 2.1]].forEach(([ang, r, speed, phase], i) => {
    const s = d.sub();
    s.sphere(r, [Math.cos(ang) * 0.03, 0, Math.sin(ang) * 0.03], "#ffb36b", { seg: 10, glow: 1.0, scale: [1, 1.35, 1] });
    const m = s.build(`den-lava-${i}`);
    m.position.set(...lampBase);
    ctx.scene.add(m);
    subs.push(s);
    anim.push((_dt, t) => {
      const k = Math.sin(t * speed + phase) * 0.5 + 0.5;
      m.position.y = lampBase[1] + 0.16 + k * 0.15;
    });
  });
  await tick();
  // tower speakers either side + wall posters
  const room = (x: number) => x > L.X0 + 0.45;
  if (room(sx - 0.68)) d.at([sx - 0.68, 0, L.Z0 + 0.17], null, () => towerSpeaker(d));
  d.at([sx + 0.68, 0, L.Z0 + 0.17], null, () => towerSpeaker(d));
  const faves = perlerSets(T.perlers).nook;
  if (room(sx - 1.0))
    d.at([sx - 0.98, faves.length ? 1.5 : 1.42, L.Z0], null, () => (faves.length ? perlerCluster(d, faves, 0.54, 0.74) : framed(d, 0.4, 0.533, T.blueprint, "#e8e4dc")));
  await tick();
  // pegboard of controllers above it
  if (room(sx - 1.0))
    d.at([sx - 0.98, 2.2, L.Z0], null, () => {
      d.box([0.5, 0.42, 0.012], [0, 0, 0.026], "#d8d0bc", { rough: 0.7 });
      d.plane([0.5, 0.42], [0, 0, 0.0325], "#ffffff", { tex: T.pegboard, rough: 0.7 });
      for (const [hx, hy] of [[-0.14, 0.15], [0.12, 0.15], [-0.1, -0.06], [0.14, -0.04]]) rod(d, [hx, hy, 0.03], [hx, hy + 0.012, 0.085], 0.003, C.chrome, { metal: 0.6, seg: 5 });
      d.at([-0.14, 0.09, 0.045], [PI / 2, 0, 0.08], () => padModern(d, "#2a2a32", C.magenta));
      d.at([0.12, 0.09, 0.045], [PI / 2, 0, -0.06], () => padModern(d, "#e8e4f0", C.cyan));
      d.at([-0.1, -0.12, 0.042], [PI / 2, 0, 0.04], () => padClassic(d));
      for (let k = 0; k < 4; k++) d.torus(0.04 - k * 0.002, 0.004, [0.14, -0.075 - k * 0.004, 0.055], "#1a1a20", { rot: [0.2 * k, 0.3, 0], seg: 14 });
    });

  d.at([sx + 0.68, 1.42, L.Z0], null, () => (T.perlers.length ? framed(d, 0.36, 0.48, T.hiScores, "#a35cff") : framed(d, 0.36, 0.48, T.extraLife, "#16141a")));
}

/**
 * Perler sets: the biggest themed set (Breath of Fire III / Streets of Rage) gets the gallery above the
 * credenza, the other one the front wall by the window, and favourites from other games hang in the
 * TV nook.
 */
function perlerSets(P: Perler[]) {
  const sor = P.filter((p) => /streets of rage/i.test(p.game));
  const bof = P.filter((p) => /breath of fire/i.test(p.game));
  const rest = P.filter((p) => !sor.includes(p) && !bof.includes(p));
  let [main, front] = bof.length >= sor.length ? [bof, sor] : [sor, bof];
  if (!main.length) main = rest.splice(0, 9);
  return { main: main.slice(0, 10), front: front.slice(0, 5), nook: rest.slice(0, 6) };
}
/**
 * A salon-style cluster of perler pieces filling `w`×`h` (centred on the current origin, on a wall
 * facing +z). No frames or backing: the beads hang on the wall with a neon halo behind each piece.
 * Every piece uses the same bead pitch, like real 5 mm beads, so a big sprite makes a big piece; the
 * pitch is the largest that fits.
 */
function perlerCluster(d: DecorBuilder, items: Perler[], w: number, h: number) {
  if (!items.length) return;
  const GAP = 0.03, MAX_PITCH = 0.0062;
  // try every row count (items split evenly, in order) and keep the one with the biggest beads
  let best = { p: 0, rows: [] as Perler[][] };
  for (let r = 1; r <= items.length; r++) {
    const rows: Perler[][] = [];
    for (let k = 0, i = 0; k < r; k++) {
      const n = Math.round((items.length - i) / (r - k));
      rows.push(items.slice(i, i + n));
      i += n;
    }
    const pw = Math.min(...rows.map((row) => (w - GAP * (row.length - 1)) / row.reduce((a, it) => a + it.bw, 0)));
    const ph = (h - GAP * (r - 1)) / rows.reduce((a, row) => a + Math.max(...row.map((it) => it.bh)), 0);
    const p = Math.min(pw, ph, MAX_PITCH);
    if (p > best.p * 1.02) best = { p, rows };
  }
  const p = best.p;
  if (p <= 0) return;
  const rowH = best.rows.map((row) => Math.max(...row.map((it) => it.bh)) * p);
  let y = (rowH.reduce((a, b) => a + b, 0) + GAP * (rowH.length - 1)) / 2;
  best.rows.forEach((row, r) => {
    const rw = row.reduce((a, it) => a + it.bw * p, 0) + GAP * (row.length - 1);
    let x = -rw / 2;
    for (const it of row) {
      const pw = it.bw * p, ph = it.bh * p;
      d.at([x + pw / 2, y - rowH[r] / 2, 0], null, () => {
        d.plane([pw, ph], [0, 0, 0.006], "#ffffff", { tex: it.halo, glow: 0.38, rough: 0.6 });
        d.plane([pw, ph], [0, 0, 0.014], "#ffffff", { tex: it.rect, glow: 0.3, rough: 0.35 });
      });
      x += pw + GAP;
    }
    y -= rowH[r] + GAP;
  });
}

/** Free back wall between the TV nook and the console bookcases: credenza, fridge, cat corner + wall stuff. */
async function backWall(d: DecorBuilder, L: DenLayout, T: Tex, ctx: LevelCtx, anim: Tick[], subs: DecorBuilder[]) {
  const x0 = L.nookX + 0.9, x1 = L.consoleX0 - 0.08;
  let x = x0;
  const z = L.Z0;
  const wallTop = L.CEIL - 0.27;
  let lightsTo = x0;
  // ---- credenza with turntable ----
  if (x1 - x >= 1.45) {
    const cx = x + 0.7;
    x += 1.5;
    lightsTo = x;
    await credenza(d, T, cx, z, ctx, anim, subs);
    d.at([cx, 1.42, z], null, () => whiteboard(d, T));
    await tick();
    if (T.perlers.length) {
      // the perler gallery: a wall of framed bead sprites above the whiteboard
      d.at([cx, 2.19, z], null, () => perlerCluster(d, perlerSets(T.perlers).main, 1.42, 0.74));
    } else {
      d.at([cx - 0.3, 2.2, z], [0, 0, 0.015], () => framed(d, 0.36, 0.48, T.nightDrive, "#16141a"));
      d.at([cx + 0.3, 2.2, z], [0, 0, -0.01], () => framed(d, 0.36, 0.48, T.hiScores, "#a35cff"));
    }
  }
  // ---- mini fridge + corkboard + clock ----
  if (x1 - x >= 0.55) {
    const cx = x + 0.26;
    x += 0.6;
    lightsTo = x;
    await tick();
    miniFridge(d, T, cx, z);
    d.at([cx + 0.31, 0.32, z], null, () => outlet(d, [[0, -0.12, 0.03], [-0.05, -0.28, 0.05], [-0.16, -0.31, 0.12]]));

    await tick();
    d.at([cx, 1.45, z], null, () => corkboard(d, T));
    wallClock(d, T, ctx, anim, subs, [cx, 2.17, z]);
  }
  // ---- cat corner: bed + bowls, floating shelves of figurines, calendar ----
  if (x1 - x >= 0.45) {
    const cx = Math.min(x + 0.3, x1 - 0.22);
    lightsTo = x1;
    await tick();
    catCorner(d, cx, z);
    await tick();
    floatingShelves(d, T, cx, z);
    d.at([cx, 2.12, z], null, () => {
      d.box([0.33, 0.45, 0.006], [0, 0, 0.003], "#d8d2c4");
      d.plane([0.3, 0.42], [0, -0.01, 0.0065], "#ffffff", { tex: T.calendar, rough: 0.7, glow: 0.05 });
      d.cyl(0.006, 0.006, 0.02, [0, 0.215, 0.01], "#9aa0aa", { rot: [PI / 2, 0, 0], seg: 6, metal: 0.8 });
    });
  }
  await tick();
  // ---- string lights swagged along the top of the wall ----
  if (lightsTo - x0 > 0.6) stringLights(d, [x0 - 0.05, wallTop + 0.02, z + 0.04], [lightsTo, wallTop + 0.02, z + 0.04], 3);
}

async function credenza(d: DecorBuilder, T: Tex, cx: number, z: number, ctx: LevelCtx, anim: Tick[], subs: DecorBuilder[]) {
  const W = 1.4, H = 0.5, D = 0.42, y0 = 0.16, zc = 0.025 + D / 2;
  const bay = (W - 0.05) / 3, top = y0 + H;
  d.at([cx, 0, z], null, () => {
    for (const sxx of [-1, 1]) for (const szz of [-1, 1]) rod(d, [sxx * (W / 2 - 0.1), y0, zc + szz * (D / 2 - 0.08)], [sxx * (W / 2 - 0.07), 0, zc + szz * (D / 2 - 0.05)], 0.022, C.walnutDark, { r2: 0.013 });
    rbox(d, [W + 0.02, 0.03, D + 0.02], [0, y0 + H - 0.015, zc], C.walnut, { r: 0.012, axis: "y", rough: 0.45 });
    d.box([W - 0.02, 0.025, D], [0, y0 + 0.0125, zc], C.walnut, { rough: 0.5 });
    d.box([0.025, H - 0.03, D], [-W / 2 + 0.0125, y0 + H / 2 - 0.015, zc], C.walnut, { rough: 0.5 });
    d.box([0.025, H - 0.03, D], [W / 2 - 0.0125, y0 + H / 2 - 0.015, zc], C.walnut, { rough: 0.5 });
    d.box([W - 0.02, H - 0.03, 0.01], [0, y0 + H / 2, 0.03], C.walnutDark);
    for (const sxx of [-1, 1]) d.box([0.02, H - 0.05, D - 0.02], [(sxx * bay) / 2, y0 + H / 2, zc], C.walnut, { rough: 0.5 });
    // left bay: records (spines in their covers' colours), one turned face-out at the front
    const left = -W / 2 + 0.025;
    for (let i = 0; i < 15; i++) {
      const col = T.recColors[(i * 3) % T.recColors.length];
      d.box([0.007, 0.31, 0.31], [left + 0.03 + i * 0.026, y0 + 0.025 + 0.155, zc - 0.01], col, { rot: [0, 0, (rnd() - 0.5) * 0.08], rough: 0.6 });
    }
    d.at([left + bay / 2 + 0.01, y0 + 0.026, zc + 0.172], [-0.06, 0.03, 0], () => d.box([0.3, 0.3, 0.004], [0, 0.15, 0], "#ffffff", { tex: T.recSleeves[2 % T.recSleeves.length], face: "front", rough: 0.5 }));
  });
  await tick();
  d.at([cx, 0, z], null, () => {
    // middle bay: slatted doors + brass pull
    for (let i = 0; i < 16; i++) d.box([0.02, H - 0.06, 0.014], [-bay / 2 + 0.03 + i * ((bay - 0.04) / 15), y0 + H / 2, zc + D / 2 - 0.005], C.walnut, { rough: 0.45 });
    d.box([bay - 0.02, H - 0.06, 0.006], [0, y0 + H / 2, zc + D / 2 - 0.016], "#140e0a");
    d.cyl(0.012, 0.012, 0.02, [0, y0 + H / 2, zc + D / 2 + 0.012], C.brass, { rot: [PI / 2, 0, 0], seg: 12, metal: 0.9, rough: 0.25 });
    // right bay: inner shelf, magazines below, board games above
    d.box([bay - 0.02, 0.016, D - 0.03], [bay, y0 + 0.25, zc], C.walnut);
    d.at([bay, y0 + 0.025, zc + 0.02], [0, PI / 2, 0], () => magazineStack(d, T, 6, 9));
    d.at([bay, y0 + 0.258, zc + 0.01], null, () => {
      d.box([0.4, 0.07, 0.3], [0, 0.035, 0], "#2a5f9a", { rough: 0.6 });
      d.box([0.4, 0.004, 0.3], [0, 0.071, 0], "#f2e8d0", { rough: 0.6 });
      d.box([0.36, 0.06, 0.26], [0.01, 0.103, -0.01], "#d8262f", { rough: 0.6, rot: [0, 0.06, 0] });
    });
  });
  await tick();
  d.at([cx, 0, z], null, () => {
    // ---- on top ----
    d.at([-0.56, top, 0.24], [0, 0.12, 0], () => shelfSpeaker(d));
    d.at([0.58, top, 0.24], [0, -0.12, 0], () => shelfSpeaker(d));
    // vinyl sleeves leaning on the wall: the one in front is the record on the platter
    d.at([-0.22, top, 0.045], [-0.12, 0.05, 0], () => d.box([0.3, 0.3, 0.004], [0, 0.15, 0], "#ffffff", { tex: T.recSleeves[1 % T.recSleeves.length], face: "front", rough: 0.5 }));
    d.at([-0.16, top, 0.06], [-0.1, -0.04, 0], () => d.box([0.3, 0.3, 0.004], [0, 0.15, 0], "#ffffff", { tex: T.recSleeves[0], face: "front", rough: 0.5 }));
    // turntable
    const tx = -0.2, tz = 0.25;
    d.at([tx, top, tz], null, () => {
      rbox(d, [0.42, 0.075, 0.33], [0, 0.045, 0], "#1c1a20", { r: 0.012, axis: "y", rough: 0.35 });
      for (const sxx of [-1, 1]) for (const szz of [-1, 1]) d.cyl(0.018, 0.02, 0.008, [sxx * 0.18, 0.004, szz * 0.14], "#9aa0aa", { seg: 10, metal: 0.8 });
      d.cyl(0.145, 0.145, 0.014, [-0.04, 0.0895, 0], "#b9bec8", { seg: 32, metal: 0.85, rough: 0.25 });
      d.cyl(0.026, 0.026, 0.02, [0.15, 0.092, -0.1], "#2a2a30", { seg: 14, metal: 0.6 });
      rod(d, [0.15, 0.11, -0.1], [0.12, 0.112, 0.02], 0.004, C.chrome, { metal: 0.9 });
      rod(d, [0.12, 0.112, 0.02], [0.06, 0.108, 0.09], 0.004, C.chrome, { metal: 0.9 });
      d.box([0.02, 0.008, 0.035], [0.055, 0.104, 0.1], "#1a1a20", { rot: [0, 0.6, 0] });
      d.cyl(0.004, 0.004, 0.03, [0.17, 0.095, 0.03], C.chrome, { seg: 6, metal: 0.9 });
      d.cyl(0.012, 0.012, 0.012, [-0.17, 0.086, 0.13], C.chrome, { seg: 12, metal: 0.9 });
      d.cyl(0.012, 0.012, 0.012, [-0.13, 0.086, 0.13], C.chrome, { seg: 12, metal: 0.9 });
      d.box([0.006, 0.004, 0.004], [0.17, 0.084, 0.1655], "#ff3030", { glow: 2.5 });
    });
  });
  await tick();
  d.at([cx, 0, z], null, () => {
    // headphones on a stand
    d.at([0.2, top, 0.24], [0, -0.25, 0], () => {
      d.cyl(0.055, 0.06, 0.012, [0, 0.006, 0], "#1c1a20", { seg: 18, metal: 0.4, rough: 0.35 });
      d.cyl(0.007, 0.007, 0.25, [0, 0.135, 0], "#1c1a20", { seg: 8, metal: 0.4 });
      rbox(d, [0.07, 0.012, 0.035], [0, 0.262, 0], "#1c1a20", { r: 0.005 });
      d.torus(0.085, 0.012, [0, 0.183, 0], "#24222a", { arc: PI, seg: 16, rough: 0.6 });
      for (const sxx of [-1, 1]) {
        d.cyl(0.045, 0.045, 0.035, [sxx * 0.092, 0.16, 0], "#24222a", { rot: [0, 0, PI / 2], seg: 18, rough: 0.5 });
        d.torus(0.036, 0.009, [sxx * 0.072, 0.16, 0], "#141218", { rot: [0, PI / 2, 0], seg: 16, rough: 0.9 });
        d.torus(0.044, 0.0025, [sxx * 0.11, 0.16, 0], C.magenta, { rot: [0, PI / 2, 0], seg: 18, glow: 1.2 });
      }
    });
    // mushroom lamp
    d.at([0.4, top, 0.12], null, () => {
      d.lathe([[0, 0], [0.05, 0], [0.05, 0.01], [0.022, 0.03], [0.018, 0.14], [0, 0.14]], [0, 0, 0], "#f2e8d8", { seg: 16, rough: 0.4 });
      d.lathe([[0, 0.13], [0.1, 0.12], [0.11, 0.135], [0.095, 0.18], [0.06, 0.21], [0, 0.222]], [0, 0, 0], "#ffb36b", { seg: 22, glow: 0.7, rough: 0.6 });
    });
  });
  // the record spins (33 1/3)
  const rec = d.sub();
  rec.plane([0.285, 0.285], [0, 0, 0], "#ffffff", { tex: T.recordDisc, rot: [-PI / 2, 0, 0], rough: 0.3 });
  rec.cyl(0.0035, 0.0035, 0.018, [0, 0.006, 0], C.chrome, { seg: 6, metal: 0.9 });
  const recMesh = rec.build("den-record");
  recMesh.position.set(cx - 0.2 - 0.04, y0 + H + 0.0975, z + 0.25);
  ctx.scene.add(recMesh);
  subs.push(rec);
  anim.push((dt) => (recMesh.rotation.y -= dt * 3.49));
}

function whiteboard(d: DecorBuilder, T: Tex) {
  const w = 1.0, h = 0.625;
  d.box([w, h, 0.01], [0, 0, 0.005], "#dfe3e8");
  d.plane([w - 0.02, h - 0.02], [0, 0, 0.0105], "#ffffff", { tex: T.whiteboard, rough: 0.2, glow: 0.05 });
  for (const s of [-1, 1]) {
    d.box([w + 0.03, 0.016, 0.022], [0, (s * (h + 0.016)) / 2, 0.011], "#b9bec8", { metal: 0.85, rough: 0.3 });
    d.box([0.016, h, 0.022], [(s * (w + 0.016)) / 2, 0, 0.011], "#b9bec8", { metal: 0.85, rough: 0.3 });
  }
  d.box([0.6, 0.012, 0.05], [0, -h / 2 - 0.022, 0.03], "#b9bec8", { metal: 0.85, rough: 0.3 });
  d.box([0.6, 0.02, 0.006], [0, -h / 2 - 0.014, 0.055], "#b9bec8", { metal: 0.85, rough: 0.3 });
  const markers: [number, string][] = [[-0.22, "#d4213d"], [-0.14, "#1d3fa6"], [0.04, "#1d7a3a"]];
  for (const [mx, col] of markers) {
    d.cyl(0.008, 0.008, 0.11, [mx, -h / 2 - 0.007, 0.032], "#f4f4f4", { rot: [0, 0, PI / 2], seg: 8 });
    d.cyl(0.0085, 0.0085, 0.03, [mx + 0.065, -h / 2 - 0.007, 0.032], col, { rot: [0, 0, PI / 2], seg: 8 });
  }
  d.box([0.11, 0.03, 0.045], [0.2, -h / 2 + 0.002, 0.032], "#2a2a30");
  d.box([0.11, 0.012, 0.045], [0.2, -h / 2 - 0.01, 0.032], "#cfcfd6");
  for (const [mx, my, col] of [[0.43, 0.24, "#ff3d9a"], [-0.45, -0.2, "#4fd8ff"], [0.08, 0.26, "#ffd23f"]] as [number, number, string][])
    d.cyl(0.014, 0.014, 0.01, [mx, my, 0.016], col, { rot: [PI / 2, 0, 0], seg: 12, rough: 0.3 });
}

function corkboard(d: DecorBuilder, T: Tex) {
  const w = 0.56, h = 0.42;
  d.plane([w, h], [0, 0, 0.0135], "#ffffff", { tex: T.cork, rough: 0.9, glow: 0.05 });
  d.box([w, h, 0.012], [0, 0, 0.006], "#8a6440");
  for (const s of [-1, 1]) {
    d.box([w + 0.05, 0.025, 0.026], [0, (s * (h + 0.025)) / 2, 0.013], C.walnut, { rough: 0.5 });
    d.box([0.025, h, 0.026], [(s * (w + 0.025)) / 2, 0, 0.013], C.walnut, { rough: 0.5 });
  }
}

function wallClock(d: DecorBuilder, T: Tex, ctx: LevelCtx, anim: Tick[], subs: DecorBuilder[], at: Vec3) {
  const R = 0.16;
  d.at(at, null, () => {
    d.cyl(R, R, 0.04, [0, 0, 0.02], "#16121e", { rot: [PI / 2, 0, 0], seg: 32, rough: 0.4 });
    d.torus(R, 0.012, [0, 0, 0.038], "#2a2238", { seg: 36, metal: 0.6, rough: 0.3 });
    d.torus(R + 0.002, 0.004, [0, 0, 0.045], C.magenta, { seg: 36, glow: 1.4 });
    d.plane([R * 2 - 0.02, R * 2 - 0.02], [0, 0, 0.0405], "#ffffff", { tex: T.clock, rough: 0.35, glow: 0.12 });
    d.cyl(0.01, 0.01, 0.012, [0, 0, 0.05], "#d8d8e0", { rot: [PI / 2, 0, 0], seg: 10, metal: 0.8 });
  });
  const hand = (name: string, len: number, w: number, col: string, zz: number, glow = 0) => {
    const s = d.sub();
    s.box([w, len, 0.003], [0, len / 2 - 0.015, 0], col, { metal: 0.3, rough: 0.4, glow });
    const m = s.build(name);
    m.position.set(at[0], at[1], at[2] + zz);
    ctx.scene.add(m);
    subs.push(s);
    return m;
  };
  const hh = hand("den-clock-h", 0.085, 0.012, "#e8e4f0", 0.043);
  const mh = hand("den-clock-m", 0.125, 0.008, "#e8e4f0", 0.045);
  const sh = hand("den-clock-s", 0.13, 0.003, "#ff3d9a", 0.047, 0.8);
  anim.push(() => {
    const n = new Date();
    const s = n.getSeconds() + n.getMilliseconds() / 1000;
    const m = n.getMinutes() + s / 60;
    const h = (n.getHours() % 12) + m / 60;
    sh.rotation.z = -(Math.floor(s) / 60) * PI * 2;
    mh.rotation.z = -(m / 60) * PI * 2;
    hh.rotation.z = -(h / 12) * PI * 2;
  });
}

function miniFridge(d: DecorBuilder, T: Tex, cx: number, z: number) {
  const W = 0.5, H = 0.82, D = 0.5, zc = 0.03 + D / 2;
  d.at([cx, 0, z], null, () => {
    for (const sxx of [-1, 1]) for (const szz of [-1, 1]) d.cyl(0.015, 0.015, 0.025, [sxx * 0.2, 0.0125, zc + szz * 0.2], "#222", { seg: 8 });
    rbox(d, [W, H, D], [0, 0.025 + H / 2, zc], "#e2d9c6", { r: 0.035, bevel: 0.01, rough: 0.3, metal: 0.05 });
    rbox(d, [W - 0.03, H - 0.05, 0.02], [0, 0.025 + H / 2 - 0.01, zc + D / 2 + 0.002], "#ebe3d2", { r: 0.025, bevel: 0.006, rough: 0.28, metal: 0.05 });
    d.box([W - 0.06, 0.03, 0.006], [0, 0.025 + H - 0.05, zc + D / 2 + 0.008], "#b8ae9a", { rough: 0.6 });
    d.box([0.016, 0.3, 0.016], [W / 2 - 0.05, 0.025 + H * 0.58, zc + D / 2 + 0.03], C.chrome, { metal: 0.9, rough: 0.2 });
    for (const yy of [-0.13, 0.13]) d.box([0.016, 0.016, 0.026], [W / 2 - 0.05, 0.025 + H * 0.58 + yy, zc + D / 2 + 0.017], C.chrome, { metal: 0.9, rough: 0.2 });
    // stickers + a sticky note
    const fz = zc + D / 2 + 0.0125;
    const stick: [number, number, number, number][] = [[-0.12, 0.62, 0.09, 0.2], [0.06, 0.66, 0.08, -0.15], [-0.08, 0.36, 0.1, 0.1], [0.08, 0.24, 0.085, -0.3]];
    stick.forEach(([sx, sy, s, r], i) => d.plane([s, s], [sx, sy, fz], "#ffffff", { tex: T.stickers[i], rot: [0, 0, r], rough: 0.4 }));
    d.plane([0.07, 0.07], [-0.13, 0.17, fz], "#ffffff", { tex: T.notes[0], rot: [0, 0, 0.08], rough: 0.8 });
    d.box([0.01, 0.003, 0.003], [-0.17, 0.025 + H - 0.035, zc + D / 2 + 0.012], "#3dff6a", { glow: 2 });
    // on top: cans, cup noodles, token jar
    const top = 0.025 + H;
    d.at([-0.14, top, zc + 0.08], null, () => sodaCan(d, T.cans[0]));
    d.at([-0.065, top, zc + 0.12], [0, 0.35, 0], () => sodaCan(d, T.cans[1]));
    d.at([0.0, top, zc - 0.1], null, () => cupNoodle(d));
    d.at([0.13, top, zc + 0.04], null, () => tokenJar(d, T.tokens));
  });
}

function catCorner(d: DecorBuilder, cx: number, z: number) {
  d.at([cx, 0, z + 0.3], null, () => {
    d.lathe([[0, 0.012], [0.17, 0.012], [0.205, 0.04], [0.22, 0.09], [0.205, 0.135], [0.17, 0.125], [0.145, 0.07], [0, 0.06]], [0, 0, 0], "#5b2a6e", { seg: 26, rough: 0.95 });
    d.lathe([[0, 0], [0.18, 0], [0.18, 0.014], [0, 0.014]], [0, 0, 0], "#2a1438", { seg: 20 });
    d.cyl(0.14, 0.14, 0.02, [0, 0.07, 0], "#e8d8f0", { seg: 22, rough: 0.95 });
    // a well-loved yarn ball and a fish toy
    d.sphere(0.04, [0.12, 0.084, 0.04], "#ff5aa8", { seg: 10, rough: 0.95 });
    for (let i = 0; i < 3; i++) d.torus(0.041, 0.003, [0.12, 0.084, 0.04], "#ff8ac8", { rot: [i * 1.1, i * 0.7, 0], seg: 16 });
    d.tube([[0.12, 0.05, 0.075], [0.15, 0.012, 0.15], [0.25, 0.006, 0.22], [0.32, 0.006, 0.18]], 0.0025, "#ff5aa8", { seg: 16 });
    const fish = new THREE.Shape();
    fish.moveTo(-0.05, 0);
    fish.quadraticCurveTo(-0.01, 0.03, 0.03, 0.0);
    fish.lineTo(0.055, 0.02);
    fish.lineTo(0.055, -0.02);
    fish.lineTo(0.03, 0.0);
    fish.quadraticCurveTo(-0.01, -0.03, -0.05, 0);
    slabShape(d, fish, 0.018, [-0.16, 0.012, 0.24], "#4fd8ff", { rot: [-PI / 2, 0, 0.6], bevel: 0.004, segs: 4 });
  });
  // bowls
  for (const [bx, col, fill] of [[-0.06, "#ff3d9a", "#7a4a2a"], [0.1, "#4fd8ff", "#6fb8e8"]] as [number, string, string][]) {
    d.at([cx + bx, 0, z + 0.6], null, () => {
      d.lathe([[0, 0], [0.05, 0], [0.065, 0.04], [0.058, 0.042], [0.045, 0.01], [0, 0.01]], [0, 0, 0], col, { seg: 18, rough: 0.25 });
      d.cyl(0.05, 0.05, 0.003, [0, 0.03, 0], fill, { seg: 16, rough: fill === "#6fb8e8" ? 0.05 : 0.9 });
    });
  }
}

function floatingShelves(d: DecorBuilder, T: Tex, cx: number, z: number) {
  const ys = [1.05, 1.34, 1.63];
  ys.forEach((y, i) => {
    d.at([cx, y, z], null, () => {
      d.box([0.5, 0.025, 0.17], [0, 0, 0.085], C.walnut, { rough: 0.45 });
      d.box([0.46, 0.004, 0.006], [0, -0.0145, 0.16], C.cyan, { glow: 0.9 });
      const top = 0.0125;
      if (i === 0) {
        d.at([-0.16, top, 0.09], [0, 0.3, 0], () => mushroomFig(d));
        d.at([-0.03, top, 0.1], [0, -0.2, 0], () => slimeFig(d, "#3dffa8"));
        d.at([0.12, top, 0.09], [0, -0.3, 0], () => robotFig(d));
      } else if (i === 1) {
        d.at([-0.15, top, 0.08], null, () => trophy(d));
        for (let k = 0; k < 3; k++) d.box([0.12, 0.018, 0.1], [0.05, top + 0.009 + k * 0.018, 0.08], ["#7a7a82", "#3a3a44", "#c9c6bd"][k], { rot: [0, (k - 1) * 0.12, 0], rough: 0.5 });
        d.at([0.18, top, 0.08], null, () => succulent(d, "#f4f1ea"));
      } else {
        d.at([-0.14, top, 0.08], [0, 0.2, 0], () => brickHandheld(d));
        d.at([0.0, top, 0.09], [0, 0.4, 0], () => puzzleCube(d));
        // a little easel frame with a favourite album
        d.at([0.15, top, 0.08], [-0.12, -0.2, 0], () => {
          d.box([0.1, 0.1, 0.012], [0, 0.05, 0], "#16141a", { rough: 0.4 });
          d.plane([0.084, 0.084], [0, 0.05, 0.0062], "#ffffff", { tex: T.recSleeves[5 % T.recSleeves.length], rough: 0.5, glow: 0.05 });
          d.box([0.012, 0.085, 0.006], [0, 0.04, -0.03], "#16141a", { rot: [0.45, 0, 0] });
        });
      }
    });
  });
}

function stringLights(d: DecorBuilder, a: Vec3, b: Vec3, swags: number) {
  const pts: Vec3[] = [];
  const N = 60;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const local = (t * swags) % 1;
    const sag = Math.sin(local * PI) * 0.14;
    pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag, a[2] + (b[2] - a[2]) * t + 0.01]);
  }
  d.tube(pts, 0.0018, "#1a1a20", { seg: 140, rough: 0.6 });
  for (let i = 0; i <= swags; i++) {
    const t = i / swags;
    d.cyl(0.004, 0.004, 0.03, [a[0] + (b[0] - a[0]) * t, a[1] + 0.005, a[2] + 0.005], "#9aa0aa", { rot: [PI / 2, 0, 0], seg: 6, metal: 0.8 });
  }
  const bulbs = Math.round(Math.abs(b[0] - a[0]) / 0.16);
  const cols = ["#ffd28a", "#ff8ac8", "#8ae8ff", "#ffd28a", "#c8a0ff"];
  for (let i = 1; i < bulbs; i++) {
    const p = pts[Math.round((i / bulbs) * N)];
    d.cyl(0.006, 0.006, 0.014, [p[0], p[1] - 0.008, p[2]], "#1a1a20", { seg: 6 });
    d.sphere(0.012, [p[0], p[1] - 0.024, p[2]], cols[i % cols.length], { seg: 7, glow: 1.6, scale: [1, 1.3, 1] });
  }
}

/** Battlestation desk dressing (left wall, around the existing desk + CRT). */
async function battlestation(d: DecorBuilder, L: DenLayout, T: Tex) {
  // local frame: z = distance from the left wall, x = along the wall (towards -z world)
  const top = 0.76;
  const frame = (fn: () => void) => d.at([L.X0, 0, L.deskZ], [0, PI / 2, 0], fn);
  frame(() => {
    // monitor riser so the CRT stops floating
    rbox(d, [0.28, 0.05, 0.3], [0, top + 0.025, 0.36], "#cfc6ae", { r: 0.02, axis: "y", rough: 0.6 });
    // desk mat with a neon edge
    d.box([1.0, 0.004, 0.3], [0, top + 0.002, 0.565], "#120f18", { rough: 0.9 });
    d.box([1.0, 0.005, 0.006], [0, top + 0.002, 0.716], C.magenta, { glow: 0.5 });
    // keyboard + mouse
    d.at([0, top + 0.004, 0.64], [0.06, 0, 0], () => {
      rbox(d, [0.44, 0.024, 0.14], [0, 0.012, 0], "#c9bfa6", { r: 0.008, rough: 0.6 });
      d.plane([0.42, 0.125], [0, 0.0245, 0], "#ffffff", { tex: T.keyboard, rot: [-PI / 2, 0, 0], rough: 0.6 });
    });
    d.sphere(0.03, [0.34, top + 0.016, 0.63], "#cfc6ae", { seg: 12, scale: [0.85, 0.55, 1.4] });
    d.box([0.002, 0.003, 0.02], [0.34, top + 0.032, 0.605], "#8a8270");
    cable(d, [[0.34, top + 0.012, 0.585], [0.33, top + 0.01, 0.5], [0.28, top + 0.008, 0.36], [0.22, top + 0.01, 0.18]], "#c9bfa6", 0.0022);
    cable(d, [[0, top + 0.02, 0.57], [0.03, top + 0.008, 0.5], [0.12, top + 0.006, 0.3], [0.15, top + 0.01, 0.12]], "#c9bfa6", 0.0022);
  });
  await tick();
  frame(() => {
    // beige speakers
    for (const sxx of [-1, 1])
      d.at([sxx * 0.31, top, 0.32], [0, -sxx * 0.25, 0], () => {
        rbox(d, [0.1, 0.17, 0.11], [0, 0.085, 0], "#d2c8b0", { r: 0.01, axis: "y", rough: 0.6 });
        d.at([0, 0.065, 0.056], null, () => speakerDriver(d, 0.032, "#b8ae96"));
        d.at([0, 0.135, 0.056], null, () => speakerDriver(d, 0.013, "#b8ae96"));
      });
  });
  await tick();
  frame(() => {
    // desk lamp (articulated) on the left
    d.at([-0.5, top, 0.2], [0, 0.5, 0], () => {
      d.cyl(0.065, 0.07, 0.022, [0, 0.011, 0], "#16141a", { seg: 18, metal: 0.4 });
      d.sphere(0.014, [0, 0.03, 0], "#2a2830", { seg: 8 });
      rod(d, [0, 0.03, 0], [0.0, 0.34, 0.1], 0.007, "#2a2830", { metal: 0.5 });
      d.sphere(0.012, [0, 0.34, 0.1], "#2a2830", { seg: 8 });
      rod(d, [0, 0.34, 0.1], [0, 0.4, 0.32], 0.006, "#2a2830", { metal: 0.5 });
      d.at([0, 0.4, 0.32], [-0.9, 0, 0], () => {
        const shade: [number, number][] = [[0.02, 0.01], [0.04, -0.03], [0.075, -0.1]];
        d.lathe(shade, [0, 0, 0], C.magenta, { seg: 18, metal: 0.3, rough: 0.35 });
        d.lathe([...shade].reverse(), [0, 0, 0], "#ffe2b8", { seg: 18, glow: 0.9, scale: [0.97, 1, 0.97] });
        d.sphere(0.022, [0, -0.06, 0], "#fff4dc", { seg: 10, glow: 2.2 });
      });
    });
  });
  await tick();
  frame(() => {
    // mug, floppies, CD spindle, joystick
    d.at([0.47, top, 0.6], [0, 2.2, 0], () => mug(d, "#f2ece0", C.magenta));
    d.at([0.4, top, 0.47], [0, 0.2, 0], () => juiceBottle(d, T.cans[3], "#ffb347"));
    for (let i = 0; i < 6; i++)
      d.at([0.5, top + i * 0.0035, 0.38], [0, (rnd() - 0.5) * 0.4, 0], () => {
        d.box([0.09, 0.0033, 0.094], [0, 0.00165, 0], ["#1a1a20", "#2a5f9a", "#d8262f", "#1d7a5a", "#ffb000", "#f2f2f2"][i]);
        if (i === 5) {
          d.box([0.05, 0.001, 0.03], [0, 0.0035, -0.03], "#b9bec8", { metal: 0.8 });
          d.box([0.07, 0.001, 0.05], [0, 0.0035, 0.02], "#f8f6f0");
        }
      });
    d.at([0.5, top, 0.15], null, () => {
      d.cyl(0.065, 0.065, 0.008, [0, 0.004, 0], "#1a1a20", { seg: 20 });
      for (let i = 0; i < 14; i++) d.cyl(0.06, 0.06, 0.0013, [0, 0.009 + i * 0.0016, 0], i % 2 ? "#cfd6e2" : "#b9c2d6", { seg: 22, metal: 0.8, rough: 0.15 });
      d.cyl(0.007, 0.007, 0.12, [0, 0.06, 0], "#1a1a20", { seg: 8 });
    });
    d.at([-0.34, top, 0.6], [0, 0.3, 0], () => {
      rbox(d, [0.12, 0.035, 0.12], [0, 0.0175, 0], "#1d1b22", { r: 0.025, axis: "y", rough: 0.4 });
      d.cyl(0.02, 0.025, 0.012, [0, 0.04, 0], "#111", { seg: 12 });
      rod(d, [0, 0.04, 0], [0.01, 0.15, -0.015], 0.013, "#2a2830", { r2: 0.016, seg: 10 });
      d.box([0.008, 0.02, 0.012], [0.01, 0.11, 0.0], "#e8303a");
      d.cyl(0.006, 0.006, 0.006, [0.01, 0.155, -0.015], "#e8303a", { seg: 8 });
      d.cyl(0.008, 0.008, 0.005, [0.04, 0.036, 0.04], "#ffd23f", { seg: 8 });
    });
  });
  await tick();
  frame(() => {
    // sticky notes on the monitor bezel and the desk
    d.plane([0.045, 0.045], [0.183, 1.14, 0.5615], "#ffffff", { tex: T.notes[0], rot: [0, 0, 0.1], rough: 0.8 });
    d.plane([0.04, 0.04], [-0.185, 0.87, 0.5615], "#ffffff", { tex: T.notes[1], rot: [0, 0, -0.12], rough: 0.8 });
    d.plane([0.06, 0.06], [-0.2, top + 0.0045, 0.68], "#ffffff", { tex: T.notes[2], rot: [-PI / 2, 0, 0.3], rough: 0.8 });
    // under-desk glow strip
    d.box([1.1, 0.006, 0.006], [0, top - 0.025, 0.72], C.magenta, { glow: 1.6 });
  });
  await tick();
  frame(() => {
    // 90s tower PC (turbo button + MHz display)
    d.at([-0.4, 0, 0.32], null, () => {
      rbox(d, [0.2, 0.46, 0.44], [0, 0.24, 0], "#d6ccb4", { r: 0.012, axis: "z", rough: 0.6 });
      for (const sxx of [-1, 1]) for (const szz of [-1, 1]) d.box([0.03, 0.012, 0.03], [sxx * 0.07, 0.006, szz * 0.18], "#2a2830");
      const f = 0.221;
      d.box([0.17, 0.045, 0.003], [0, 0.42, f], "#c9bfa6");
      d.box([0.17, 0.045, 0.003], [0, 0.365, f], "#c9bfa6");
      d.box([0.15, 0.004, 0.002], [0, 0.42, f + 0.002], "#2a2830");
      d.box([0.1, 0.028, 0.003], [-0.02, 0.31, f], "#c9bfa6");
      d.box([0.07, 0.003, 0.002], [-0.02, 0.314, f + 0.002], "#1a1a20");
      d.plane([0.04, 0.02], [0.05, 0.27, f + 0.002], "#ffffff", { tex: T.sevenSeg, glow: 1.3 });
      d.box([0.02, 0.012, 0.008], [-0.05, 0.27, f + 0.003], "#9a9282");
      d.box([0.016, 0.01, 0.008], [-0.02, 0.27, f + 0.003], "#9a9282");
      d.box([0.005, 0.005, 0.003], [-0.06, 0.245, f + 0.002], "#3dff6a", { glow: 2.4 });
      d.box([0.005, 0.005, 0.003], [-0.045, 0.245, f + 0.002], "#ffb000", { glow: 2.4, blink: 9 });
      for (let i = 0; i < 8; i++) d.box([0.14, 0.004, 0.002], [0, 0.08 + i * 0.014, f + 0.001], "#a99f88");
    });
    // waste bin with crumpled paper
    d.at([0.36, 0, 0.42], null, () => {
      d.lathe([[0, 0], [0.09, 0], [0.11, 0.26], [0.105, 0.26], [0.085, 0.01], [0, 0.01]], [0, 0, 0], "#2a2830", { seg: 18, rough: 0.5, metal: 0.4 });
      for (let i = 0; i < 4; i++) d.sphere(0.035, [(rnd() - 0.5) * 0.08, 0.22 + rnd() * 0.04, (rnd() - 0.5) * 0.08], "#f2f0ea", { seg: 5, rough: 0.9 });
    });
    d.sphere(0.032, [0.5, 0.03, 0.6], "#f2f0ea", { seg: 5, rough: 0.9 });
  });
  await tick();
  frame(() => {
    // gaming chair, pulled in and turned a little
    d.at([0.5, 0, 1.0], [0, PI + 0.45, 0], () => gamingChair(d));
  });
}

function gamingChair(d: DecorBuilder) {
  const black = "#141218", accent = "#b0186a";
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * PI * 2 + 0.3;
    d.at([0, 0, 0], [0, a, 0], () => {
      rbox(d, [0.04, 0.03, 0.3], [0, 0.07, 0.15], "#222228", { r: 0.012, axis: "z", rough: 0.35, metal: 0.5 });
      d.sphere(0.025, [0, 0.026, 0.29], "#111114", { seg: 8 });
      d.box([0.012, 0.03, 0.012], [0, 0.05, 0.29], "#333");
    });
  }
  d.cyl(0.045, 0.06, 0.05, [0, 0.085, 0], "#222228", { seg: 14, metal: 0.5, rough: 0.35 });
  d.cyl(0.022, 0.022, 0.3, [0, 0.25, 0], "#b8bcc6", { seg: 10, metal: 0.9, rough: 0.25 });
  d.cyl(0.032, 0.032, 0.09, [0, 0.16, 0], "#18181c", { seg: 10 });
  rbox(d, [0.2, 0.04, 0.2], [0, 0.4, 0], "#1a1a1f");
  rbox(d, [0.52, 0.09, 0.5], [0, 0.465, 0.02], black, { r: 0.06, axis: "y", bevel: 0.02, rough: 0.8 });
  for (const sx of [-1, 1]) rbox(d, [0.07, 0.06, 0.46], [sx * 0.235, 0.52, 0.02], accent, { r: 0.025, axis: "x", bevel: 0.015, rough: 0.75 });
  d.at([0, 0.5, -0.22], [-0.16, 0, 0], () => {
    rbox(d, [0.5, 0.72, 0.09], [0, 0.38, 0], black, { r: 0.08, bevel: 0.02, rough: 0.8 });
    for (const sx of [-1, 1]) rbox(d, [0.07, 0.62, 0.07], [sx * 0.23, 0.34, 0.03], accent, { r: 0.03, bevel: 0.015, rough: 0.75 });
    rbox(d, [0.24, 0.12, 0.06], [0, 0.62, 0.06], accent, { r: 0.05, bevel: 0.02, rough: 0.75 });
    rbox(d, [0.26, 0.13, 0.06], [0, 0.18, 0.06], black, { r: 0.05, bevel: 0.02, rough: 0.8 });
    d.box([0.004, 0.55, 0.004], [0, 0.38, 0.047], accent);
  });
  for (const sx of [-1, 1]) {
    d.box([0.03, 0.2, 0.04], [sx * 0.28, 0.56, -0.02], "#222228", { metal: 0.4, rough: 0.4 });
    rbox(d, [0.07, 0.03, 0.24], [sx * 0.28, 0.67, 0.0], "#1a1a1f", { r: 0.025, axis: "y" });
  }
}

/** Left wall between the desk and the arcade: shoe rack + a skateboard on the wall. */
async function shoeNook(d: DecorBuilder, L: DenLayout, T: Tex) {
  const za = L.deskZ + 0.72, zb = L.Z1 - 0.87;
  if (zb - za < 0.55) return;
  const zc = (za + zb) / 2;
  d.at([L.X0, 0, zc], [0, PI / 2, 0], () => {
    const W = Math.min(0.7, zb - za - 0.06);
    for (const sx of [-1, 1]) for (const z of [0.05, 0.29]) d.cyl(0.008, 0.008, 0.36, [(sx * W) / 2, 0.18, z], C.chrome, { seg: 8, metal: 0.9, rough: 0.25 });
    for (const y of [0.1, 0.3]) for (const z of [0.05, 0.13, 0.21, 0.29]) d.cyl(0.006, 0.006, W, [0, y, z], C.chrome, { rot: [0, 0, PI / 2], seg: 6, metal: 0.9, rough: 0.25 });
    d.at([-0.17, 0.306, 0.16], [0, 0.1, 0], () => sneakers(d, "#f2f0ea", "#ffffff", C.magenta));
    d.at([0.15, 0.306, 0.16], [0, -0.15, 0], () => sneakers(d, "#1a1a20", "#f2f0ea", C.cyan));
    d.at([-0.12, 0.106, 0.16], [0, 0.05, 0], () => sneakers(d, "#c8262c", "#f2f0ea", "#ffffff"));
    for (const sx of [-1, 1]) rbox(d, [0.11, 0.05, 0.25], [0.16 + sx * 0.065, 0.13, 0.16], "#5b2a6e", { r: 0.04, axis: "y", bevel: 0.02, rough: 0.95 });
    d.at([0, 1.3, 0], null, () => skateboard(d, T.deck));
    d.at([0, 2.12, 0.01], [0, 0, -0.06], () => {
      d.plane([0.62, 0.23], [0.02, 0, 0.004], "#ffffff", { tex: T.pennant, rough: 0.95 });
      d.cyl(0.006, 0.006, 0.27, [-0.29, 0, 0.006], "#8a6440", { seg: 6 });
    });

  });
}

function skateboard(d: DecorBuilder, graphic: UVRect) {
  const deck = new THREE.ExtrudeGeometry(roundedRect(0.2, 0.8, 0.099), { depth: 0.012, bevelEnabled: false, curveSegments: 6 });
  d.geo(deck, [0, 0, 0.02], "#0e0e10", { rough: 0.9 });
  d.plane([0.2, 0.8], [0, 0, 0.0325], "#ffffff", { tex: graphic, rough: 0.45, glow: 0.05 });
  for (const y of [-0.3, 0.3]) d.box([0.04, 0.02, 0.02], [0, y, 0.01], "#3a3a44", { metal: 0.6 });
  for (const y of [-0.27, 0.27]) {
    d.box([0.05, 0.075, 0.012], [0, y, 0.039], "#9aa0aa", { metal: 0.8, rough: 0.3 });
    d.box([0.16, 0.022, 0.026], [0, y, 0.06], "#b9bec8", { metal: 0.85, rough: 0.3 });
    d.cyl(0.004, 0.004, 0.22, [0, y, 0.062], "#cccccc", { rot: [0, 0, PI / 2], seg: 6, metal: 0.9 });
    for (const sx of [-1, 1]) d.cyl(0.027, 0.027, 0.032, [sx * 0.095, y, 0.062], "#5ef0d0", { rot: [0, 0, PI / 2], seg: 14, rough: 0.5 });
  }
}

/** Low cubby bench under the cartridge wall (below its lowest row). */
async function cartBench(d: DecorBuilder, L: DenLayout, T: Tex) {
  const len = L.cartZ1 - L.cartZ0 - 0.1;
  const zc = (L.cartZ0 + L.cartZ1) / 2;
  const topY = Math.min(0.38, L.cartBase - 0.22);
  if (len < 1 || topY < 0.25) return;
  const legs = 0.07, H = topY - legs, D = 0.3;
  const n = Math.max(2, Math.round(len / 0.55));
  const cw = len / n;
  d.at([L.X1, 0, zc], [0, -PI / 2, 0], () => {
    const body = "#2a2238";
    d.box([len, 0.022, D], [0, topY - 0.011, D / 2], body, { rough: 0.45, metal: 0.2 });
    d.box([len, 0.02, D], [0, legs + 0.01, D / 2], body, { rough: 0.45, metal: 0.2 });
    d.box([len, H, 0.01], [0, legs + H / 2, 0.005], "#120f1a");
    for (let i = 0; i <= n; i++) d.box([0.02, H, D], [-len / 2 + i * cw, legs + H / 2, D / 2], body, { rough: 0.45, metal: 0.2 });
    for (const sx of [-1, 1]) for (const z of [0.04, D - 0.04]) d.cyl(0.012, 0.012, legs, [sx * (len / 2 - 0.04), legs / 2, z], "#9aa0aa", { seg: 8, metal: 0.8 });
    d.box([len, 0.004, 0.006], [0, topY - 0.024, D - 0.004], C.purple, { glow: 0.9 });
    const binCols = ["#7a3ab0", "#2a8a9a", "#b0306a", "#5a5a8a"];
    for (let i = 0; i < n; i++) {
      const x = -len / 2 + (i + 0.5) * cw, inner = cw - 0.03, y0 = legs + 0.02;
      const kind = i % 3 === 1 ? (i === 1 ? "boxes" : "cables") : "bin";
      if (kind === "bin") {
        const h = H - 0.06;
        rbox(d, [inner - 0.02, h, D - 0.04], [x, y0 + h / 2, D / 2 + 0.005], binCols[i % binCols.length], { r: 0.02, bevel: 0.008, rough: 0.95 });
        rbox(d, [0.09, 0.03, 0.01], [x, y0 + h - 0.04, D - 0.012], "#0c0a10", { r: 0.012 });
        d.plane([0.11, 0.032], [x, y0 + h * 0.42, D - 0.012], "#ffffff", { tex: T.bins[i % T.bins.length], rough: 0.8 });
      } else if (kind === "boxes") {
        d.box([inner - 0.06, 0.1, 0.22], [x, y0 + 0.05, D / 2 + 0.02], "#e8e4dc", { rough: 0.6 });
        d.box([inner - 0.06, 0.03, 0.002], [x, y0 + 0.06, D / 2 + 0.131], "#d8262f");
        d.box([inner - 0.1, 0.08, 0.2], [x + 0.01, y0 + 0.14, D / 2 + 0.02], "#1a1a20", { rough: 0.5, rot: [0, 0.05, 0] });
        d.box([inner - 0.1, 0.02, 0.002], [x + 0.01, y0 + 0.16, D / 2 + 0.121], C.cyan);
      } else {
        for (let k = 0; k < 3; k++) d.torus(0.065, 0.007, [x - 0.06 + k * 0.06, y0 + 0.012 + k * 0.016, D / 2 + 0.03], ["#16161c", "#5a5a64", "#3a1f5a"][k], { rot: [PI / 2, 0, 0], seg: 18 });
        d.at([x + 0.03, y0 + 0.06, D / 2 + 0.05], [0, 0.4, 0.08], () => padModern(d, "#e8e4f0", C.magenta));
      }
    }
  });
}

/** Corners and the free stretch of right wall: snake plant, monstera, boombox on a crate. */
async function rightSide(d: DecorBuilder, L: DenLayout, T: Tex) {
  // back-right corner
  d.at([L.X1 - 0.17, 0, Math.max(L.cartZ0 - 0.3, L.Z0 + 0.42)], null, () => snakePlant(d, "#2a2238"));
  await tick();
  // front-right corner beside the vending machine
  const vEdge = L.vendingX + 0.5;
  if (L.X1 - vEdge > 0.5) d.at([L.X1 - 0.3, 0, L.Z1 - 0.32], null, () => monstera(d, T.leaf, "#1f1a2a", C.cyan));
  await tick();
  // crate + boombox under the right-wall poster
  const zA = L.cartZ1 + 0.06, zB = L.Z1 - 0.95;
  if (zB - zA > 0.45) {
    d.at([L.X1, 0, (zA + zB) / 2], [0, -PI / 2, 0], () => {
      const W = 0.52, H = 0.32, D = 0.36;
      for (const s of [-1, 1]) d.box([0.02, H, D], [(s * (W - 0.02)) / 2, H / 2, D / 2 + 0.02], "#8a6440", { rough: 0.8 });
      for (let i = 0; i < 4; i++) {
        d.box([W, 0.05, 0.016], [0, 0.03 + i * 0.085, D + 0.012], "#9a7450", { rough: 0.8 });
        d.box([W, 0.05, 0.016], [0, 0.03 + i * 0.085, 0.028], "#9a7450", { rough: 0.8 });
      }
      d.box([W - 0.04, 0.016, D], [0, 0.008, D / 2 + 0.02], "#7a5638");
      for (let i = 0; i < 12; i++) d.box([0.31, 0.29, 0.006], [0, 0.16, 0.08 + i * 0.024], T.recColors[(i * 5 + 1) % T.recColors.length], { rot: [0.08 * (rnd() - 0.5), 0, 0], rough: 0.6 });
      // two more pulled out, leaning on the front of the crate
      const n = T.recSleeves.length;
      d.at([-0.1, 0, D + 0.075], [-0.2, 0.06, 0], () => d.box([0.3, 0.3, 0.004], [0, 0.15, 0], "#ffffff", { tex: T.recSleeves[3 % n], face: "front", rough: 0.5 }));
      d.at([0.11, 0, D + 0.1], [-0.22, -0.1, 0], () => d.box([0.3, 0.3, 0.004], [0, 0.15, 0], "#ffffff", { tex: T.recSleeves[4 % n], face: "front", rough: 0.5 }));
      d.at([0, H, D / 2 + 0.02], [0, 0.08, 0], () => boombox(d));
      d.at([W / 2 + 0.12, 0.42, 0], null, () => outlet(d, [[0, -0.1, 0.05], [-0.04, -0.12, 0.12], [-0.1, -0.06, 0.16], [-0.17, -0.02, 0.17]]));

    });
  }
}

/** Window sill clutter, a floor lamp and the backlog boxes by the vending machine, arcade-top plushies. */
async function frontWall(d: DecorBuilder, L: DenLayout, T: Tex) {
  const z = L.Z1;
  // deeper sill board
  d.box([2.94, 0.022, 0.15], [0, 0.841, z - 0.075], "#1c1828", { rough: 0.4, metal: 0.2 });
  d.at([-1.18, 0.852, z - 0.075], null, () => cactus(d, C.terracotta));
  d.at([-0.88, 0.852, z - 0.08], null, () => succulent(d, "#1f1a2a", C.magenta));
  d.at([-0.62, 0.852, z - 0.07], [0, PI + 0.3, 0], () => slimeFig(d, "#a35cff"));
  d.at([-0.4, 0.852, z - 0.075], [0, PI - 0.15, 0], () => juiceBottle(d, T.cans[1], "#ff7ab8"));
  d.at([0.7, 0.852, z - 0.075], [0, PI - 0.2, 0], () => mushroomFig(d));
  d.at([0.95, 0.852, z - 0.08], null, () => succulent(d, C.terracotta));
  d.at([1.2, 0.852, z - 0.075], [0, PI, 0], () => d.at([0, 0, 0], null, () => {
    d.cyl(0.035, 0.04, 0.06, [0, 0.03, 0], "#f4f1ea", { seg: 14 });
    d.cyl(0.03, 0.03, 0.004, [0, 0.06, 0], "#f2e2c8", { seg: 12 });
    d.cyl(0.002, 0.002, 0.012, [0, 0.067, 0], "#222", { seg: 4 });
    d.sphere(0.007, [0, 0.081, 0], "#ffcf7a", { seg: 6, glow: 2, scale: [0.7, 1.4, 0.7] });
  }));
  await tick();
  // between the window and the Want-O-Matic: floor lamp + the BACKLOG boxes
  const vL = L.vendingX - 0.52;
  if (vL - 1.45 > 0.5) {
    const lx = 1.45 + 0.17;
    d.at([lx, 0, z - 0.22], null, () => {
      d.cyl(0.13, 0.14, 0.025, [0, 0.0125, 0], "#16141a", { seg: 22, metal: 0.5, rough: 0.35 });
      d.cyl(0.011, 0.011, 1.45, [0, 0.75, 0], C.brass, { seg: 8, metal: 0.9, rough: 0.25 });
      const shade: [number, number][] = [[0.16, 1.42], [0.14, 1.66]];
      d.lathe(shade, [0, 0, 0], "#f2c48a", { seg: 26, glow: 0.4, rough: 0.9 });
      d.lathe([...shade].reverse(), [0, 0, 0], "#ffd9a0", { seg: 26, glow: 0.85, rough: 0.9, scale: [0.985, 1, 0.985] });
      d.sphere(0.03, [0, 1.5, 0], "#fff1d6", { seg: 10, glow: 2 });
    });
    // wall above: the overflow perlers, or (with the gallery up) the Night Drive poster
    const wx = (1.45 + vL) / 2;
    const more = perlerSets(T.perlers).front;
    if (more.length) d.at([wx, 2.14, z], [0, PI, 0], () => perlerCluster(d, more, vL - 1.5, 0.72));
    else if (T.perlers.length) d.at([wx + 0.05, 2.08, z], [0, PI, 0.012], () => framed(d, 0.36, 0.48, T.nightDrive, "#16141a"));
    const bx = (lx + 0.17 + vL) / 2 + 0.02;
    const bw = Math.min(0.42, vL - lx - 0.2);
    d.at([bx, 0, z - 0.26], [0, PI, 0], () => {
      shippingBox(d, [bw, 0.34, 0.4], T.boxLabel, T.fragile);
      d.at([0.0, 0.34, 0.0], [0, 0.12, 0], () => openBox(d, [bw - 0.04, 0.24, 0.34]));
    });
  }
  await tick();
  // arcade cabinet tops (well back from the marquees)
  L.arcadeXs.forEach((x, i) => {
    d.at([x, 1.85, z - 0.22], [0, PI + (i - 1) * 0.3, 0], () => {
      if (i === 0) d.at([0, 0, 0], null, () => slimeFig(d, "#ff8ac8"), [1.8, 1.8, 1.8]);
      if (i === 1) for (let k = 0; k < 4; k++) d.cyl(0.03, 0.026, 0.06, [-0.05 + k * 0.035, 0.03, (k % 2) * 0.03], k % 2 ? "#ffd23f" : "#ff3d9a", { seg: 12, rough: 0.4 });
      if (i === 2) trophy(d);
    });
  });
}

/** Couch, side tables, floor clutter, bean bags. */
async function centre(d: DecorBuilder, L: DenLayout, T: Tex) {
  const cz = L.couchZ;
  // throw pillows leaning on the backrest
  d.at([-0.62, 0.6, cz + 0.2], [0.32, 0.18, 0.06], () => pillow(d, "#c2186b", 0.42));
  d.at([0.6, 0.6, cz + 0.2], [0.3, -0.2, -0.08], () => pillow(d, "#16707e", 0.42));
  d.at([-0.25, 0.57, cz + 0.16], [0.42, PI + 0.1, 0.12], () => pillow(d, "#2a1440", 0.34, T.heart)); // print faces the room
  // blanket over the left arm (+ a stripe), and a folded corner on the seat
  const path: [number, number][] = [[-0.8, 0.445], [-0.86, 0.462], [-0.892, 0.54], [-0.905, 0.612], [-0.95, 0.628], [-1.05, 0.628], [-1.1, 0.612], [-1.11, 0.52], [-1.113, 0.4], [-1.118, 0.25], [-1.13, 0.16], [-1.16, 0.11]];
  const blanket = (t: number, z0: number, depth: number, col: Color) => {
    const g = new THREE.ExtrudeGeometry(bandShape(path, t), { depth, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.004, bevelSegments: 1, curveSegments: 2 });
    d.geo(g, [0, 0, z0], col, { rough: 0.95 });
  };
  blanket(0.02, cz - 0.22, 0.6, "#1e7a8a");
  blanket(0.026, cz - 0.12, 0.035, "#ff5aa8");
  blanket(0.026, cz + 0.24, 0.035, "#ff5aa8");
  rbox(d, [0.3, 0.05, 0.34], [-0.62, 0.455, cz - 0.08], "#1e7a8a", { r: 0.02, axis: "y", bevel: 0.015, rough: 0.95, rot: [0, 0.2, 0] });
  // a controller left on the seat, a remote on the arm
  d.at([0.25, 0.432, cz - 0.15], [0, 2.6, 0.04], () => padModern(d, "#1a1a20", C.magenta));
  d.at([1.0, 0.606, cz + 0.05], [0, 0.1, 0], () => remote(d));
  await tick();
  // side tables
  d.at([-1.38, 0, cz + 0.1], null, () => {
    tulipTable(d, "#e8e4dc", "#e8e4dc");
    d.at([0.02, 0.505, -0.02], null, () => tableLamp(d, "#5a2a7a"));
    d.at([-0.12, 0.505, 0.12], [0, 1.0, 0], () => mug(d, "#4fd8ff"));
    d.at([0.12, 0.505, 0.12], [0, PI + 0.4, 0], () => magazine(d, T.magCovers[2 % T.magCovers.length]));
  });
  d.at([1.38, 0, cz + 0.1], null, () => {
    tulipTable(d, "#e8e4dc", "#e8e4dc");
    d.at([-0.06, 0.505, -0.06], null, () => snackBowl(d, "#ff3d9a"));
    d.at([0.12, 0.505, -0.08], [0, PI - 0.3, 0], () => sodaCan(d, T.cans[2]));
    d.at([0.07, 0.505, 0.11], [0, -0.5, 0], () => handheldFlat(d, T.screen));
    // charging cable: over the table edge, down the pedestal, along the floor to a power strip
    cable(d, [[0.19, 0.513, 0.15], [0.23, 0.5, 0.17], [0.235, 0.4, 0.17], [0.2, 0.15, 0.16], [0.24, 0.01, 0.2], [0.35, 0.006, 0.35], [0.4, 0.006, 0.55]], "#f2f2f2", 0.0022);
    d.at([0.42, 0, 0.62], [0, 0.2, 0], () => {
      rbox(d, [0.06, 0.035, 0.3], [0, 0.0175, 0], "#e8e4dc", { r: 0.01, axis: "y" });
      for (let k = 0; k < 4; k++) d.box([0.02, 0.002, 0.02], [0, 0.036, -0.09 + k * 0.055], "#2a2830");
      d.box([0.02, 0.012, 0.02], [0, 0.04, 0.125], "#ff3030", { glow: 1.2 });
    });
  });
  await tick();
  // floor clutter between the holo-table and the couch
  const fz = (L.tableZ + 0.5 + cz - 0.45) / 2;
  d.at([0.62, 0, fz + 0.02], [0, PI + 0.3, 0], () => pizzaBox(d, T));
  d.at([1.0, 0, fz - 0.06], [0, PI - 0.25, 0], () => closedPizzaBox(d, T));
  d.at([-0.52, 0, fz], [0, PI + 0.4, 0], () => gameCase(d, T.cases[2]));
  d.at([-0.42, 0.014, fz + 0.04], [0, PI - 0.3, 0], () => gameCase(d, T.cases[3]));
  d.at([-0.72, 0, fz - 0.05], [0, 1.2, 0], () => openCase(d, "#4fd8ff"));
  d.at([0.1, 0, fz + 0.06], [0, -0.7, 0], () => padModern(d, "#e8e4f0", C.cyan));
  d.at([0.25, 0, fz - 0.06], [0, 0.6, 0], () => sodaCan(d, T.cans[0], true));
  d.at([-0.95, 0, fz + 0.08], [0, PI + 0.2, 0], () => magazineStack(d, T, 4, 4));
  d.at([-1.05, 0, fz - 0.22], [0, PI - 0.5, 0], () => magazine(d, T.magCovers[1 % T.magCovers.length]));
  // magazine rack by the left side table, turned to the room
  d.at([-1.55, 0, L.couchZ - 0.42], [0, 2.45, 0], () => magazineRack(d, T));
  await tick();
  // bean bags around the holo-table
  d.at([-1.4, 0, L.tableZ - 0.45], [0, 0.6, 0.05], () => {
    beanBag(d, "#b0287a");
    d.at([0.05, 0.47, 0.05], [0.2, 0.8, 0], () => padModern(d, "#2a2a32", C.green));
  });
  d.at([1.45, 0, L.tableZ - 0.35], [0, -0.4, -0.04], () => beanBag(d, "#1f8a9e"));
  d.at([1.25, 0.028, L.tableZ + 0.2], [-PI / 2, 0, PI + 0.5], () => chipBag(d, T.handBag));
}

function pizzaBox(d: DecorBuilder, T: Tex) {
  const S = 0.36, wall = 0.04, t = 0.006, col = "#c9a06a";
  d.box([S, t, S], [0, t / 2, 0], col, { rough: 0.95 });
  d.box([S, wall, t], [0, wall / 2, S / 2 - t / 2], col, { rough: 0.95 });
  d.box([S, wall, t], [0, wall / 2, -S / 2 + t / 2], col, { rough: 0.95 });
  d.box([t, wall, S], [S / 2 - t / 2, wall / 2, 0], col, { rough: 0.95 });
  d.box([t, wall, S], [-S / 2 + t / 2, wall / 2, 0], col, { rough: 0.95 });
  d.plane([S * 0.92, S * 0.92], [0, t + 0.004, 0], "#ffffff", { tex: T.pizza, rot: [-PI / 2, 0, 0], rough: 0.65 });
  pizzaSides(d, T, S, wall);
  d.at([0, wall, -S / 2], [-1.85, 0, 0], () => {
    d.box([S, t, S], [0, 0, S / 2], "#d8b07a", { rough: 0.95 });
    // printed on the outside of the lid, turned so it reads upright with the lid open
    d.plane([S * 0.84, S * 0.84], [0, t / 2 + 0.001, S / 2], "#ffffff", { tex: T.pizzaLid, rot: [-PI / 2, 0, PI], rough: 0.8 });
  });
  // a slice escaped onto a napkin
  d.box([0.16, 0.002, 0.16], [S / 2 + 0.12, 0.001, 0.05], "#f4f1ea", { rot: [0, 0.4, 0], rough: 0.9 });
  const slice = new THREE.Shape();
  slice.moveTo(0, 0);
  slice.lineTo(0.14, -0.035);
  slice.lineTo(0.14, 0.035);
  slice.closePath();
  d.at([S / 2 + 0.06, 0.003, 0.06], [-PI / 2, 0, 0.5], () => {
    slabShape(d, slice, 0.008, [0, 0, 0.004], "#f2c55c", { rough: 0.6, segs: 1 });
    d.cyl(0.011, 0.011, 0.072, [0.14, 0, 0.009], "#c98a45", { seg: 8, rough: 0.8 });
    for (const [px, py] of [[0.05, 0.004], [0.095, -0.012], [0.1, 0.016]]) d.cyl(0.009, 0.009, 0.003, [px, py, 0.009], "#9e2a1e", { rot: [PI / 2, 0, 0], seg: 8 });
  });
}

/** "NAPOLI PIZZERIA" strips round the four sides of a pizza box (S square, `h` tall). */
function pizzaSides(d: DecorBuilder, T: Tex, S: number, h: number) {
  for (let i = 0; i < 4; i++)
    d.at([0, 0, 0], [0, (i * PI) / 2, 0], () => d.plane([S * 0.96, h * 0.82], [0, h / 2, S / 2 + 0.0008], "#ffffff", { tex: T.pizzaSide, rough: 0.85 }));
}

/** A second, closed box (it was a two-pizza night). */
function closedPizzaBox(d: DecorBuilder, T: Tex) {
  const S = 0.36, h = 0.044;
  d.box([S, h, S], [0, h / 2, 0], "#c9a06a", { rough: 0.95 });
  d.plane([S * 0.9, S * 0.9], [0, h + 0.0008, 0], "#ffffff", { tex: T.pizzaLid, rot: [-PI / 2, 0, 0], rough: 0.8 });
  pizzaSides(d, T, S, h);
  // grease spot + a receipt taped on
  d.plane([0.07, 0.1], [0.12, h + 0.0012, 0.11], "#fbfaf4", { rot: [-PI / 2, 0, 0.3], rough: 0.9 });
}

/** Ceiling fan (blades spin) over the holo-table. */
function ceilingFan(d: DecorBuilder, L: DenLayout, ctx: LevelCtx, anim: Tick[], subs: DecorBuilder[]) {
  const y = L.CEIL, x = 0, z = L.tableZ;
  d.lathe([[0, 0], [0.075, 0], [0.07, -0.03], [0.03, -0.05], [0, -0.05]], [x, y, z], "#1c1a22", { seg: 18, metal: 0.6, rough: 0.35 });
  d.cyl(0.012, 0.012, 0.06, [x, y - 0.07, z], "#2a2830", { seg: 8, metal: 0.6 });
  d.lathe([[0, 0.06], [0.07, 0.055], [0.11, 0.02], [0.11, 0], [0.09, -0.02], [0, -0.025]], [x, y - 0.17, z], "#1c1a22", { seg: 22, metal: 0.6, rough: 0.35 });
  d.lathe([[0.09, 0], [0.08, -0.05], [0.05, -0.075], [0, -0.08]], [x, y - 0.19, z], "#ffd9a0", { seg: 20, glow: 0.55, rough: 0.6 });
  const fan = d.sub();
  for (let i = 0; i < 5; i++) {
    fan.at([0, 0, 0], [0, (i / 5) * PI * 2, 0], () => {
      fan.box([0.11, 0.012, 0.03], [0.14, 0.006, 0], "#2a2830", { metal: 0.6, rough: 0.35 });
      rbox(fan, [0.5, 0.008, 0.125], [0.42, 0.0, 0], "#3a2418", { r: 0.04, axis: "y", rough: 0.5, rot: [0.14, 0, 0] });
    });
  }
  fan.cyl(0.115, 0.115, 0.03, [0, 0.01, 0], "#2a2830", { seg: 22, metal: 0.6, rough: 0.35 });
  const m = fan.build("den-fan");
  m.position.set(x, y - 0.205, z);
  ctx.scene.add(m);
  subs.push(fan);
  anim.push((dt) => (m.rotation.y += dt * 1.5));
}

// ---------------------------------------------------------------------------------------------

/**
 * Dress the den. `pause` is awaited between zones so a background build never blocks a frame for
 * long (pass the level's `progress`).
 */
export async function decorateDen(ctx: LevelCtx, L: DenLayout, pause: () => Promise<void> = async () => {}) {
  if (NO.has("decor")) return null; // ablation: ?no=decor
  const t0 = performance.now();
  let work = 0, slice = t0, longest = 0, slices = 0;
  const endSlice = () => {
    const dt = performance.now() - slice;
    work += dt;
    longest = Math.max(longest, dt);
    slices++;
  };
  tick = async () => {
    if (performance.now() - slice < 10) return;
    endSlice();
    await pause();
    slice = performance.now();
  };
  seed = 1;
  // don't hold the room up for long on a slow connection: stand-ins if the art isn't here in 4 s
  const art = await Promise.race([denArtOnce(), new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
  slice = performance.now(); // (waiting for the download isn't work)
  // the drawn stand-ins fit a 1024² atlas; real covers + perler patterns need the full 2048²
  const d = new DecorBuilder({ atlasSize: art ? 2048 : 1024 });
  const anim: Tick[] = [];
  const subs: DecorBuilder[] = [];
  const T = await paint(d, ctx, art);
  await tvNook(d, L, T, ctx, anim, subs);
  await backWall(d, L, T, ctx, anim, subs);
  await battlestation(d, L, T);
  await shoeNook(d, L, T);
  await tick();
  await cartBench(d, L, T);
  await tick();
  await rightSide(d, L, T);
  await frontWall(d, L, T);
  await centre(d, L, T);
  await tick();
  ceilingFan(d, L, ctx, anim, subs);
  await tick();
  const tris = d.triangles + subs.reduce((a, s) => a + s.triangles, 0);
  const mesh = d.build("den-decor");
  ctx.scene.add(mesh);
  ctx.onUpdate((dt, t) => {
    for (const f of anim) f(dt, t);
  });
  endSlice();
  tick = async () => {};
  console.info(`[den] decor: ${Math.round(tris / 1000)}k triangles, ${subs.length} moving parts; ${Math.round(work)}ms of work in ${slices} slices (longest ${Math.round(longest)}ms) over ${Math.round(performance.now() - t0)}ms`);
  return { mesh, triangles: tris };
}
