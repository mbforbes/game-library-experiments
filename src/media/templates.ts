// Physical form factors: real-world dimensions (metres), where the art goes, how shiny it is.
// Local frame: origin at bottom-centre, +Y up, cover faces +Z, spine faces -X.
// Shelving a case spine-out = rotateY(+90°).

import type { MediaKind } from "../../shared/platforms";
import { GeoBuilder, PART, roundedRect } from "./geometry";
import type * as THREE from "three/webgpu";

export interface Template {
  kind: MediaKind;
  size: [number, number, number]; // w, h, d
  /** aspect (w/h) of the printed cover/label region, used to crop atlas art */
  labelAspect: number;
  /** vertical anchor for cropping tall art into a wide label (0 = keep top, 0.5 = centre) */
  cropY: number;
  /** spine face size (w = depth, h = height) or null when the item has no printed spine */
  spine: [number, number] | null;
  shellRoughness: number;
  /** spine is an emissive LED strip (digital slabs) */
  spineGlow: number;
  /** objects of this kind usually stand face-out on displays (carts) rather than spine-out */
  faceOut: boolean;
  build(): THREE.BufferGeometry;
  /** carts only: shell + a full-front quad that carries a real cartridge photo (alpha cut-out) */
  buildPhoto?(): THREE.BufferGeometry;
}

type TData = Omit<Template, "build" | "buildPhoto">;
const T = (t: TData, build: (t: TData) => GeoBuilder, photo?: (t: TData) => GeoBuilder): Template => ({
  ...t,
  build: () => build(t).build(),
  buildPhoto: photo ? () => photo(t).build() : undefined,
});

const OUTLINES = new Map<MediaKind, [number, number][]>();

/** Cartridge for photo mode: the shell, with the photo laid over the whole front (slightly oversized). */
function cartPhotoGeo(t: TData, outline: [number, number][]) {
  const [w, h, d] = t.size;
  const g = new GeoBuilder();
  g.extrude(outline, -d / 2, d / 2, PART.shell, PART.back);
  const zf = d / 2 + 0.0006;
  const ox = w * 0.015, oy = h * 0.015;
  g.quad([-w / 2 - ox, -oy, zf], [w / 2 + ox, -oy, zf], [w / 2 + ox, h + oy, zf], [-w / 2 - ox, h + oy, zf], PART.cover);
  return g;
}

/** Keep case / clamshell: chamfered shell, cover inset under the sleeve, printed spine. */
function caseGeo(t: TData, opts: { coverInset?: number; chamfer?: number; backPart?: number } = {}) {
  const [w, h, d] = t.size;
  const g = new GeoBuilder();
  const c = opts.chamfer ?? 0.0018;
  g.box(0, h / 2, 0, w, h, d, [PART.shell, null, PART.shell, PART.shell, null, opts.backPart ?? PART.back], c);
  const i = opts.coverInset ?? 0.0012;
  const zf = d / 2 + 0.0002;
  // front cover (under the clear sleeve)
  g.quad([-w / 2 + c, c + i * 0.5, zf], [w / 2 - c - i, c + i * 0.5, zf], [w / 2 - c - i, h - c - i * 0.5, zf], [-w / 2 + c, h - c - i * 0.5, zf], PART.cover);
  // spine on -X
  const xs = -w / 2 - 0.0002;
  g.quad([xs, c, -d / 2 + c], [xs, c, d / 2 - c], [xs, h - c, d / 2 - c], [xs, h - c, -d / 2 + c], PART.spine);
  return g;
}

/** CD jewel case: dark tray at the back, clear lid with the cover booklet, printed spine insert. */
function jewelGeo(t: TData) {
  const [w, h, d] = t.size;
  const g = new GeoBuilder();
  g.box(0, h / 2, 0, w, h, d, [PART.shell, null, PART.shell, PART.shell, null, PART.back], 0.0008);
  const zf = d / 2 + 0.0002;
  const hinge = 0.007; // the lid's hinge strip on the left
  g.quad([-w / 2 + hinge, 0.002, zf], [w / 2 - 0.002, 0.002, zf], [w / 2 - 0.002, h - 0.002, zf], [-w / 2 + hinge, h - 0.002, zf], PART.cover);
  g.quad([-w / 2 + 0.0008, 0.0008, zf], [-w / 2 + hinge, 0.0008, zf], [-w / 2 + hinge, h - 0.0008, zf], [-w / 2 + 0.0008, h - 0.0008, zf], PART.dark);
  const xs = -w / 2 - 0.0002;
  g.quad([xs, 0.001, -d / 2 + 0.001], [xs, 0.001, d / 2 - 0.001], [xs, h - 0.001, d / 2 - 0.001], [xs, h - 0.001, -d / 2 + 0.001], PART.spine);
  return g;
}

/** Cardboard big box (90s PC): sharp edges, cover front, the spine printed on both sides, art-coloured top. */
function bigboxGeo(t: TData) {
  const [w, h, d] = t.size;
  const g = new GeoBuilder();
  g.box(0, h / 2, 0, w, h, d, [PART.spine, null, PART.shell, PART.shell, null, PART.back], 0.0008);
  const zf = d / 2 + 0.0001;
  g.quad([-w / 2, 0, zf], [w / 2, 0, zf], [w / 2, h, zf], [-w / 2, h, zf], PART.cover);
  const xs = -w / 2 - 0.0001;
  g.quad([xs, 0, -d / 2], [xs, 0, d / 2], [xs, h, d / 2], [xs, h, -d / 2], PART.spine);
  return g;
}

/** Digital game "glass slab": dark glass with the art inside and glowing edges. */
function slabGeo(t: TData) {
  const [w, h, d] = t.size;
  const g = new GeoBuilder();
  const e = 0.0016; // glow edge thickness on the front
  g.box(0, h / 2, 0, w, h, d, [PART.glow, null, PART.glow, PART.glow, null, PART.back], 0.001, PART.glow);
  const zf = d / 2 + 0.0002;
  g.quad([-w / 2 + e, e, zf], [w / 2 - e, e, zf], [w / 2 - e, h - e, zf], [-w / 2 + e, h - e, zf], PART.cover);
  const xs = -w / 2 - 0.0002;
  g.quad([xs, 0.001, -d / 2 + 0.001], [xs, 0.001, d / 2 - 0.001], [xs, h - 0.001, d / 2 - 0.001], [xs, h - 0.001, -d / 2 + 0.001], PART.spine);
  return g;
}

/** Cartridge: extruded outline + recessed label + optional grip ridges. */
function cartGeo(
  t: TData,
  outline: [number, number][],
  label: [number, number, number, number], // x0, y0, x1, y1
  ridges: { y0: number; y1: number; n: number; x0: number; x1: number } | null,
) {
  const [, , d] = t.size;
  OUTLINES.set(t.kind, outline);
  const g = new GeoBuilder();
  g.extrude(outline, -d / 2, d / 2, PART.shell, PART.back);
  const zf = d / 2 + 0.0003;
  const [x0, y0, x1, y1] = label;
  g.quad([x0, y0, zf], [x1, y0, zf], [x1, y1, zf], [x0, y1, zf], PART.cover);
  if (ridges) {
    const step = (ridges.y1 - ridges.y0) / ridges.n;
    for (let i = 0; i < ridges.n; i++) {
      const y = ridges.y0 + step * (i + 0.5);
      g.box((ridges.x0 + ridges.x1) / 2, y, d / 2 + 0.0004, ridges.x1 - ridges.x0, step * 0.45, 0.0012, [PART.shell, PART.shell, PART.shell, PART.shell, PART.shell, null], 0);
    }
  }
  return g;
}

/** Mini arcade cabinet (side profile extruded across X); screen shows the flyer art. */
function cabinetGeo(t: TData) {
  const [w, h, d] = t.size;
  const g = new GeoBuilder();
  // side profile in (z, y): front at +z
  const prof: [number, number][] = [
    [-d / 2, 0],
    [d / 2, 0],
    [d / 2, h * 0.42],
    [d / 2 - d * 0.18, h * 0.5], // control panel slope
    [d / 2 - d * 0.22, h * 0.78], // screen
    [d / 2 - d * 0.05, h * 0.84],
    [d / 2 - d * 0.05, h],
    [-d / 2, h],
  ];
  // build side panels at ±x and the faces between profile points
  const side = (x: number, flip: boolean) => {
    const shape = prof.map(([z, y]) => [z, y] as [number, number]);
    const pts = shape;
    // fan triangulation is fine for this convex-ish polygon
    for (let i = 1; i < pts.length - 1; i++) {
      const A: [number, number, number] = [x, pts[0][1], pts[0][0]];
      const B: [number, number, number] = [x, pts[i][1], pts[i][0]];
      const C: [number, number, number] = [x, pts[i + 1][1], pts[i + 1][0]];
      if (flip) g.tri(A, B, C, PART.shell);
      else g.tri(A, C, B, PART.shell);
    }
  };
  side(w / 2, false);
  side(-w / 2, true);
  const x0 = -w / 2 + 0.004, x1 = w / 2 - 0.004;
  for (let i = 0; i < prof.length; i++) {
    const [za, ya] = prof[i], [zb, yb] = prof[(i + 1) % prof.length];
    const part = i === 3 ? PART.cover : i === 5 ? PART.spine : i === 2 ? PART.dark : PART.back;
    const xa = part === PART.back ? -w / 2 : x0, xb = part === PART.back ? w / 2 : x1;
    g.quad([xa, ya, za], [xb, ya, za], [xb, yb, zb], [xa, yb, zb], part);
  }
  return g;
}

export const TEMPLATES: Record<MediaKind, Template> = {
  dvd: T({ kind: "dvd", size: [0.135, 0.19, 0.014], labelAspect: 0.71, cropY: 0.5, spine: [0.014, 0.19], shellRoughness: 0.32, spineGlow: 0, faceOut: false }, (t) => caseGeo(t)),
  "gc-case": T({ kind: "gc-case", size: [0.135, 0.19, 0.014], labelAspect: 0.71, cropY: 0.5, spine: [0.014, 0.19], shellRoughness: 0.32, spineGlow: 0, faceOut: false }, (t) => caseGeo(t)),
  bluray: T({ kind: "bluray", size: [0.135, 0.17, 0.013], labelAspect: 0.79, cropY: 0.5, spine: [0.013, 0.17], shellRoughness: 0.3, spineGlow: 0, faceOut: false }, (t) => caseGeo(t)),
  "switch-case": T({ kind: "switch-case", size: [0.105, 0.17, 0.011], labelAspect: 0.62, cropY: 0.5, spine: [0.011, 0.17], shellRoughness: 0.3, spineGlow: 0, faceOut: false }, (t) => caseGeo(t)),
  "ds-case": T({ kind: "ds-case", size: [0.125, 0.137, 0.014], labelAspect: 0.9, cropY: 0.5, spine: [0.014, 0.137], shellRoughness: 0.3, spineGlow: 0, faceOut: false }, (t) => caseGeo(t)),
  "genesis-case": T({ kind: "genesis-case", size: [0.134, 0.185, 0.024], labelAspect: 0.72, cropY: 0.5, spine: [0.024, 0.185], shellRoughness: 0.38, spineGlow: 0, faceOut: false }, (t) => caseGeo(t, { chamfer: 0.0025 })),
  jewel: T({ kind: "jewel", size: [0.142, 0.125, 0.0104], labelAspect: 1.07, cropY: 0.5, spine: [0.0104, 0.125], shellRoughness: 0.15, spineGlow: 0, faceOut: false }, jewelGeo),
  bigbox: T({ kind: "bigbox", size: [0.19, 0.235, 0.05], labelAspect: 0.81, cropY: 0.5, spine: [0.05, 0.235], shellRoughness: 0.75, spineGlow: 0, faceOut: false }, bigboxGeo),
  slab: T({ kind: "slab", size: [0.12, 0.18, 0.012], labelAspect: 0.66, cropY: 0.5, spine: [0.012, 0.18], shellRoughness: 0.06, spineGlow: 0, faceOut: false }, slabGeo),
  "nes-cart": T({ kind: "nes-cart", size: [0.12, 0.133, 0.018], labelAspect: 1.25, cropY: 0.3, spine: null, shellRoughness: 0.55, spineGlow: 0, faceOut: true }, (t) =>
    cartGeo(t, roundedRect(-0.06, 0, 0.06, 0.133, [0.002, 0.002, 0.003, 0.003]), [-0.05, 0.048, 0.05, 0.128], { y0: 0.006, y1: 0.04, n: 6, x0: -0.045, x1: 0.045 }),
  ),
  "snes-cart": T({ kind: "snes-cart", size: [0.136, 0.106, 0.02], labelAspect: 1.6, cropY: 0.4, spine: null, shellRoughness: 0.5, spineGlow: 0, faceOut: true }, (t) =>
    cartGeo(
      t,
      [
        [-0.068, 0],
        [0.068, 0],
        [0.068, 0.06],
        [0.064, 0.066],
        [0.064, 0.082],
        [0.068, 0.088],
        ...roundedRect(-0.068, 0, 0.068, 0.106, [0, 0, 0.014, 0.014]).filter(([, y]) => y > 0.0921).map((p) => p as [number, number]),
        [-0.068, 0.088],
        [-0.064, 0.082],
        [-0.064, 0.066],
        [-0.068, 0.06],
      ],
      [-0.052, 0.038, 0.052, 0.1],
      { y0: 0.006, y1: 0.03, n: 4, x0: -0.05, x1: 0.05 },
    ),
  ),
  "n64-cart": T({ kind: "n64-cart", size: [0.116, 0.075, 0.019], labelAspect: 1.4, cropY: 0.45, spine: null, shellRoughness: 0.5, spineGlow: 0, faceOut: true }, (t) =>
    cartGeo(
      t,
      [
        [-0.058, 0],
        [0.058, 0],
        [0.058, 0.05],
        [0.046, 0.075],
        [-0.046, 0.075],
        [-0.058, 0.05],
      ],
      [-0.037, 0.016, 0.037, 0.069],
      { y0: 0.004, y1: 0.014, n: 2, x0: -0.04, x1: 0.04 },
    ),
  ),
  "gb-cart": T({ kind: "gb-cart", size: [0.057, 0.065, 0.008], labelAspect: 1.15, cropY: 0.35, spine: null, shellRoughness: 0.55, spineGlow: 0, faceOut: true }, (t) =>
    cartGeo(
      t,
      [
        [-0.0285, 0],
        [0.0285, 0],
        [0.0285, 0.057],
        [0.0205, 0.065],
        [-0.0285, 0.065],
      ],
      [-0.023, 0.006, 0.023, 0.046],
      { y0: 0.051, y1: 0.062, n: 3, x0: -0.024, x1: 0.015 },
    ),
  ),
  "gba-cart": T({ kind: "gba-cart", size: [0.057, 0.035, 0.008], labelAspect: 1.35, cropY: 0.4, spine: null, shellRoughness: 0.5, spineGlow: 0, faceOut: true }, (t) =>
    cartGeo(t, roundedRect(-0.0285, 0, 0.0285, 0.035, [0.001, 0.001, 0.006, 0.006]), [-0.0225, 0.004, 0.0225, 0.0315], null),
  ),
  "gg-cart": T({ kind: "gg-cart", size: [0.068, 0.054, 0.009], labelAspect: 1.2, cropY: 0.4, spine: null, shellRoughness: 0.5, spineGlow: 0, faceOut: true }, (t) =>
    cartGeo(t, roundedRect(-0.034, 0, 0.034, 0.054, [0.001, 0.001, 0.004, 0.004]), [-0.027, 0.005, 0.027, 0.048], null),
  ),
  "msx-cart": T({ kind: "msx-cart", size: [0.098, 0.062, 0.016], labelAspect: 1.55, cropY: 0.4, spine: null, shellRoughness: 0.5, spineGlow: 0, faceOut: true }, (t) =>
    cartGeo(t, roundedRect(-0.049, 0, 0.049, 0.062, [0.002, 0.002, 0.002, 0.002]), [-0.04, 0.008, 0.04, 0.056], null),
  ),
  hucard: T({ kind: "hucard", size: [0.085, 0.054, 0.0025], labelAspect: 1.4, cropY: 0.4, spine: null, shellRoughness: 0.35, spineGlow: 0, faceOut: true }, (t) =>
    cartGeo(t, roundedRect(-0.0425, 0, 0.0425, 0.054, [0.003, 0.003, 0.003, 0.003]), [-0.037, 0.004, 0.037, 0.05], null),
  ),
  cabinet: T({ kind: "cabinet", size: [0.11, 0.24, 0.13], labelAspect: 0.85, cropY: 0.3, spine: [0.102, 0.038], shellRoughness: 0.45, spineGlow: 2.2, faceOut: true }, cabinetGeo),
};

// carts + HuCards can carry a real cartridge photo over their whole front
for (const t of Object.values(TEMPLATES)) {
  if (!t.kind.endsWith("-cart") && t.kind !== "hucard") continue;
  t.buildPhoto = () => {
    if (!OUTLINES.has(t.kind)) t.build();
    return cartPhotoGeo(t, OUTLINES.get(t.kind)!).build();
  };
}

const geoCache = new Map<string, THREE.BufferGeometry>();
export function geometryFor(kind: MediaKind, photo = false): THREE.BufferGeometry {
  const key = photo ? kind + "+photo" : kind;
  let g = geoCache.get(key);
  if (!g) {
    const t = TEMPLATES[kind];
    g = photo && t.buildPhoto ? t.buildPhoto() : t.build();
    geoCache.set(key, g);
  }
  return g;
}

/** Front-face rect used for cartridge photos: [x0, y0, x1, y1, z] (matches cartPhotoGeo). */
export function photoRect(kind: MediaKind): [number, number, number, number, number] {
  const [w, h, d] = TEMPLATES[kind].size;
  const ox = w * 0.015, oy = h * 0.015;
  return [-w / 2 - ox, -oy, w / 2 + ox, h + oy, d / 2 + 0.0009];
}

/**
 * Where the printed cover/label sits on each template (local coords): [x0, y0, x1, y1, z].
 * Used to lay hi-res cover overlays exactly over the instanced label when the camera is close.
 */
export function coverRect(kind: MediaKind): [number, number, number, number, number] | null {
  const [w, h, d] = TEMPLATES[kind].size;
  const labels: Partial<Record<MediaKind, [number, number, number, number]>> = {
    "nes-cart": [-0.05, 0.048, 0.05, 0.128],
    "snes-cart": [-0.052, 0.038, 0.052, 0.1],
    "n64-cart": [-0.037, 0.016, 0.037, 0.069],
    "gb-cart": [-0.023, 0.006, 0.023, 0.046],
    "gba-cart": [-0.0225, 0.004, 0.0225, 0.0315],
    "gg-cart": [-0.027, 0.005, 0.027, 0.048],
    "msx-cart": [-0.04, 0.008, 0.04, 0.056],
    hucard: [-0.037, 0.004, 0.037, 0.05],
  };
  const lab = labels[kind];
  if (lab) return [...lab, d / 2 + 0.0006];
  switch (kind) {
    case "cabinet":
      return null;
    case "jewel":
      return [-w / 2 + 0.007, 0.002, w / 2 - 0.002, h - 0.002, d / 2 + 0.0005];
    case "bigbox":
      return [-w / 2, 0, w / 2, h, d / 2 + 0.0004];
    case "slab":
      return [-w / 2 + 0.0016, 0.0016, w / 2 - 0.0016, h - 0.0016, d / 2 + 0.0005];
    default: {
      const c = kind === "genesis-case" ? 0.0025 : 0.0018, i = 0.0012;
      return [-w / 2 + c, c + i / 2, w / 2 - c - i, h - c - i / 2, d / 2 + 0.0005];
    }
  }
}
