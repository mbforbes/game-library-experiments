// Decor for THE INFINITE STACKS: everything that turns "shelves in a stone tube" into a wizard's
// library (Arcane University, Hogwarts, a monastery scriptorium).
//
// All static props go into ONE DecorBuilder (one mesh, one material, one canvas atlas); only the
// great chandelier, the gallery globe and the armillary sphere are separate (moving) sub-meshes.
//
// Where things go. The camera rides a helix between the axis and the shelf fronts, so the annulus
// r ∈ [0.8, 2.6] must stay clear at every height the rail reaches, and the axis belongs to the
// Codex. That leaves:
//   • the top of every bookcase (the 0.42 m strip between turns of the helix): little vignettes of
//     books, candles, skulls, potions, globes, scrolls, a cat… flanking the brass year plaques, a
//     carved arch on the wall behind, sconces and pinnacles where two bays meet
//   • under every band: a carved stone cornice running the whole helix (the edge of the "stair")
//   • the dusty bays below 1971: cobwebs, a rolling ladder, old maps; the ghostly bays above
//     today: crystal balls, star charts, armillaries, little rose windows
//   • the base: a rune circle and fountain, a blind arcade with a great door, tapestries, lecterns
//   • the top: a gallery with furniture and a balustrade, stained-glass lancets, banners, ivy, a
//     painted starry vault, an oculus with a bell, and a great swaying chandelier

import * as THREE from "three/webgpu";
import { DecorBuilder, rand, type Vec3, type UVRect, type PropOpts } from "../../world/kit/decorkit";
import type { LevelCtx } from "../types";
import { NO } from "../../engine/flags";

export interface StacksDecorLayout {
  /** radius of the shelf fronts */
  R: number;
  /** shelf depth (the wall is at R + DEPTH + 0.02) */
  DEPTH: number;
  /** height of one band of shelves */
  BAND: number;
  /** rise of the helix per full turn */
  PITCH: number;
  /** the library bays (centre angle, width, bottom y) */
  bays: { theta: number; width: number; y: number }[];
  /** angle range of all shelving (decorative bays included) and where the library ends */
  a0: number;
  a1: number;
  libEnd: number;
}

type D = DecorBuilder;
type P2 = [number, number];
type Rnd = () => number;
type Region = "dusty" | "lib" | "ghost";

const TAU = Math.PI * 2;

// ---- palette: warm candlelit wood, brass and wax against cold stone and moonlit blues ----------
const C = {
  stone: "#6f675b",
  stoneLight: "#8a8172",
  stoneDark: "#4a443c",
  wood: "#4a2c18",
  woodDark: "#2a170b",
  oak: "#6b4526",
  iron: "#2c2927",
  brass: "#c49a4c",
  gold: "#d8ab4e",
  bronze: "#7c5a2c",
  wax: "#efe2c2",
  waxOld: "#c9b994",
  flame: "#ffb24c",
  parchment: "#dcc89c",
  pageEdge: "#e2d4ae",
  bone: "#d8ccae",
  cork: "#9c7650",
  sand: "#d6b46a",
  glass: "#8fa9b2",
  marble: "#d9d4ca",
  water: "#1d3b48",
};
const LEATHER = ["#5c2118", "#2d4024", "#233251", "#5d4619", "#452148", "#6b3518", "#3b2a1e", "#20403e", "#6e2a2a"];
const GLASS = ["#2f8a44", "#a3243a", "#2a52a8", "#c48a1e", "#6a36a8", "#1f8a8a"];
const MET: PropOpts = { metal: 0.45, rough: 0.4 };
const IRN: PropOpts = { metal: 0.45, rough: 0.5 };
const STN: PropOpts = { rough: 0.92 };

const sc = (p: P2[], s: number, sy = s): P2[] => p.map(([r, y]) => [r * s, y * sy]);
/** duplicate interior profile points so a lathe gets crisp (unsmoothed) edges there */
const crisp = (p: P2[]): P2[] => p.flatMap((q, i) => (i > 0 && i < p.length - 1 ? [q, [q[0], q[1]] as P2] : [q]));
const pick = <T>(r: Rnd, a: T[]) => a[Math.floor(r() * a.length) % a.length];
const cyc = <T>(a: T[], i: number) => a[((Math.floor(i) % a.length) + a.length) % a.length];

// ---- lathe profiles (unit height unless noted) -------------------------------------------------
const FLAME_P: P2[] = [[0, 0], [0.0055, 0.006], [0.0042, 0.015], [0.0016, 0.023], [0, 0.028]];
const STICK_P: P2[] = [[0, 0], [0.3, 0], [0.28, 0.06], [0.09, 0.18], [0.06, 0.5], [0.11, 0.55], [0.06, 0.6], [0.06, 0.86], [0.26, 0.9], [0.1, 0.97], [0, 0.97]];
const CUP_P: P2[] = [[0, 0], [0.008, 0], [0.022, 0.01], [0.02, 0.015], [0.011, 0.013], [0, 0.013]];
const PAN_P: P2[] = [[0, -0.004], [0.034, 0.004], [0.036, 0.01], [0.012, 0.006], [0.012, 0.014], [0, 0.014]];
const PIN_P: P2[] = [[0.026, 0], [0.02, 0.016], [0.02, 0.05], [0.016, 0.07], [0, 0.135]];
const BOTTLES: P2[][] = [
  [[0, 0], [0.018, 0.001], [0.03, 0.014], [0.032, 0.03], [0.024, 0.048], [0.009, 0.058], [0.008, 0.085], [0.011, 0.088], [0, 0.089]], // round flask
  [[0, 0], [0.02, 0], [0.021, 0.006], [0.021, 0.075], [0.014, 0.088], [0.007, 0.094], [0.007, 0.118], [0.009, 0.12], [0, 0.12]], // tall bottle
  [[0, 0], [0.026, 0], [0.03, 0.008], [0.03, 0.042], [0.024, 0.05], [0.024, 0.056], [0, 0.056]], // squat jar
  [[0, 0], [0.034, 0], [0.034, 0.006], [0.012, 0.06], [0.009, 0.08], [0.011, 0.083], [0, 0.083]], // conical flask
  [[0, 0], [0.016, 0.002], [0.024, 0.016], [0.02, 0.034], [0.013, 0.042], [0.019, 0.056], [0.015, 0.07], [0.006, 0.078], [0.006, 0.096], [0, 0.096]], // gourd
];

/**
 * Builds the decor in slices; `progress` (the level's build progress) is awaited between them so a
 * background build of this world never holds the main thread for long.
 */
export async function decorateStacks(c: LevelCtx, L: StacksDecorLayout, progress?: (msg: string) => Promise<void>) {
  if (NO.has("decor")) return null; // ablation: ?no=decor
  const t0 = performance.now();
  const { R, DEPTH, BAND, PITCH } = L;
  const RW = R + DEPTH + 0.02; // the tower wall
  const thetaY = (a: number) => (a / TAU) * PITCH;
  const yFloor = thetaY(L.a0) - 1.5;
  const yCeil = thetaY(L.a1) + 6;
  const TOP = 0.865; // bookcase top board, above a bay's bottom
  const yG = thetaY(L.a1) + BAND + 0.25; // the gallery floor at the top of the tower
  const under = yG - 0.24; // nothing along the helix may rise above this (the gallery's underside)
  const d = new DecorBuilder();
  const tally: string[] = [];
  let lastTris = 0;
  const mark = (k: string) => {
    tally.push(`${k} ${((d.triangles - lastTris) / 1000).toFixed(1)}k`);
    lastTris = d.triangles;
  };
  let busy = 0, worst = 0, tSlice = performance.now();
  const pause = async (msg: string) => {
    const dt = performance.now() - tSlice;
    busy += dt;
    worst = Math.max(worst, dt);
    if (progress) await progress(msg);
    tSlice = performance.now();
  };
  let seed = 7;
  const rnd: Rnd = () => rand(seed++);

  // ---- local frames ----------------------------------------------------------------------------
  /** props relative to a point on a circle of radius r: x along the wall (towards +theta), y up, z towards the axis */
  const at = (b: D, theta: number, y: number, r: number, fn: () => void, extraRotY = 0) =>
    b.at([Math.cos(theta) * r, y, Math.sin(theta) * r], [0, Math.atan2(-Math.cos(theta), -Math.sin(theta)) + extraRotY, 0], fn);

  /** bend a geometry authored flat against the wall (x along, y up, z out of the wall) around the tower */
  const bend = (g: THREE.BufferGeometry, theta: number, y: number, rWall = RW) => {
    const P = g.getAttribute("position") as THREE.BufferAttribute;
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    const N = g.getAttribute("normal") as THREE.BufferAttribute;
    for (let i = 0; i < P.count; i++) {
      const th = theta + P.getX(i) / rWall, r = rWall - P.getZ(i);
      const co = Math.cos(th), si = Math.sin(th);
      P.setXYZ(i, co * r, y + P.getY(i), si * r);
      const nx = N.getX(i), ny = N.getY(i), nz = N.getZ(i);
      N.setXYZ(i, -si * nx - co * nz, ny, co * nx - si * nz);
    }
    return g;
  };

  // ---- atlas art -------------------------------------------------------------------------------
  const T = drawArt(d);
  await pause("Weaving tapestries…");

  // ---- small helpers ---------------------------------------------------------------------------
  /** a thin tube with few sides (vines, wires, arms) */
  const tube = (b: D, pts: Vec3[], r: number, col: string, seg: number, o: PropOpts = {}, sides = 4) =>
    b.geo(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), seg, r, sides, false), [0, 0, 0], col, o);
  const ring = (b: D, Rr: number, r: number, pos: Vec3, col: string, o: PropOpts, rot: Vec3 = [0, 0, 0], arc = TAU, tub = 12) =>
    b.geo(new THREE.TorusGeometry(Rr, r, 4, tub, arc), pos, col, { ...o, rot });
  const flame = (b: D, x: number, y: number, z: number, s = 1) => b.lathe(sc(FLAME_P, s), [x, y, z], C.flame, { seg: 5, glow: 2.0, rough: 1 });
  const candle = (b: D, x: number, y: number, z: number, h: number, r = 0.012, lit = true, wax = C.wax) => {
    b.cyl(r * 0.94, r, h, [x, y + h / 2, z], wax, { seg: 6, rough: 0.5 });
    if (lit) flame(b, x, y + h + 0.002, z, Math.min(1.3, Math.max(0.75, r / 0.012)));
    else b.cyl(0.0015, 0.0015, 0.01, [x, y + h + 0.004, z], "#1a120c", { seg: 3 });
  };
  const candlestick = (b: D, x: number, y: number, z: number, h = 0.1, cH = 0.08, lit = true, col = C.brass) => {
    b.lathe(sc(STICK_P, h), [x, y, z], col, { seg: 7, ...MET });
    candle(b, x, y + h * 0.97, z, cH, 0.011, lit);
  };
  const candelabra = (b: D, x: number, y: number, z: number, h = 0.2, lit = true) => {
    b.lathe(sc(STICK_P, h), [x, y, z], C.brass, { seg: 7, ...MET });
    candle(b, x, y + h * 0.97, z, 0.09, 0.011, lit);
    for (const s of [-1, 1]) {
      tube(b, [[x, y + h * 0.52, z], [x + s * 0.05, y + h * 0.52, z], [x + s * 0.078, y + h * 0.64, z], [x + s * 0.078, y + h * 0.76, z]], 0.0045, C.brass, 7, MET);
      b.lathe(CUP_P, [x + s * 0.078, y + h * 0.76, z], C.brass, { seg: 6, ...MET });
      candle(b, x + s * 0.078, y + h * 0.76 + 0.012, z, 0.07, 0.0105, lit);
    }
  };
  const leather = (r: Rnd, dusty = false) => {
    const col = new THREE.Color(pick(r, LEATHER));
    if (dusty) col.lerp(new THREE.Color("#6a6258"), 0.35);
    return "#" + col.getHexString();
  };

  // ---- books -----------------------------------------------------------------------------------
  const lyingBook = (b: D, x: number, y: number, z: number, w: number, t: number, dp: number, rotY: number, col: string) =>
    b.at([x, y, z], [0, rotY, 0], () => {
      b.box([w, 0.004, dp], [0, t - 0.002, 0], col, { rough: 0.7 });
      b.box([0.007, t, dp], [-w / 2 + 0.0035, t / 2, 0], col, { rough: 0.7 });
      b.box([w - 0.012, t - 0.004, dp - 0.008], [0.002, (t - 0.004) / 2, 0], C.pageEdge, { rough: 0.9 });
    });
  const uprightBook = (b: D, x: number, y: number, z: number, w: number, h: number, dp: number, col: string, lean = 0) =>
    b.at([x, y, z], [0, 0, lean], () => {
      b.box([w, h, dp], [0, h / 2, 0], col, { rough: 0.7 });
      b.box([w + 0.002, 0.006, 0.004], [0, h * 0.18, dp / 2], C.gold, MET);
      b.box([w + 0.002, 0.006, 0.004], [0, h * 0.82, dp / 2], C.gold, MET);
    });
  /** a pile of lying books; returns its height */
  const bookPile = (b: D, r: Rnd, n: number, dusty = false) => {
    let y = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.13 + r() * 0.07 - i * 0.008, dp = 0.1 + r() * 0.045 - i * 0.006, t = 0.02 + r() * 0.018;
      lyingBook(b, (r() - 0.5) * 0.02, y, (r() - 0.5) * 0.02, w, t, dp, (r() - 0.5) * 0.6, leather(r, dusty));
      y += t;
    }
    return y;
  };
  const bookRow = (b: D, r: Rnd, n: number, dusty = false) => {
    // bookend
    b.box([0.012, 0.1, 0.07], [-0.006, 0.05, 0], C.bronze, MET);
    b.box([0.05, 0.006, 0.07], [0.02, 0.003, 0], C.bronze, MET);
    let x = 0.001, hPrev = 0.1;
    for (let i = 0; i < n; i++) {
      const w = 0.02 + r() * 0.02, h = 0.14 + r() * 0.08, dp = 0.1 + r() * 0.03;
      if (i === n - 1) {
        // the last one leans on its neighbour: tipped towards it on its bottom edge, its side
        // resting on the neighbour's top corner (it used to lean the other way, onto nothing)
        const lean = 0.32;
        const t = Math.min(h, hPrev / Math.cos(lean)); // where along its side it touches
        b.at([x + t * Math.sin(lean), 0, 0], [0, 0, lean], () => uprightBook(b, w / 2, 0, 0, w, h, dp, leather(r, dusty)));
      } else uprightBook(b, x + w / 2, x < 0.045 ? 0.006 : 0, 0, w, h, dp, leather(r, dusty)); // (on the bookend's foot)
      x += w + 0.001;
      hPrev = h + (x - w - 0.001 < 0.045 ? 0.006 : 0);
    }
  };

  // ---- curios ----------------------------------------------------------------------------------
  // (the jaw is the lowest part: it rests on what's below instead of hovering 4 mm over it)
  const skull = (b: D, x: number, y: number, z: number, s = 1, rotY = 0) =>
    b.at([x, y - 0.004 * s, z], [0, rotY, 0], () => {
      b.sphere(0.034, [0, 0.042, -0.006], C.bone, { seg: 9, rough: 0.6, scale: [0.9, 0.86, 1.1] });
      b.box([0.044, 0.026, 0.034], [0, 0.017, 0.014], C.bone, { rough: 0.6 });
      b.sphere(0.0095, [-0.013, 0.035, 0.027], "#120c08", { seg: 5 });
      b.sphere(0.0095, [0.013, 0.035, 0.027], "#120c08", { seg: 5 });
      b.box([0.008, 0.011, 0.006], [0, 0.023, 0.03], "#120c08");
      b.box([0.03, 0.006, 0.004], [0, 0.008, 0.031], "#ebe2c8", { rough: 0.5 });
    }, [s, s, s]);
  const hourglass = (b: D, x: number, y: number, z: number, s = 1) =>
    b.at([x, y, z], null, () => {
      b.cyl(0.034, 0.036, 0.008, [0, 0.004, 0], C.oak, { seg: 8 });
      b.cyl(0.036, 0.034, 0.008, [0, 0.116, 0], C.oak, { seg: 8 });
      for (let k = 0; k < 3; k++) {
        const a = (k * TAU) / 3 + 0.5;
        b.cyl(0.0035, 0.0035, 0.104, [Math.cos(a) * 0.027, 0.06, Math.sin(a) * 0.027], C.oak, { seg: 5 });
      }
      b.lathe([[0, 0.008], [0.02, 0.01], [0.024, 0.03], [0.016, 0.048], [0.005, 0.058], [0, 0.058]], [0, 0, 0], C.sand, { seg: 8, rough: 0.5 });
      b.lathe([[0, 0.058], [0.005, 0.06], [0.016, 0.07], [0.024, 0.088], [0.02, 0.106], [0, 0.108]], [0, 0, 0], C.glass, { seg: 8, rough: 0.08, metal: 0.4 });
    }, [s, s, s]);
  const bottle = (b: D, x: number, y: number, z: number, k: number, col: string, s = 1, glow = 0) => {
    const p = BOTTLES[k % BOTTLES.length];
    b.lathe(sc(p, s), [x, y, z], col, { seg: 6, rough: 0.12, metal: 0.25, glow });
    const top = p[p.length - 1][1] * s, neck = p[p.length - 2][0] * s;
    if (k % BOTTLES.length === 2) b.cyl(neck * 1.15, neck * 1.15, 0.008 * s, [x, y + top + 0.004 * s, z], C.cork, { seg: 8 });
    else b.cyl(neck * 0.9, neck * 0.75, 0.014 * s, [x, y + top + 0.005 * s, z], C.cork, { seg: 6 });
  };
  const globe = (b: D, x: number, y: number, z: number, r: number, tilt = 0.41) =>
    b.at([x, y, z], null, () => {
      b.lathe(sc([[0, 0], [0.55, 0], [0.5, 0.08], [0.18, 0.16], [0.12, 0.4], [0.2, 0.48], [0.08, 0.56], [0, 0.56]], r), [0, 0, 0], C.oak, { seg: 10 });
      const cy = 0.56 * r + r * 1.12;
      ring(b, r * 1.12, r * 0.035, [0, cy, 0], C.brass, MET, [0, 0, tilt], TAU, 12);
      b.sphere(r, [0, cy, 0], "#ffffff", { seg: 11, tex: T.globe, rough: 0.5, rot: [0, 0, tilt] });
    });
  const armillaryRings = (b: D, r: number) => {
    const tub = r > 0.1 ? 28 : 14;
    ring(b, r, r * 0.05, [0, 0, 0], C.gold, MET, [Math.PI / 2, 0, 0], TAU, tub);
    ring(b, r, r * 0.05, [0, 0, 0], C.gold, MET, [0, 0, 0.41], TAU, tub);
    ring(b, r * 0.96, r * 0.04, [0, 0, 0], C.brass, MET, [Math.PI / 2 + 0.41, 0, 0], TAU, tub);
    if (r > 0.1) ring(b, r * 0.93, r * 0.04, [0, 0, 0], C.brass, MET, [0, Math.PI / 2, 0], TAU, tub);
    b.sphere(r * 0.22, [0, 0, 0], C.gold, { seg: 8, ...MET, glow: r > 0.1 ? 0.25 : 0 });
  };
  const armillary = (b: D, x: number, y: number, z: number, r = 0.055) =>
    b.at([x, y, z], null, () => {
      b.lathe([[0, 0], [0.032, 0], [0.03, 0.01], [0.012, 0.02], [0.007, 0.06], [0, 0.06]], [0, 0, 0], C.bronze, { seg: 8, ...MET });
      b.at([0, 0.06 + r, 0], null, () => armillaryRings(b, r));
    });
  const scrollPile = (b: D, r: Rnd, dusty = false) => {
    const rows: [number, number][] = [[-0.034, 0.016], [0, 0.016], [0.034, 0.016], [-0.017, 0.045], [0.017, 0.045], [0, 0.073]];
    rows.forEach(([z, y], i) => {
      if (i === 5 && r() < 0.4) return;
      const len = 0.14 + r() * 0.06, x = (r() - 0.5) * 0.03;
      const col = new THREE.Color(C.parchment).multiplyScalar(0.8 + r() * 0.25);
      if (dusty) col.lerp(new THREE.Color("#8a8070"), 0.3);
      b.cyl(0.016, 0.016, len, [x, y, z], col, { seg: 7, rot: [0, 0, Math.PI / 2], rough: 0.85 });
      b.cyl(0.006, 0.006, len + 0.024, [x, y, z], C.woodDark, { seg: 4, rot: [0, 0, Math.PI / 2] });
      if (i === 1 || i === 4) ring(b, 0.0168, 0.002, [x + (r() - 0.5) * 0.05, y, z], "#8a1a1a", { rough: 0.7 }, [0, Math.PI / 2, 0], TAU, 10);
    });
  };
  const inkAndQuill = (b: D, r: Rnd) => {
    b.plane([0.1, 0.13], [-0.03, 0.0015, 0], "#ffffff", { tex: T.letter, rot: [-Math.PI / 2, 0, (r() - 0.5) * 0.6] });
    b.lathe([[0, 0], [0.022, 0], [0.024, 0.01], [0.02, 0.024], [0.01, 0.03], [0.01, 0.036], [0.013, 0.038], [0, 0.038]], [0.04, 0, 0.01], "#151a22", { seg: 8, rough: 0.15, metal: 0.2 });
    // quill: shaft out of the pot, vane along its upper half
    const tilt = -0.32;
    b.at([0.04, 0.03, 0.01], [0.15, 0, tilt], () => {
      b.cyl(0.0015, 0.0012, 0.16, [0, 0.08, 0], "#e8e0cc", { seg: 4 });
      b.sphere(1, [0.004, 0.11, 0], "#f2ece0", { seg: 8, scale: [0.009, 0.055, 0.0015], rough: 0.8 });
    });
    // a sealed letter
    b.box([0.07, 0.006, 0.045], [-0.05, 0.004, 0.06], "#e6d6ae", { rot: [0, 0.4, 0], rough: 0.9 });
    b.cyl(0.009, 0.009, 0.003, [-0.05, 0.008, 0.06], "#9a1414", { seg: 8, rough: 0.4 });
  };
  /** `room`: free space behind the chest (an open lid swings back only until it meets the wall) */
  const chest = (b: D, w: number, h: number, dp: number, col = C.wood, coins = false, room = Infinity) => {
    b.box([w, h, dp], [0, h / 2, 0], col, { rough: 0.65 });
    if (coins) {
      // open: a heap of gold inside, the lid thrown back (as far as the wall lets it: swung back
      // by ψ its dome reaches dp/2·(1 − cos ψ) behind the hinge; it used to sink into the wall)
      const back = Math.min(1.9, Math.acos(THREE.MathUtils.clamp(1 - (room - 0.005) / (dp / 2), -1, 1)));
      b.sphere(1, [0, h, 0], C.gold, { seg: 10, scale: [w * 0.46, dp * 0.18, dp * 0.42], metal: 0.7, rough: 0.3 });
      b.at([0, h, -dp / 2], [-back, 0, 0], () => {
        b.geo(new THREE.CylinderGeometry(dp / 2, dp / 2, w, 10, 1, false, 0, Math.PI), [0, 0, dp / 2], col, { rot: [0, 0, Math.PI / 2], rough: 0.65 });
        b.box([w, 0.008, dp], [0, 0.004, dp / 2], C.woodDark, { rough: 0.7 }); // the lid's inside
      });
    } else {
      b.geo(new THREE.CylinderGeometry(dp / 2, dp / 2, w, 10, 1, false, 0, Math.PI), [0, h, 0], col, { rot: [0, 0, Math.PI / 2], rough: 0.65 });
      for (const bx of [-w / 2 + w * 0.12, w / 2 - w * 0.12]) ring(b, dp / 2 + 0.002, Math.max(0.003, w * 0.012), [bx, h, 0], C.iron, IRN, [0, Math.PI / 2, 0], Math.PI, 8);
      b.box([w * 0.1, h * 0.28, 0.006], [0, h - h * 0.12, dp / 2 + 0.003], C.brass, MET);
    }
    for (const bx of [-w / 2 + w * 0.12, w / 2 - w * 0.12]) b.box([Math.max(0.006, w * 0.03), h + 0.002, dp + 0.004], [bx, h / 2, 0], C.iron, IRN);
  };
  const crystalBall = (b: D, x: number, y: number, z: number, s = 1) =>
    b.at([x, y, z], null, () => {
      b.lathe([[0, 0], [0.034, 0], [0.03, 0.012], [0.014, 0.022], [0.018, 0.034], [0.03, 0.044], [0, 0.044]], [0, 0, 0], C.bronze, { seg: 8, ...MET });
      for (let k = 0; k < 3; k++) {
        const a = (k * TAU) / 3;
        b.box([0.006, 0.03, 0.006], [Math.cos(a) * 0.026, 0.05, Math.sin(a) * 0.026], C.bronze, { ...MET, rot: [Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5] });
      }
      b.sphere(0.04, [0, 0.082, 0], "#8fc4ff", { seg: 10, rough: 0.05, metal: 0.3, glow: 0.3 });
    }, [s, s, s]);
  const owl = (b: D, s = 1) =>
    b.at([0, 0, 0], null, () => {
      b.cyl(0.035, 0.04, 0.03, [0, 0.015, 0], C.woodDark, { seg: 8 });
      b.sphere(0.04, [0, 0.08, 0], "#7a5a3a", { seg: 10, scale: [0.9, 1.25, 0.85] });
      b.sphere(0.032, [0, 0.074, 0.016], "#c8b090", { seg: 8, scale: [0.8, 1.1, 0.55] });
      b.sphere(0.033, [0, 0.135, 0], "#6f5034", { seg: 10, scale: [1.1, 0.9, 1] });
      b.sphere(0.026, [0, 0.135, 0.02], "#d8c8a8", { seg: 8, scale: [1.2, 1, 0.42] });
      for (const s2 of [-1, 1]) {
        b.sphere(0.008, [s2 * 0.011, 0.139, 0.029], "#e8a818", { seg: 6, rough: 0.1 });
        b.sphere(0.0042, [s2 * 0.011, 0.139, 0.0355], "#050505", { seg: 5, rough: 0.1 });
        b.cyl(0, 0.008, 0.022, [s2 * 0.02, 0.164, 0], "#5a3e26", { seg: 4, rot: [0, 0, -s2 * 0.35] });
        b.sphere(0.02, [s2 * 0.03, 0.08, -0.005], "#5f432a", { seg: 6, scale: [0.4, 1.5, 0.9] });
      }
      b.cyl(0, 0.0045, 0.014, [0, 0.127, 0.036], "#3a2a18", { seg: 4, rot: [Math.PI, 0, 0] });
    }, [s, s, s]);
  const cat = (b: D, s = 1, black = false, hangTail = false) =>
    b.at([0, 0, 0], null, () => {
      const fur = black ? "#2a2626" : "#ffffff";
      const tex = black ? undefined : T.tabby;
      const plain = black ? "#2a2626" : "#c8743a";
      b.sphere(1, [0, 0.042, 0], fur, { seg: 14, tex, scale: [0.105, 0.048, 0.07], rough: 0.9 });
      b.sphere(1, [0.07, 0.036, 0.04], fur, { seg: 12, tex, scale: [0.038, 0.032, 0.04], rough: 0.9, rot: [0, -0.5, 0] });
      for (const e of [-1, 1]) b.cyl(0, 0.013, 0.022, [0.07 + e * 0.017, 0.067, 0.036 + e * 0.008], plain, { seg: 4, rot: [e * 0.25, 0, -e * 0.35] });
      b.sphere(1, [0.093, 0.03, 0.065], black ? "#3a3434" : "#efe2d2", { seg: 8, scale: [0.016, 0.012, 0.014] });
      b.sphere(0.0035, [0.1, 0.035, 0.078], "#d07a7a", { seg: 5 });
      for (const e of [-1, 1]) b.box([0.012, 0.0022, 0.002], [0.078 + e * 0.012, 0.043, 0.072 + e * 0.006], "#1a120c", { rot: [0, -0.5, e * 0.15] });
      // paws and the tail curled round the front
      b.sphere(1, [0.04, 0.012, 0.075], black ? "#2a2626" : "#e8d8c4", { seg: 8, scale: [0.022, 0.011, 0.014] });
      if (hangTail) tube(b, [[-0.095, 0.03, 0.0], [-0.1, 0.025, 0.06], [-0.095, -0.01, 0.1], [-0.088, -0.07, 0.104], [-0.08, -0.1, 0.1]], 0.01, plain, 12, { rough: 0.9 }, 6);
      else tube(b, [[-0.1, 0.03, -0.02], [-0.095, 0.016, 0.05], [-0.03, 0.012, 0.083], [0.03, 0.014, 0.09]], 0.011, plain, 10, { rough: 0.9 }, 6);
    }, [s, s, s]);
  const bust = (b: D, s = 1, stone: string = C.marble) =>
    b.at([0, 0, 0], null, () => {
      b.box([0.1, 0.04, 0.09], [0, 0.02, 0], C.stoneDark, STN);
      const o = { rough: 0.45, metal: stone === C.marble ? 0 : 0.5 };
      b.lathe([[0, 0.04], [0.04, 0.04], [0.035, 0.05], [0.055, 0.07], [0.06, 0.1], [0.045, 0.12], [0.016, 0.13], [0, 0.13]], [0, 0, 0], stone, { seg: 10, ...o });
      b.cyl(0.016, 0.018, 0.03, [0, 0.14, 0], stone, { seg: 8, ...o });
      b.sphere(1, [0, 0.18, 0.004], stone, { seg: 12, scale: [0.03, 0.038, 0.034], ...o });
      b.sphere(1, [0, 0.152, 0.024], stone, { seg: 8, scale: [0.022, 0.03, 0.014], ...o }); // beard
      b.box([0.008, 0.016, 0.012], [0, 0.178, 0.036], stone, o);
      ring(b, 0.031, 0.004, [0, 0.198, 0], C.gold, MET, [Math.PI / 2 + 0.15, 0, 0], TAU, 12); // laurels
    }, [s, s, s]);
  /** a library ladder of length h; `rail`: the brass rail's centre in the ladder's frame, and how far the ladder leans back */
  const ladder = (b: D, h: number, rail: { y: number; z: number; lean: number }) => {
    for (const x of [-0.17, 0.17]) b.box([0.032, h, 0.022], [x, h / 2, 0], C.oak, { rough: 0.6 });
    for (let y = 0.12; y < h - 0.05; y += 0.2) b.cyl(0.011, 0.011, 0.34, [0, y, 0], C.oak, { seg: 6, rot: [0, 0, Math.PI / 2] });
    for (const x of [-0.17, 0.17]) {
      // a hook from the top of each stile up, over the rail and down behind it (upright, about the
      // rail's centre; they used to pass through the rail instead of over it)
      b.at([x, rail.y, rail.z], [rail.lean, 0, 0], () => {
        const k = 0.0165, c = k * Math.SQRT1_2;
        tube(b, [[0, -0.035, 0.016], [0, 0, k], [0, c, c], [0, k, 0], [0, c, -c], [0, 0, -k], [0, -0.016, -k]], 0.006, C.brass, 16, MET, 5);
      });
      // wheels, on axles through the stiles
      b.cyl(0.032, 0.032, 0.016, [x + Math.sign(x) * 0.026, 0.032, 0.0], C.iron, { seg: 10, rot: [0, 0, Math.PI / 2], ...IRN });
      b.cyl(0.006, 0.006, 0.03, [x + Math.sign(x) * 0.012, 0.032, 0.0], C.iron, { seg: 6, rot: [0, 0, Math.PI / 2], ...IRN });
    }
  };

  // ---- wall pieces -----------------------------------------------------------------------------
  /** inverted-U arch moulding authored flat: outer w×h, legs `t` thick, pointed top */
  const archMould = (w: number, h: number, t: number, spring: number) => {
    const s = new THREE.Shape();
    const k = 0.62;
    s.moveTo(-w / 2, 0);
    s.lineTo(-w / 2, spring);
    s.quadraticCurveTo(-w / 2, spring + (h - spring) * k, 0, h);
    s.quadraticCurveTo(w / 2, spring + (h - spring) * k, w / 2, spring);
    s.lineTo(w / 2, 0);
    s.lineTo(w / 2 - t, 0);
    s.lineTo(w / 2 - t, spring);
    s.quadraticCurveTo(w / 2 - t, spring + (h - t - spring) * k, 0, h - t * 1.3);
    s.quadraticCurveTo(-w / 2 + t, spring + (h - t - spring) * k, -w / 2 + t, spring);
    s.lineTo(-w / 2 + t, 0);
    s.lineTo(-w / 2, 0);
    return s;
  };
  const archFill = (w: number, h: number, spring: number) => {
    const s = new THREE.Shape();
    const k = 0.62;
    s.moveTo(-w / 2, 0);
    s.lineTo(-w / 2, spring);
    s.quadraticCurveTo(-w / 2, spring + (h - spring) * k, 0, h);
    s.quadraticCurveTo(w / 2, spring + (h - spring) * k, w / 2, spring);
    s.lineTo(w / 2, 0);
    s.lineTo(-w / 2, 0);
    return s;
  };
  const extrudeFlat = (s: THREE.Shape, depth: number, curve = 5) => new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: curve });
  /** a heraldic banner on an iron pole; local origin at the pole's centre, cloth hanging below (+z faces the viewer) */
  const banner = (b: D, w: number, h: number, tex: UVRect, wall = 0.03) => {
    b.cyl(0.009, 0.009, w + 0.12, [0, 0, 0.02], C.iron, { seg: 6, rot: [0, 0, Math.PI / 2], ...IRN });
    for (const s of [-1, 1]) {
      b.sphere(0.017, [s * (w / 2 + 0.07), 0, 0.02], C.brass, { seg: 6, ...MET });
      tube(b, [[s * (w / 2 + 0.03), 0, 0.02], [s * w * 0.25, 0.1, 0.01], [0, 0.16, 0]], 0.003, "#6a5030", 4, {}, 3);
    }
    // the cord hangs on an iron nail driven into the wall `wall` behind the pole (its peak used to
    // be tied to thin air)
    b.cyl(0.0035, 0.0035, wall + 0.012, [0, 0.155, (0.006 - wall) / 2], C.iron, { seg: 5, rot: [Math.PI / 2, 0, 0], ...IRN });
    b.sphere(0.0065, [0, 0.155, 0.006], C.iron, { seg: 5, ...IRN });
    const g = new THREE.PlaneGeometry(w, h, 8, 1);
    const P = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < P.count; i++) P.setZ(i, Math.sin((P.getX(i) / w) * TAU * 1.5 + 0.7) * 0.012);
    g.computeVertexNormals();
    b.geo(g, [0, -h / 2 - 0.004, 0.026], "#ffffff", { tex, rough: 0.95 });
  };
  /** a stained-glass lancet: frame + leaded glass; origin bottom centre on the wall, +z out of the wall */
  const lancet = (b: D, theta: number, y: number, w: number, h: number, tex: UVRect) => {
    const spring = h - w * 0.95;
    b.geo(bend(extrudeFlat(archMould(w + 0.16, h + 0.1, 0.09, spring), 0.07, 6), theta, y - 0.05), [0, 0, 0], C.stoneLight, STN);
    const glass = new THREE.ShapeGeometry(archFill(w, h, spring), 8);
    const P = glass.getAttribute("position") as THREE.BufferAttribute, U = glass.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < P.count; i++) U.setXY(i, THREE.MathUtils.clamp(P.getX(i) / w + 0.5, 0.002, 0.998), THREE.MathUtils.clamp(P.getY(i) / h, 0.002, 0.998));
    b.geo(bend(glass, theta, y, RW - 0.006), [0, 0, 0], "#ffffff", { tex, glow: 0.38, rough: 0.2 });
    // sill
    at(b, theta, y - 0.07, RW - 0.06, () => b.box([w + 0.26, 0.05, 0.14], [0, 0, 0], C.stoneLight, STN));
    // mullion and transom bars
    at(b, theta, y, RW - 0.012, () => {
      b.box([0.018, spring + 0.1, 0.02], [0, (spring + 0.1) / 2, 0], C.iron, IRN);
      b.box([w, 0.014, 0.018], [0, spring * 0.5, 0], C.iron, IRN);
    });
  };
  const roundel = (b: D, theta: number, y: number, r: number, tex: UVRect) => {
    b.geo(bend(new THREE.TorusGeometry(r + 0.012, 0.016, 4, 16), theta, y), [0, 0, 0], C.stoneLight, STN);
    // (the tower wall is a 64-gon whose flats lie 4 mm inside RW: glass at RW - 0.004 z-fought them)
    b.geo(bend(new THREE.CircleGeometry(r, 16), theta, y, RW - 0.008), [0, 0, 0], "#ffffff", { tex, glow: 0.35, rough: 0.2 });
  };
  const pinnedSheet = (b: D, theta: number, y: number, w: number, h: number, tex: UVRect, tilt = 0) =>
    at(b, theta, y, RW - 0.006, () => {
      b.plane([w, h], [0, 0, 0], "#ffffff", { tex, rot: [0, 0, tilt], rough: 0.9 });
      for (const [px, py] of [[-0.42, 0.42], [0.42, 0.42], [-0.42, -0.42], [0.42, -0.42]] as P2[]) {
        const cx = px * w, cy = py * h;
        b.cyl(0.006, 0.006, 0.008, [cx * Math.cos(tilt) - cy * Math.sin(tilt), cx * Math.sin(tilt) + cy * Math.cos(tilt), 0.004], C.brass, { seg: 4, rot: [Math.PI / 2, 0, 0], ...MET });
      }
    });
  const ivy = (b: D, r: Rnd, start: Vec3, len: number, theta: number, leaves = 1) => {
    // a vine creeping down the wall (start is world space, on the wall); leaves are alpha-cut quads
    const pts: Vec3[] = [];
    const n = Math.max(3, Math.round(len / 0.15));
    let th = theta;
    for (let i = 0; i <= n; i++) {
      const y = start[1] - (len * i) / n;
      th += ((r() - 0.5) * 0.08) / RW;
      const rr = RW - 0.012 - r() * 0.012;
      pts.push([Math.cos(th) * rr, y, Math.sin(th) * rr]);
    }
    tube(b, pts, 0.005, "#3a3018", n * 2, {}, 3);
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    const count = Math.round(len * 26 * leaves);
    for (let i = 0; i < count; i++) {
      const p = curve.getPoint(Math.min(1, (i + r() * 0.8) / count));
      const ang = Math.atan2(p.z, p.x);
      const s = 0.035 + r() * 0.03;
      const side = r() < 0.5 ? -1 : 1;
      at(b, ang + (side * (0.015 + r() * 0.025)) / RW, p.y + (r() - 0.5) * 0.03, RW - 0.02 - r() * 0.02, () =>
        b.plane([s, s], [0, 0, 0], r() < 0.3 ? "#c8d8a0" : "#ffffff", { tex: T.leaf, rot: [(r() - 0.3) * 0.8, (r() - 0.5) * 0.6, side * (0.5 + r() * 1.2) + Math.PI], rough: 0.7 }),
      );
    }
  };
  const cobweb = (b: D, x: number, y: number, z: number, s: number, corner: 0 | 1 | 2 | 3) =>
    // corner: 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left (the web's anchor corner)
    b.plane([s, s], [x, y, z], "#ffffff", { tex: T.web, rot: [0, 0, -corner * (Math.PI / 2)], rough: 1 });

  // ======================================================================================
  // 1. along the helix: every bay's top, the wall above it, and the joints between bays
  // ======================================================================================
  type Bay = { theta: number; y: number; w: number; region: Region; i: number };
  const all: Bay[] = [];
  {
    let a = L.bays[0].theta - (L.bays[0].width / 2 + 0.05) / R;
    const before: Bay[] = [];
    while (a > L.a0) {
      a -= 0.95 / R / 2;
      before.push({ theta: a, y: thetaY(a), w: 0.9, region: "dusty", i: 0 });
      a -= 0.95 / R / 2;
    }
    all.push(...before.reverse());
    for (const b of L.bays) all.push({ theta: b.theta, y: b.y, w: b.width, region: "lib", i: 0 });
    a = L.libEnd;
    while (a < L.a1) {
      a += 0.95 / R / 2;
      all.push({ theta: a, y: thetaY(a), w: 0.9, region: "ghost", i: 0 });
      a += 0.95 / R / 2;
    }
    all.forEach((b, i) => (b.i = i));
  }
  const firstLib = all.findIndex((b) => b.region === "lib");
  const lastLib = firstLib + L.bays.length - 1;
  // the ginger cat sleeps on the dusty bookcase just under today's bays (seen from above in the first view)
  // cats: a ginger one asleep on today's bookcase (tail over the edge), a black one on the dusty
  // bookcase right below it (both in the first view)
  const below = (b: Bay) => all.reduce((p, q) => (Math.abs(q.theta - (b.theta - TAU)) < Math.abs(p.theta - (b.theta - TAU)) ? q : p));
  let viewTheta = all[lastLib - 1].theta;
  if (c.rig.rail) viewTheta = (c.rig.rail.at(c.rig.state.s, new THREE.Vector3(), new THREE.Vector3()).p.y / PITCH) * TAU; // where the first view looks
  const viewBay = all.slice(firstLib, lastLib + 1).reduce((p, q) => (Math.abs(q.theta - viewTheta) < Math.abs(p.theta - viewTheta) ? q : p));
  const catSpots = new Map<Bay, number>([[viewBay, 1], [below(viewBay), -1]]);

  // the carved stone cornice under every band (the edge of the "stair")
  {
    // (closed on top, where it shows between the bays, and capped at both ends: it used to be an
    // open strip you could see into, and through)
    const prof: P2[] = [[RW, -0.075], [3.0, -0.075], [3.0, -0.075], [2.962, -0.056], [2.95, -0.034], [2.958, -0.012], [2.972, 0], [3.0, 0], [3.0, 0], [RW, 0]];
    const c0 = L.a0 - 0.15, c1 = L.a1 + 0.2;
    d.geo(helixSweep(prof, c0, c1, 0.1, thetaY), [0, 0, 0], C.stone, STN);
    for (const [a, out] of [[c0, -1], [c1, 1]]) d.geo(profileCap(prof, a, thetaY(a), out), [0, 0, 0], C.stone, STN);
  }

  mark("cornice");
  const libCenter = ["candelabra", "globe", "candelabra", "armillary", "candelabra", "hourglass", "candelabra", "owl", "candelabra", "crystal", "candelabra", "globe"];
  let crestK = 0, mapK = 0;
  for (const bay of all) {
    const r = () => rnd();
    const top = bay.y + TOP;
    const half = bay.w / 2;
    const dusty = bay.region === "dusty", ghost = bay.region === "ghost";
    const lit = !dusty || r() < 0.25;

    const roomy = bay.y + TOP + 0.32 < under; // the last bays reach up under the gallery
    // pinnacles on both posts, a cornice with a gilt bead along the front edge
    at(d, bay.theta, bay.y, R, () => {
      if (bay.y + BAND + 0.17 < under) for (const s of [-1, 1]) d.lathe(PIN_P, [s * half, BAND + 0.03, -0.015], C.woodDark, { seg: 4, rough: 0.6, rot: [0, Math.PI / 4, 0] });
      d.box([bay.w - 0.04, 0.03, 0.022], [0, TOP + 0.012, 0.004], C.woodDark, { rough: 0.6 });
      d.box([bay.w - 0.04, 0.005, 0.005], [0, TOP + 0.022, 0.017], "#8a6a2c", { metal: 0.4, rough: 0.55 });
    });
    // a pointed arch on the wall over the bay
    if (bay.y + PITCH - 0.1 < under) d.geo(bend(extrudeFlat(archMould(bay.w - 0.02, PITCH - BAND - 0.1, 0.03, 0.05), 0.022, 3), bay.theta, bay.y + BAND), [0, 0, 0], C.stoneLight, STN);

    // vignettes on the bookcase top: left, right and (behind the plaque) centre
    if (roomy) at(d, bay.theta, top, R, () => {
      const catSide = catSpots.get(bay);
      let slots = dusty || ghost ? [bay.i % 2 ? -1 : 1] : [-1, 1];
      if (catSide !== undefined) slots = dusty || ghost ? [-catSide] : slots.filter((q) => q !== catSide);
      for (const s of slots) {
        const x = s * (half * 0.6 + (r() - 0.5) * 0.04), z = -0.15 + (r() - 0.5) * 0.05;
        d.at([x, 0, z], [0, (r() - 0.5) * 0.7, 0], () => vignette(bay, r, lit));
      }
      if (bay.region === "lib") {
        const k = libCenter[(bay.i - firstLib) % libCenter.length];
        d.at([0, 0, -0.2], null, () => centrepiece(k, r));
      }
    });
    // the wall over a decorative bay (no plaque there): maps, crests, rose windows, star charts
    if ((dusty || ghost) && roomy) {
      // (low enough, and small enough, to sit inside the arch: their tops used to run up behind its
      // moulding, which is solid stone standing proud of the wall)
      const yC = bay.y + BAND + 0.14;
      if (dusty) {
        if (bay.i % 2 === 0) pinnedSheet(d, bay.theta, yC, 0.22, 0.165, T.maps[mapK++ % T.maps.length], (r() - 0.5) * 0.12);
        else crest(bay.theta, yC, crestK++);
      } else if (bay.i % 2 === 0) roundel(d, bay.theta, yC, 0.095, T.roses[bay.i % T.roses.length]);
      else pinnedSheet(d, bay.theta, yC, 0.18, 0.18, T.chart, (r() - 0.5) * 0.1);
    }
    // cobwebs in the dusty bays' corners
    if (dusty) {
      at(d, bay.theta, bay.y, R, () => {
        const s = 0.13 + r() * 0.08;
        const corner = (bay.i % 4) as 0 | 1 | 2 | 3;
        const x = corner === 0 || corner === 3 ? -half + 0.02 + s / 2 : half - 0.02 - s / 2;
        const y = corner < 2 ? TOP - 0.025 - s / 2 : 0.04 + s / 2;
        cobweb(d, x, y, 0.004, s, corner);
      });
    }
    if (bay.i % 14 === 13) await pause("Dusting the curios…");
  }
  mark("bays");
  // sconces where two bays meet
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i], b = all[i + 1];
    {
      // a carved pilaster over the two posts where the bays meet
      // (set back onto the posts' faces: the bays are flat chords, so at their ends the posts stand
      // ~3 cm behind the circle of radius R and the pilaster used to float in front of them; and
      // down into the cornice instead of stopping short over a slot of daylight)
      const th = (a.theta + a.w / 2 / R + b.theta - b.w / 2 / R) / 2, y = (a.y + b.y) / 2;
      const postR = (q: Bay) => Math.hypot(R - 0.01, q.w / 2 + 0.02); // a post's outer front corner, from the axis
      at(d, th, y, Math.min(postR(a), postR(b)) + 0.0085, () => {
        d.box([0.062, BAND - 0.015, 0.012], [0, (BAND - 0.035) / 2, 0.016], C.woodDark, { rough: 0.6 });
        d.box([0.022, BAND - 0.2, 0.008], [0, BAND / 2 + 0.01, 0.025], C.oak, { rough: 0.55 });
        d.box([0.078, 0.035, 0.026], [0, BAND - 0.03, 0.016], "#5a3a1e", { rough: 0.6 });
      });
    }
    if (i % 2 || (a.region === "dusty" && i % 4)) continue;
    const th = (a.theta + a.w / 2 / R + b.theta - b.w / 2 / R) / 2;
    const lit = a.region !== "dusty" || i % 3 === 0;
    if (thetaY(th) + BAND + 0.28 > under) continue;
    at(d, th, thetaY(th) + BAND + 0.1, RW, () => sconce(d, lit));
  }

  mark("sconces");
  // the cats
  for (const [b, side] of catSpots) {
    const black = b.region === "dusty";
    at(d, b.theta, b.y + TOP, R, () =>
      d.at([side * b.w * 0.3, 0, black ? -0.15 : -0.06], [0, black ? 0.5 : -0.1, 0], () => {
        const h = bookPile(d, rnd, black ? 2 : 3, black);
        d.at([0, h, 0], null, () => cat(d, black ? 0.95 : 1, black, !black));
      }),
    );
  }

  mark("ladder+cats");
  await pause("Waking the cats…");
  function vignette(bay: Bay, r: Rnd, lit: boolean) {
    const dusty = bay.region === "dusty", ghost = bay.region === "ghost";
    const k = r();
    if (dusty) {
      if (k < 0.2) {
        const h = bookPile(d, r, 3 + Math.floor(r() * 3), true);
        if (r() < 0.6) skull(d, 0, h, 0, 1, (r() - 0.5) * 1.2);
      } else if (k < 0.36) scrollPile(d, r, true);
      else if (k < 0.5) {
        skull(d, 0, 0, 0, 1.1, (r() - 0.5) * 1.2);
        candle(d, 0, 0.07, -0.005, 0.03 + r() * 0.03, 0.01, lit, C.waxOld);
      } else if (k < 0.62) candleCluster(r, lit, C.waxOld);
      else if (k < 0.72) hourglass(d, 0, 0, 0, 1.1);
      else if (k < 0.84) chest(d, 0.15, 0.07, 0.09, C.wood, false);
      else if (k < 0.92) jars(r);
      else bookRow(d, r, 4 + Math.floor(r() * 3), true);
      return;
    }
    if (ghost) {
      if (k < 0.18) crystalBall(d, 0, 0, 0, 1.1);
      else if (k < 0.32) armillary(d, 0, 0, 0, 0.055);
      else if (k < 0.46) {
        // a spyglass lying on a star chart
        d.plane([0.16, 0.16], [0, 0.0015, 0], "#ffffff", { tex: T.chart, rot: [-Math.PI / 2, 0, 0.2] });
        d.lathe([[0, 0], [0.011, 0], [0.011, 0.05], [0.0135, 0.05], [0.0135, 0.1], [0.016, 0.1], [0.017, 0.16], [0, 0.16]], [-0.08, 0.017, 0.02], C.brass, { seg: 8, ...MET, rot: [0, 0.3, -Math.PI / 2] });
      } else if (k < 0.58) potions(r, 0.5);
      else if (k < 0.7) hourglass(d, 0, 0, 0, 1.2);
      else if (k < 0.82) globe(d, 0, 0, 0, 0.05);
      else if (k < 0.92) {
        const h = bookPile(d, r, 2 + Math.floor(r() * 3));
        candle(d, 0, h, 0, 0.06 + r() * 0.04, 0.013, true);
      } else bookRow(d, r, 5 + Math.floor(r() * 3));
      return;
    }
    if (k < 0.2) {
      const h = bookPile(d, r, 2 + Math.floor(r() * 4));
      const t = r();
      if (t < 0.4) candlestick(d, 0, h, 0, 0.08, 0.06 + r() * 0.03, lit);
      else if (t < 0.6) skull(d, 0, h, 0, 0.9, (r() - 0.5) * 1.2);
      else if (t < 0.8) hourglass(d, 0, h, 0, 0.8);
    } else if (k < 0.34) bookRow(d, r, 4 + Math.floor(r() * 4));
    else if (k < 0.46) potions(r, 0.15);
    else if (k < 0.56) candleCluster(r, lit, C.wax);
    else if (k < 0.64) scrollPile(d, r);
    else if (k < 0.73) inkAndQuill(d, r);
    else if (k < 0.8) globe(d, 0, 0, 0, 0.055);
    else if (k < 0.86) {
      skull(d, 0, 0, 0, 1.1, (r() - 0.5) * 1.2);
      candle(d, 0, 0.07, -0.005, 0.05, 0.011, lit);
    } else if (k < 0.92) chest(d, 0.16, 0.075, 0.1, C.wood, false);
    else hourglass(d, 0, 0, 0, 1.2);
  }
  function centrepiece(kind: string, r: Rnd) {
    if (kind === "candelabra") candelabra(d, 0, 0, 0, 0.2, true);
    else if (kind === "bust") bust(d, 1.1);
    else {
      // the rest stand on a little pile of books so they peek over the plaque
      const h = bookPile(d, r, 2);
      if (kind === "armillary") armillary(d, 0, h, 0, 0.05);
      else if (kind === "owl") d.at([0, h, 0], null, () => owl(d, 0.9));
      else if (kind === "globe") globe(d, 0, h, 0, 0.055);
      else if (kind === "hourglass") hourglass(d, 0, h, 0, 1.3);
      else if (kind === "crystal") crystalBall(d, 0, h, 0, 1.1);
    }
  }
  function candleCluster(r: Rnd, lit: boolean, wax: string) {
    d.cyl(0.06, 0.062, 0.006, [0, 0.003, 0], "#8a8478", { seg: 8, ...MET });
    // one in the middle, the rest evenly round it, all on the plate and none melted into another
    // (they used to be scattered at random angles, often through each other)
    const n = 3 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const a = ((i - 1) / (n - 1)) * TAU + (r() - 0.5) * 0.5, rr = i === 0 ? 0 : 0.04;
      candle(d, Math.cos(a) * rr, 0.006, Math.sin(a) * rr, 0.04 + r() * 0.09, Math.min(0.019, 0.014 + r() * 0.008), lit && r() < 0.85, wax);
    }
  }
  function potions(r: Rnd, glowChance: number) {
    // a staggered row (front, back, front…) spaced by each bottle's real girth: they used to be set
    // 5 cm apart whatever their size, so the fat flasks stood inside each other
    const n = 3 + Math.floor(r() * 2);
    const row: { jx: number; z: number; k: number; col: string; s: number; glow: number; rad: number; x: number }[] = [];
    for (let i = 0; i < n; i++) {
      const jx = r(), jz = r(), k = Math.floor(r() * BOTTLES.length), col = pick(r, GLASS), s = 0.85 + r() * 0.4, glow = r() < glowChance ? 0.35 : 0;
      const z = (i % 2 ? -0.026 : 0.026) + (jz - 0.5) * 0.008;
      row.push({ jx, z, k, col, s, glow, rad: Math.max(...BOTTLES[k].map((p) => p[0])) * s, x: 0 });
    }
    row.forEach((b, i) => {
      if (!i) return;
      const a = row[i - 1], gap = 0.004 + b.jx * 0.004;
      const dz = b.z - a.z, need = a.rad + b.rad + gap;
      b.x = a.x + Math.sqrt(Math.max(0, need * need - dz * dz));
      if (i > 1) b.x = Math.max(b.x, row[i - 2].x + row[i - 2].rad + b.rad + gap);
    });
    const mid = (row[0].x + row[n - 1].x) / 2;
    for (const b of row) bottle(d, b.x - mid, 0, b.z, b.k, b.col, b.s, b.glow);
  }
  function jars(r: Rnd) {
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * 0.06, h = 0.07 + r() * 0.04, rr = 0.024;
      d.lathe([[0, 0], [rr, 0], [rr + 0.003, 0.01], [rr + 0.003, h * 0.85], [rr * 0.7, h], [0, h]], [x, 0, 0], pick(r, ["#5a4a3a", "#3a4a5a", "#6a5a3a"]), { seg: 12, rough: 0.35, metal: 0.1 });
      d.cyl(rr * 0.85, rr * 0.75, 0.012, [x, h + 0.005, 0], C.cork, { seg: 6 });
      // the label wraps round the jar (a flat card stood off its sides)
      d.geo(new THREE.CylinderGeometry(rr + 0.0035, rr + 0.0035, 0.022, 6, 1, true, -0.6, 1.2), [x, h * 0.5, 0], "#ffffff", { tex: T.labels[i % T.labels.length], rough: 0.9 });
    }
  }
  function sconce(b: D, lit = true) {
    const s = new THREE.Shape();
    s.moveTo(-0.028, -0.07);
    s.lineTo(0.028, -0.07);
    s.quadraticCurveTo(0.045, 0.0, 0, 0.07);
    s.quadraticCurveTo(-0.045, 0.0, -0.028, -0.07);
    b.geo(extrudeFlat(s, 0.008, 4), [0, 0, 0], C.iron, IRN);
    b.geo(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0, -0.03, 0.006), new THREE.Vector3(0, -0.035, 0.05), new THREE.Vector3(0, -0.005, 0.1), new THREE.Vector3(0, 0.03, 0.115)]), 8, 0.0045, 4), [0, 0, 0], C.iron, IRN);
    ring(b, 0.012, 0.003, [0, -0.044, 0.034], C.iron, IRN, [0, Math.PI / 2, 0], Math.PI * 1.6, 5);
    b.lathe(PAN_P, [0, 0.03, 0.115], C.iron, { seg: 7, ...IRN });
    candle(b, 0, 0.044, 0.115, 0.07, 0.012, lit);
  }
  function crest(theta: number, y: number, k: number) {
    const s = new THREE.Shape();
    s.moveTo(-0.07, 0.08);
    s.lineTo(0.07, 0.08);
    s.lineTo(0.07, 0.0);
    s.quadraticCurveTo(0.065, -0.06, 0, -0.095);
    s.quadraticCurveTo(-0.065, -0.06, -0.07, 0.0);
    s.lineTo(-0.07, 0.08);
    at(d, theta, y, RW, () => d.at([0, 0, 0], null, () => {
      // crossed swords behind a heater shield
      for (const sgn of [-1, 1])
        d.at([0, 0, 0.012], [0, 0, sgn * 0.75], () => {
          d.box([0.012, 0.3, 0.004], [0, 0.01, 0], "#9aa0a6", { metal: 0.7, rough: 0.3 });
          d.box([0.06, 0.012, 0.01], [0, -0.14, 0], C.brass, MET);
          d.cyl(0.005, 0.005, 0.045, [0, -0.17, 0], "#3a2416", { seg: 5 });
          d.box([0.014, 0.014, 0.014], [0, -0.195, 0], C.brass, MET);
        });
      d.geo(extrudeFlat(s, 0.012, 4), [0, 0, 0.018], C.wood, { rough: 0.6 });
      d.plane([0.13, 0.165], [0, -0.006, 0.0315], "#ffffff", { tex: T.shields[k % T.shields.length], rough: 0.6 });
    }, [0.8, 0.8, 0.8])); // (scaled to fit under the arch)
  }

  // ======================================================================================
  // 2. the base: rune circle, fountain, blind arcade with a great door, furniture
  // ======================================================================================
  {
    const yb = yFloor;
    // rune circle (only the lines are drawn: alpha-cut) and a ring of flagstones around the fountain
    d.plane([4.8, 4.8], [0, yb + 0.006, 0], "#ffffff", { tex: T.runes, rot: [-Math.PI / 2, 0, 0], glow: 0.28, blink: 0.7, rough: 0.8 });
    d.lathe(crisp([[1.3, 0.003], [1.12, 0.012], [1.1, 0.003]]), [0, yb, 0], C.stoneDark, { seg: 32, ...STN });
    // tall ritual candles on the points of the rune circle's star
    for (let i = 0; i < 7; i++) {
      const a = (i * TAU) / 7 - Math.PI / 2, rr = (172 / 256) * 2.4;
      d.cyl(0.05, 0.06, 0.02, [Math.cos(a) * rr, yb + 0.01, Math.sin(a) * rr], C.iron, { seg: 6, ...IRN });
      candle(d, Math.cos(a) * rr, yb + 0.02, Math.sin(a) * rr, 0.22 + (i % 3) * 0.06, 0.032, true, C.waxOld);
    }
    // fountain: an octagonal basin, a column, an upper bowl and a softly glowing orb
    d.lathe(crisp([[0.95, 0], [0.95, 0.3], [1.03, 0.34], [1.03, 0.42], [0.88, 0.42], [0.88, 0.24]]), [0, yb, 0], C.stoneLight, { seg: 8, ...STN });
    d.cyl(0.885, 0.885, 0.01, [0, yb + 0.27, 0], C.water, { seg: 8, rough: 0.05, metal: 0.4 });
    d.lathe([[0.24, 0.27], [0.24, 0.36], [0.15, 0.44], [0.1, 0.5], [0.09, 0.8], [0.13, 0.84], [0.1, 0.88], [0.05, 0.9], [0.4, 0.98], [0.45, 1.04], [0.42, 1.06], [0.36, 1.03], [0.0, 1.0]], [0, yb, 0], C.stoneLight, { seg: 12, ...STN });
    d.cyl(0.37, 0.37, 0.01, [0, yb + 1.025, 0], C.water, { seg: 12, rough: 0.05, metal: 0.4 });
    d.lathe([[0, 1.03], [0.06, 1.03], [0.03, 1.08], [0.025, 1.12], [0, 1.12]], [0, yb, 0], C.bronze, { seg: 8, ...MET });
    d.sphere(0.07, [0, yb + 1.17, 0], "#9fd0ff", { seg: 14, rough: 0.1, metal: 0.2, glow: 0.55 });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU + 0.2;
      const p = (rr: number, y: number): Vec3 => [Math.cos(a) * rr, yb + y, Math.sin(a) * rr];
      tube(d, [p(0.44, 1.04), p(0.55, 1.0), p(0.68, 0.7), p(0.76, 0.28)], 0.007, "#a8d4ff", 10, { glow: 0.3, rough: 0.1 });
    }

    // blind arcade around the base: columns, pointed arches, a great door, tapestries and torches
    const N = 14, ladderK = 10;
    const ladderAz = ((ladderK + 0.5) / N) * TAU;
    const ladderTop = yb + 2.15;
    {
      const pts: Vec3[] = [];
      // (it stops short of the lowest bookcase, which it used to run straight through, and has
      // knobs on its ends instead of open tube)
      for (let a = ladderAz - 0.4; a <= ladderAz + 0.18 + 1e-3; a += 0.0725) pts.push([Math.cos(a) * (RW - 0.05), ladderTop, Math.sin(a) * (RW - 0.05)]);
      tube(d, pts, 0.01, C.brass, pts.length * 2, MET, 6);
      for (const p of [pts[0], pts[pts.length - 1]]) d.sphere(0.017, p, C.brass, { seg: 8, ...MET });
      for (const a of [ladderAz - 0.38, ladderAz, ladderAz + 0.16]) at(d, a, ladderTop, RW, () => d.box([0.02, 0.03, 0.06], [0, 0, 0.025], C.brass, MET));
    }
    const arcH = 0.92, colR = 0.065, rise = 0.46; // columns, then pointed arches (apex just under the lowest shelves)
    for (let k = 0; k < N; k++) {
      const a = (k / N) * TAU;
      at(d, a, yb, RW - colR - 0.01, () => {
        d.lathe(crisp([[0.11, 0], [0.11, 0.08], [0.085, 0.1]]), [0, 0, 0], C.stone, { seg: 6, ...STN });
        d.lathe([[colR, 0.1], [colR * 0.88, arcH - 0.14], [0.1, arcH - 0.06], [0.12, arcH - 0.04], [0.12, arcH], [0, arcH]], [0, 0, 0], C.stone, { seg: 6, ...STN });
      });
      const mid = ((k + 0.5) / N) * TAU;
      const span = (TAU / N) * RW - 0.2;
      d.geo(bend(extrudeFlat(archMould(span, rise, 0.1, 0.06), 0.09, 6), mid, yb + arcH - 0.02), [0, 0, 0], C.stoneLight, STN);
      const slot = k % 7;
      if (k === 3) door(mid, yb, span);
      else if (slot === 1 || slot === 5) at(d, mid, yb + arcH + 0.12, RW - 0.03, () => banner(d, 0.55, 0.85, T.tapestries[(k >> 1) % T.tapestries.length]));
      else if (slot === 0) at(d, mid, yb, RW - 0.25, () => lectern(true));
      else if (slot === 2) at(d, mid, yb, RW - 0.36, () => chest(d, 0.62, 0.3, 0.38, C.oak, k % 2 === 0, 0.36 - 0.19 - 0.004)); // (room behind it: to the wall's flats)
      else if (slot === 4 && k < 7) at(d, mid, yb, RW - 0.24, () => scrollRack());
      else if (slot === 4) at(d, mid, yb, RW - 0.36, () => d.at([0, 0, 0], [0, 0.3, 0], () => globe(d, 0, 0, 0, 0.3))); // (its ball used to touch the wall)
      else if (slot === 6) at(d, mid, yb, RW - 0.3, () => floorCandelabra(k));
      else if (k === ladderK) {
        // the rolling library ladder: wheels on the floor, hooks over a brass rail high on the wall
        const lh = ladderTop - yb, lean = Math.atan2(0.4, lh);
        // the rail's centre (0.01 out from this frame, lh up) seen from the leaning ladder's foot
        const ry = lh, rz = 0.01 - 0.42;
        const rail = { y: ry * Math.cos(lean) - rz * Math.sin(lean), z: ry * Math.sin(lean) + rz * Math.cos(lean), lean };
        at(d, mid, yb, RW - 0.04, () => d.at([0, 0, 0.42], [-lean, 0, 0], () => ladder(d, Math.hypot(lh, 0.4) - 0.03, rail)));
      }
      // torches between arches
      // (its back plate against the column's face: it used to stand 1.6 cm in front of it)
      if (k % 2 === 0) at(d, a, yb + 0.6, RW - colR - 0.01 - colR * 0.912 + 0.0015, () => sconce(d, true));
    }
    // carpet runner from the door to the fountain
    const doorA = ((3 + 0.5) / N) * TAU;
    at(d, doorA, yb + 0.005, 2.18, () => { // (1 mm higher: the flagstone ring's crest grazed its top)
      d.box([0.7, 0.008, 2.25], [0, 0.004, 0], "#5e1416", { rough: 0.95 });
      for (const s of [-1, 1]) d.box([0.05, 0.009, 2.25], [s * 0.3, 0.005, 0], "#b08a3a", { rough: 0.8 });
    });
    // piles of books and a big globe on the floor
    for (const [a, rr] of [[1.0, 2.7], [4.6, 2.6], [5.6, 2.8]] as P2[]) {
      at(d, a, yb, rr, () => {
        const h = bookPile(d, rnd, 6 + Math.floor(rnd() * 4), true);
        if (rnd() < 0.6) candle(d, 0, h, 0, 0.12, 0.022, true, C.waxOld);
      });
    }
    // tapestries and maps on the wall between the arcade and the lowest shelves
    for (let a = L.a0 + Math.PI * 0.75; a < L.a0 + TAU - 0.2; a += 0.62) {
      if (Math.abs(Math.atan2(Math.sin(a - ladderAz), Math.cos(a - ladderAz))) < 0.5) continue; // the ladder's spot
      const bottom = yb + arcH + rise + 0.05;
      const free = thetaY(a) - 0.09 - bottom;
      // (hung low enough that its cord and nail sit under the cornice, not up inside it)
      if (free > 0.75) at(d, a, bottom + free - 0.155, RW - 0.03, () => banner(d, 0.48, Math.min(0.95, free - 0.16), cyc(T.banners, a * 10)));
      else if (free > 0.3) pinnedSheet(d, a, bottom + free / 2, 0.3, 0.225, cyc(T.maps, a * 7), (rnd() - 0.5) * 0.1);
    }
  }

  mark("base");
  await pause("Filling the fountain…");
  function door(theta: number, yb: number, span: number) {
    const w = Math.min(0.95, span - 0.3), h = 1.18;
    // planks set into the wall, iron straps and studs, a ring handle
    d.geo(bend(extrudeFlat(archFill(w, h, h - w * 0.5), 0.03, 6), theta, yb), [0, 0, 0], C.woodDark, { rough: 0.7 });
    at(d, theta, yb, RW - 0.03, () => {
      for (let x = -w / 2 + 0.1; x < w / 2 - 0.05; x += 0.13) d.box([0.008, h - w * 0.5, 0.008], [x + 0.06, (h - w * 0.5) / 2, 0.002], "#1a0f08");
      for (const y of [0.2, 0.75]) {
        d.box([w - 0.04, 0.05, 0.012], [0, y, 0.008], C.iron, IRN);
        for (let x = -w / 2 + 0.06; x < w / 2 - 0.04; x += 0.1) d.sphere(0.008, [x, y, 0.016], C.iron, { seg: 5, ...IRN });
      }
      ring(d, 0.05, 0.007, [0.25, 0.55, 0.03], C.iron, IRN, [0, 0, 0], TAU, 14);
      d.cyl(0.02, 0.02, 0.012, [0.25, 0.6, 0.012], C.iron, { seg: 8, rot: [Math.PI / 2, 0, 0], ...IRN });
      d.box([w + 0.1, 0.08, 0.2], [0, 0.04, 0.1], C.stone, STN); // threshold step
    });
  }
  function lectern(chained: boolean) {
    d.lathe([[0, 0], [0.2, 0], [0.19, 0.05], [0.1, 0.09], [0.06, 0.14], [0.05, 0.78], [0.08, 0.82], [0.1, 0.88], [0, 0.88]], [0, 0, 0], C.wood, { seg: 8, rough: 0.6 });
    d.at([0, 0.93, 0], [0.45, 0, 0], () => {
      d.box([0.5, 0.025, 0.36], [0, 0, 0], C.wood, { rough: 0.6 });
      d.box([0.5, 0.03, 0.016], [0, 0.02, 0.17], C.wood, { rough: 0.6 });
      d.box([0.42, 0.012, 0.29], [0, 0.018, 0], "#4a1a14", { rough: 0.6 });
      for (const s of [-1, 1]) d.box([0.19, 0.018, 0.27], [s * 0.1, 0.032, 0], C.pageEdge, { rough: 0.9, rot: [0, 0, s * 0.06] });
      d.plane([0.4, 0.27], [0, 0.0425, 0], "#ffffff", { tex: T.pages, rot: [-Math.PI / 2, 0, 0], rough: 0.9 });
      d.box([0.012, 0.002, 0.12], [0.02, 0.044, 0.18], "#8a1414", { rot: [0.5, 0, 0] });
    });
    if (chained) {
      // the chain droops from under the desk's edge to a staple on the post (it used to run off
      // sideways, parallel to the tilted desk, and end in mid-air)
      const tilt = 0.45, ya = -0.0245, za = 0.1; // just under the desk board, in its tilted frame
      const a = new THREE.Vector3(-0.2, 0.93 + ya * Math.cos(tilt) - za * Math.sin(tilt), ya * Math.sin(tilt) + za * Math.cos(tilt));
      const b2 = new THREE.Vector3(-0.056, 0.7, 0), n = 12, v = b2.clone().sub(a).normalize();
      const side = new THREE.Vector3().crossVectors(v, new THREE.Vector3(0, 1, 0)).normalize(), up = new THREE.Vector3().crossVectors(side, v);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, p = a.clone().lerp(b2, t);
        p.y -= 0.03 * Math.sin(Math.PI * t);
        const nrm = i % 2 ? side : up; // alternate links at right angles, each lying along the chain
        const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(v, new THREE.Vector3().crossVectors(nrm, v), nrm));
        d.geo(new THREE.TorusGeometry(0.009, 0.0025, 4, 8), [p.x, p.y, p.z], C.iron, { ...IRN, rot: [e.x, e.y, e.z], scale: [1.5, 1, 1] });
      }
    }
  }
  function scrollRack() {
    const W = 0.72, H = 0.9, Dp = 0.3, n = 4, m = 4;
    d.box([W, 0.04, Dp], [0, 0.02, 0], C.wood, { rough: 0.6 });
    d.box([W, 0.04, Dp], [0, H, 0], C.wood, { rough: 0.6 });
    d.box([W, H, 0.02], [0, H / 2, -Dp / 2], C.woodDark, { rough: 0.6 });
    for (let i = 0; i <= n; i++) d.box([0.025, H, Dp], [-W / 2 + (i * W) / n, H / 2, 0], C.wood, { rough: 0.6 });
    for (let j = 1; j < m; j++) d.box([W, 0.02, Dp], [0, (j * H) / m, 0], C.wood, { rough: 0.6 });
    for (let i = 0; i < n; i++)
      for (let j = 0; j < m; j++) {
        // three scrolls to a cubby, two on its floor and one on top of them (they used to hover
        // 3-6 cm up in the middle of the cubby)
        const cx = -W / 2 + ((i + 0.5) * W) / n, floor = j === 0 ? 0.04 : (j * H) / m + 0.01;
        for (let k = 0; k < 3; k++) {
          const ox = (k - 1) * 0.0215, oy = k === 1 ? 0.02 + 0.0337 : 0.02;
          d.cyl(0.02, 0.02, Dp - 0.04, [cx + ox, floor + oy, 0.0], new THREE.Color(C.parchment).multiplyScalar(0.8 + rnd() * 0.25), { seg: 6, rot: [Math.PI / 2, 0, 0], rough: 0.85 });
        }
      }
  }
  function floorCandelabra(k: number) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + k;
      tube(d, [[0, 0.18, 0], [Math.cos(a) * 0.12, 0.08, Math.sin(a) * 0.12], [Math.cos(a) * 0.2, 0.0, Math.sin(a) * 0.2]], 0.012, C.iron, 6, IRN);
    }
    d.lathe([[0.03, 0.15], [0.025, 0.2], [0.018, 1.1], [0.04, 1.14], [0.02, 1.18], [0, 1.18]], [0, 0, 0], C.iron, { seg: 8, ...IRN });
    ring(d, 0.16, 0.008, [0, 1.2, 0], C.iron, IRN, [Math.PI / 2, 0, 0], TAU, 16);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      const x = Math.cos(a) * 0.16, z = Math.sin(a) * 0.16;
      d.cyl(0.004, 0.004, 0.16, [x / 2, 1.19, z / 2], C.iron, { seg: 4, rot: [0, -a, Math.PI / 2] });
      d.lathe(CUP_P, [x, 1.2, z], C.iron, { seg: 8, ...IRN });
      candle(d, x, 1.212, z, 0.1 + ((i * 37) % 5) * 0.012, 0.014, true);
    }
    candle(d, 0, 1.18, 0, 0.16, 0.018, true);
  }

  // ======================================================================================
  // 3. the top: gallery, lancets, banners, vault, oculus, bell, chandelier
  // ======================================================================================
  const subs: { mesh: THREE.Mesh; update: (t: number) => void }[] = [];
  {
    const rIn = 2.74;
    // the floor slab, a carpet ring, a balustrade
    d.lathe(crisp([[RW, 0], [rIn, 0], [rIn, -0.16], [rIn + 0.05, -0.2], [RW, -0.2]]), [0, yG, 0], C.stone, { seg: 48, ...STN });
    d.lathe([[RW - 0.02, 0.004], [rIn + 0.12, 0.004]], [0, yG, 0], "#5a1416", { seg: 48, rough: 0.95 });
    d.lathe([[rIn + 0.17, 0.006], [rIn + 0.13, 0.006]], [0, yG, 0], "#b08a3a", { seg: 48, rough: 0.8 });
    d.lathe(crisp([[rIn + 0.08, 0], [rIn, 0], [rIn, 0.06], [rIn + 0.08, 0.06]]), [0, yG, 0], C.stoneLight, { seg: 48, ...STN });
    // a wrought-iron railing (see-through, so the gallery's treasures show) between stone newels
    const rr = rIn + 0.035;
    for (const [y, t] of [[0.56, 0.012], [0.47, 0.007], [0.1, 0.007]]) ring(d, rr, t, [0, yG + y, 0], C.iron, IRN, [Math.PI / 2, 0, 0], TAU, 60);
    const nBar = 144;
    for (let k = 0; k < nBar; k++) {
      const a = (k / nBar) * TAU, x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (k % 18 === 0) {
        at(d, a, yG + 0.06, rr, () => {
          d.lathe(crisp([[0.065, 0], [0.065, 0.52], [0.08, 0.55], [0.08, 0.6], [0, 0.6]]), [0, 0, 0], C.stoneLight, { seg: 4, ...STN, rot: [0, Math.PI / 4, 0] });
          d.sphere(0.05, [0, 0.64, 0], C.stoneLight, { seg: 6, ...STN });
        });
        continue;
      }
      d.cyl(0.005, 0.005, 0.5, [x, yG + 0.31, z], C.iron, { seg: 4, open: true, ...IRN });
      if (k % 2 === 0) d.cyl(0, 0.011, 0.05, [x, yG + 0.59, z], C.iron, { seg: 4, open: true, ...IRN });
      if (k % 4 === 2) at(d, ((k + 0.5) / nBar) * TAU, yG + 0.285, rr, () => d.geo(new THREE.TorusGeometry(0.045, 0.004, 3, 8), [0, 0, 0], C.iron, IRN));
    }
    // corbels under the slab
    const corb = new THREE.Shape();
    corb.moveTo(0, 0);
    corb.lineTo(0.5, 0);
    corb.quadraticCurveTo(0.45, -0.1, 0.2, -0.16);
    corb.quadraticCurveTo(0.05, -0.2, 0, -0.32);
    corb.lineTo(0, 0);
    for (let k = 0; k < 24; k++) {
      const a = ((k + 0.5) / 24) * TAU;
      // (not where the top bookcases reach up under the gallery)
      const near = all.some((b) => Math.abs(Math.atan2(Math.sin(b.theta - a), Math.cos(b.theta - a))) < 0.25 && b.y + BAND + 0.15 > yG - 0.52);
      if (!near) at(d, a, yG - 0.2, RW, () => d.geo(extrudeFlat(corb, 0.08, 4), [0.04, 0, 0], C.stone, { ...STN, rot: [0, -Math.PI / 2, 0] }));
    }
    // ivy spilling over the gallery edge and down the wall
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU + rnd() * 0.3;
      // how far down before the top shelves
      const rel = ((((a - L.a1) % TAU) + TAU) % TAU) - TAU; // angle of the highest shelf at this azimuth, relative to a1
      const topShelf = thetaY(L.a1 + rel) + BAND + 0.08;
      const len = Math.min(1.6, yG - 0.2 - topShelf) * (0.6 + rnd() * 0.4);
      if (len > 0.25) ivy(d, rnd, [Math.cos(a) * RW, yG - 0.2, Math.sin(a) * RW], len, a);
    }
    for (let k = 0; k < 10; k++) {
      // tendrils along the balustrade rail
      const a0 = (k / 10) * TAU + rnd() * 0.4;
      const pts: Vec3[] = [];
      for (let i = 0; i <= 6; i++) {
        const a = a0 + i * 0.05;
        const rr = rIn + 0.04 + Math.sin(i * 1.7) * 0.05;
        pts.push([Math.cos(a) * rr, yG + 0.62 - Math.abs(Math.sin(i * 0.9)) * 0.45, Math.sin(a) * rr]);
      }
      tube(d, pts, 0.004, "#3a3018", 12, {}, 3);
      for (const p of pts.slice(1))
        for (let j = 0; j < 3; j++) {
          const s = 0.03 + rnd() * 0.025;
          d.plane([s, s], [p[0] + (rnd() - 0.5) * 0.05, p[1] + (rnd() - 0.5) * 0.06, p[2] + (rnd() - 0.5) * 0.05], "#ffffff", { tex: T.leaf, rot: [rnd() * 6, rnd() * 6, rnd() * 6], rough: 0.7 });
        }
    }
    await pause("Raising the gallery…");
    // furniture on the gallery
    const items = ["telescope", "lectern", "chest", "potionCabinet", "globeBig", "desk", "scrollRack", "armillaryBig", "books", "candelabra", "chestGold", "bust"];
    items.forEach((kind, k) => {
      const a = ((k + 0.25) / items.length) * TAU;
      // (the gold chest stands a little forward so its lid can open against the wall)
      const rr = kind === "chestGold" ? 3.01 : 3.05;
      at(d, a, yG, rr, () => galleryItem(kind, a, yG, rr));
    });
    await pause("Glazing the windows…");
    // stained-glass lancets with banners between them
    const nWin = 8, wy = yG + 0.95, wh = 2.4, ww = 0.62;
    for (let k = 0; k < nWin; k++) {
      const a = (k / nWin) * TAU + 0.2;
      lancet(d, a, wy, ww, wh, T.glass[k % T.glass.length]);
      const ab = a + TAU / nWin / 2;
      at(d, ab, wy + 1.9, RW - 0.04, () => banner(d, 0.42, 1.25, T.banners[k % T.banners.length], 0.04));
      if (k % 2 === 0) ivy(d, rnd, [Math.cos(a + 0.13) * RW, wy + wh * 0.8, Math.sin(a + 0.13) * RW], 0.9 + rnd() * 0.5, a + 0.13, 0.8);
    }
    // string course, gargoyles at the springing of the vault
    const ySpring = wy + wh + 0.35;
    d.lathe(crisp([[RW, -0.06], [RW - 0.12, -0.03], [RW - 0.14, 0.04], [RW - 0.1, 0.07], [RW, 0.07]]), [0, ySpring, 0], C.stoneLight, { seg: 48, ...STN });
    for (let k = 0; k < 8; k++) at(d, (k / 8) * TAU + 0.2 + TAU / 16, ySpring - 0.05, RW, () => gargoyle());
    // the vault: painted blue with gold stars (Sainte-Chapelle), ribs, an oculus full of night sky
    const rOc = 1.15, yOc = yCeil - 0.06;
    const vault: P2[] = [];
    for (let i = 0; i <= 8; i++) {
      const u = i / 8; // 0 at the oculus, 1 at the wall
      const ang = u * (Math.PI / 2);
      vault.push([rOc + (RW - rOc) * Math.sin(ang), ySpring + 0.07 + (yOc - ySpring - 0.07) * Math.cos(ang)]);
    }
    d.lathe(vault, [0, 0, 0], "#ffffff", { seg: 32, tex: T.vault, glow: 0.1, rough: 0.8 });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU + 0.2;
      const pts: Vec3[] = vault.map(([rr, y]) => [Math.cos(a) * (rr - 0.04), y - 0.04, Math.sin(a) * (rr - 0.04)]);
      tube(d, pts.reverse(), 0.05, C.stoneLight, 12, STN, 5);
    }
    d.torus(rOc, 0.08, [0, yOc, 0], C.stoneLight, { seg: 32, rot: [Math.PI / 2, 0, 0], ...STN });
    d.torus(rOc - 0.07, 0.02, [0, yOc - 0.05, 0], C.gold, { seg: 32, rot: [Math.PI / 2, 0, 0], ...MET });
    d.plane([2 * rOc + 0.1, 2 * rOc + 0.1], [0, yCeil - 0.01, 0], "#ffffff", { tex: T.sky, rot: [Math.PI / 2, 0, 0], glow: 0.9, rough: 1 });
    // the bell, hung from a beam across the oculus
    d.box([2 * rOc + 0.3, 0.14, 0.16], [0, yOc - 0.02, 0], C.woodDark, { rough: 0.7 });
    d.box([0.3, 0.12, 0.2], [0, yOc - 0.14, 0], C.woodDark, { rough: 0.7 });
    const bellTop = yOc - 0.2;
    d.lathe(
      [[0.0, -0.06], [0.14, -0.06], [0.27, -0.12], [0.31, -0.2], [0.33, -0.55], [0.4, -0.66], [0.42, -0.7], [0.36, -0.69], [0.28, -0.6], [0.24, -0.2], [0.12, -0.08], [0.0, -0.04]].reverse() as P2[],
      [0, bellTop, 0],
      C.bronze,
      { seg: 20, metal: 0.6, rough: 0.35 },
    );
    d.lathe([[0.15, -0.06], [0.16, -0.02], [0.12, 0.0], [0, 0]], [0, bellTop, 0], C.bronze, { seg: 12, ...MET });
    d.cyl(0.012, 0.012, 0.5, [0, bellTop - 0.3, 0], C.iron, { seg: 6, ...IRN });
    d.sphere(0.06, [0, bellTop - 0.58, 0], C.iron, { seg: 10, ...IRN });
    d.tube([[0.013, bellTop - 0.42, 0], [0.5, bellTop - 0.9, 0.05], [0.55, bellTop - 1.6, 0.0], [0.6, bellTop - 2.2, 0.05]], 0.01, "#8a7050", { seg: 20 }); // bell rope (tied to the clapper's shaft)

    await pause("Painting the stars…");
    // the great chandelier (sways gently): an iron wheel of candles on four chains from the oculus ring
    const ch = d.sub();
    const yRing = yG + 2.3;
    const drop = yOc - yRing;
    const Rc = 1.0;
    ring(ch, Rc, 0.035, [0, -drop, 0], C.iron, IRN, [Math.PI / 2, 0, 0], TAU, 40);
    ring(ch, Rc - 0.09, 0.015, [0, -drop + 0.06, 0], C.iron, IRN, [Math.PI / 2, 0, 0], TAU, 40);
    ring(ch, 0.18, 0.025, [0, -drop + 0.02, 0], C.iron, IRN, [Math.PI / 2, 0, 0], TAU, 16);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      tube(ch, [[Math.cos(a) * 0.18, -drop + 0.02, Math.sin(a) * 0.18], [Math.cos(a) * 0.6, -drop - 0.06, Math.sin(a) * 0.6], [Math.cos(a) * Rc, -drop, Math.sin(a) * Rc]], 0.01, C.iron, 8, IRN);
    }
    ch.lathe([[0, -0.2], [0.05, -0.12], [0.08, 0], [0.04, 0.08], [0, 0.1]], [0, -drop - 0.12, 0], C.iron, { seg: 8, ...IRN }); // pendant boss
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU + 0.1;
      const x = Math.cos(a) * Rc, z = Math.sin(a) * Rc;
      ch.lathe(PAN_P, [x, -drop + 0.035, z], C.iron, { seg: 8, ...IRN });
      candle(ch, x, -drop + 0.048, z, 0.1 + ((k * 7) % 4) * 0.02, 0.016, true);
      ch.cyl(0, 0.012, 0.05, [x, -drop - 0.06, z], C.iron, { seg: 4, rot: [Math.PI, 0, 0], ...IRN }); // drip spike
    }
    for (let q = 0; q < 4; q++) {
      const a = (q / 4) * TAU + Math.PI / 4;
      const x0 = Math.cos(a) * Rc, z0 = Math.sin(a) * Rc;
      const x1 = Math.cos(a) * (rOc - 0.02), z1 = Math.sin(a) * (rOc - 0.02);
      const n = Math.floor(drop / 0.11);
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n;
        ch.geo(new THREE.TorusGeometry(0.034, 0.006, 3, 6), [x0 + (x1 - x0) * u, -drop + drop * u, z0 + (z1 - z0) * u], C.iron, { ...IRN, rot: [0, a + (i % 2 ? Math.PI / 2 : 0), 0], scale: [1, 1.7, 1] });
      }
    }
    const chMesh = ch.build("stacks-chandelier");
    chMesh.position.set(0, yOc, 0);
    subs.push({
      mesh: chMesh,
      update: (t) => {
        chMesh.rotation.x = Math.sin(t * 0.37) * 0.012;
        chMesh.rotation.z = Math.sin(t * 0.29 + 1.3) * 0.012;
      },
    });

    function galleryItem(kind: string, a: number, y: number, rr: number) {
      if (kind === "telescope") {
        // (a tripod whose feet all land on the gallery floor: one used to stand in the wall)
        for (let i = 0; i < 3; i++) {
          const la = (i / 3) * TAU;
          d.tube([[0, 1.0, 0], [Math.cos(la) * 0.28, 0, Math.sin(la) * 0.28]], 0.012, C.oak, { seg: 1 });
        }
        d.cyl(0.04, 0.04, 0.06, [0, 1.0, 0], C.brass, { seg: 10, ...MET });
        // the tube points up at the oculus (it used to lean back into the stained glass behind it)
        d.at([0, 1.04, 0], [0.6, 0, 0], () => {
          d.lathe([[0, -0.35], [0.022, -0.35], [0.022, -0.2], [0.03, -0.2], [0.03, 0.05], [0.038, 0.05], [0.042, 0.42], [0.05, 0.44], [0.05, 0.47], [0, 0.47]], [0, 0, 0], C.brass, { seg: 12, ...MET });
          d.cyl(0.039, 0.039, 0.18, [0, 0.0, 0], "#3a2416", { seg: 12, rough: 0.6 });
        });
      } else if (kind === "lectern") lectern(true);
      else if (kind === "chest") chest(d, 0.62, 0.3, 0.38, C.wood, false);
      else if (kind === "chestGold") {
        chest(d, 0.6, 0.3, 0.36, C.oak, true, RW - 0.004 - (rr + 0.18));
        // spilled gold on the rug either side (in front there's only the balustrade's kerb: they
        // used to lie out past the gallery's edge, over the drop)
        const side = (u: number, lo: number, hi: number) => Math.sign(u - 0.5 || 1) * (lo + Math.abs(u - 0.5) * 2 * (hi - lo));
        for (let i = 0; i < 14; i++) d.cyl(0.014, 0.014, 0.004, [side(rnd(), 0.33, 0.55), 0.0075, -0.14 + rnd() * 0.3], C.gold, { seg: 8, ...MET, rot: [(rnd() - 0.5) * 0.4, 0, (rnd() - 0.5) * 0.4] });
        for (let i = 0; i < 4; i++) d.geo(new THREE.OctahedronGeometry(0.018), [side(rnd(), 0.34, 0.5), 0.016, -0.1 + rnd() * 0.2], pick(rnd, ["#c01830", "#18a040", "#2050d0"]), { rough: 0.1, metal: 0.2 });
      } else if (kind === "potionCabinet") {
        const W = 0.62, H = 1.05, Dp = 0.26;
        d.box([W, H, 0.02], [0, H / 2, -Dp / 2], C.woodDark, { rough: 0.6 });
        for (const s of [-1, 1]) d.box([0.03, H, Dp], [s * (W / 2 - 0.015), H / 2, 0], C.wood, { rough: 0.6 });
        d.box([W + 0.06, 0.04, Dp + 0.04], [0, H + 0.02, 0.01], C.wood, { rough: 0.6 });
        for (let j = 0; j < 4; j++) {
          const sy = 0.04 + j * 0.25;
          d.box([W - 0.04, 0.02, Dp], [0, sy, 0], C.wood, { rough: 0.6 });
          if (j === 3) break;
          for (let i = 0; i < 4; i++) bottle(d, -W / 2 + 0.09 + i * 0.145 + (rnd() - 0.5) * 0.02, sy + 0.01, (rnd() - 0.5) * 0.06, Math.floor(rnd() * BOTTLES.length), pick(rnd, GLASS), 1 + rnd() * 0.4, rnd() < 0.25 ? 0.35 : 0);
        }
      } else if (kind === "globeBig") {
        d.lathe([[0, 0], [0.22, 0], [0.2, 0.04], [0.06, 0.1], [0.05, 0.45], [0.09, 0.5], [0.05, 0.56], [0, 0.56]], [0, 0, 0], C.oak, { seg: 10 });
        d.torus(0.3, 0.012, [0, 0.82, 0], C.brass, { seg: 32, rot: [Math.PI / 2, 0, 0], ...MET }); // horizon ring
        for (const s of [-1, 1]) d.box([0.02, 0.3, 0.02], [s * 0.3, 0.67, 0], C.oak);
        d.box([0.62, 0.022, 0.022], [0, 0.52, 0], C.oak); // (a cross-bar through the stem: the ring's legs used to stop in mid-air)
        ring(d, 0.29, 0.008, [0, 0.82, 0], C.brass, MET, [0, 0, 0.41], TAU, 28);
        // the sphere itself turns
        const gs = d.sub();
        gs.sphere(0.26, [0, 0, 0], "#ffffff", { seg: 24, tex: T.globe, rough: 0.5 });
        const gm = gs.build("stacks-globe");
        const ga = new THREE.Group();
        const w = new THREE.Vector3(Math.cos(a) * rr, y + 0.82, Math.sin(a) * rr);
        ga.position.copy(w);
        ga.rotation.set(0, Math.atan2(-Math.cos(a), -Math.sin(a)), 0.41);
        ga.add(gm);
        c.scene.add(ga);
        subs.push({ mesh: gm, update: (t) => (gm.rotation.y = t * 0.15) });
      } else if (kind === "desk") {
        d.box([0.9, 0.04, 0.45], [0, 0.74, 0], C.oak, { rough: 0.55 });
        for (const sx of [-1, 1])
          for (const sz of [-1, 1]) d.lathe([[0.03, 0], [0.025, 0.2], [0.04, 0.3], [0.022, 0.45], [0.03, 0.72], [0, 0.72]], [sx * 0.4, 0, sz * 0.18], C.woodDark, { seg: 6 });
        d.box([0.84, 0.1, 0.02], [0, 0.67, 0.21], C.woodDark);
        d.at([-0.1, 0.76, 0.02], [0, 0.1, 0], () => d.plane([0.36, 0.27], [0, 0.001, 0], "#ffffff", { tex: T.maps[0], rot: [-Math.PI / 2, 0, 0], rough: 0.9 }));
        d.at([0.28, 0.76, -0.05], null, () => inkAndQuill(d, rnd));
        d.at([0.3, 0.76, -0.12], null, () => candlestick(d, 0, 0, 0, 0.14, 0.1, true));
        d.at([-0.3, 0.76, -0.1], [0, 0.4, 0], () => skull(d, 0, 0, 0, 1.2));
        // a chair, pulled round to the end of the desk (there's no room in front of it: the chair
        // used to stand out past the balustrade, over the drop)
        d.at([0.72, 0, 0], [0, -Math.PI / 2 - 0.2, 0], () => {
          d.box([0.42, 0.04, 0.4], [0, 0.46, 0], C.woodDark);
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) d.box([0.035, 0.46, 0.035], [sx * 0.18, 0.23, sz * 0.17], C.woodDark);
          d.box([0.42, 0.5, 0.035], [0, 0.73, -0.19], C.woodDark);
          d.box([0.34, 0.36, 0.02], [0, 0.72, -0.17], "#5a1416", { rough: 0.95 });
        });
      } else if (kind === "scrollRack") scrollRack();
      else if (kind === "armillaryBig") {
        d.lathe([[0, 0], [0.2, 0], [0.18, 0.05], [0.06, 0.12], [0.04, 0.7], [0.08, 0.74], [0, 0.74]], [0, 0, 0], C.bronze, { seg: 10, ...MET });
        const am = d.sub();
        armillaryRings(am, 0.24);
        const m = am.build("stacks-armillary");
        m.position.set(Math.cos(a) * rr, y + 0.74 + 0.24, Math.sin(a) * rr);
        c.scene.add(m);
        subs.push({ mesh: m, update: (t) => (m.rotation.y = t * 0.12) });
      } else if (kind === "books") {
        for (let i = 0; i < 3; i++) d.at([(i - 1) * 0.24, 0, (rnd() - 0.5) * 0.15], [0, rnd() * 3, 0], () => bookPile(d, rnd, 4 + Math.floor(rnd() * 5)));
      } else if (kind === "candelabra") floorCandelabra(3);
      else if (kind === "bust") {
        d.lathe(crisp([[0, 0], [0.18, 0], [0.18, 0.06], [0.13, 0.1], [0.13, 0.9], [0.17, 0.94], [0.17, 1.0], [0, 1.0]]), [0, 0, 0], C.stoneLight, { seg: 8, ...STN });
        d.at([0, 1.0, 0], null, () => bust(d, 2.4, "#6a4a26"));
      }
    }
  }

  mark("top");
  function gargoyle() {
    // a crouching grotesque on a corbel, leering down into the tower
    d.box([0.16, 0.08, 0.26], [0, -0.04, 0.13], C.stone, STN);
    d.at([0, 0.0, 0.2], [0.3, 0, 0], () => {
      d.sphere(1, [0, 0.07, 0], C.stoneDark, { seg: 7, scale: [0.07, 0.08, 0.09], ...STN });
      d.sphere(0.055, [0, 0.12, 0.09], C.stoneDark, { seg: 6, ...STN });
      d.box([0.06, 0.03, 0.05], [0, 0.095, 0.14], C.stoneDark, STN); // snout
      for (const s of [-1, 1]) {
        d.cyl(0, 0.014, 0.07, [s * 0.04, 0.18, 0.08], C.stoneDark, { seg: 4, rot: [-0.4, 0, -s * 0.5], ...STN }); // horns
        d.sphere(0.008, [s * 0.022, 0.135, 0.135], "#120c08", { seg: 4 }); // eyes
        d.box([0.025, 0.07, 0.025], [s * 0.05, 0.02, 0.07], C.stoneDark, STN); // forelegs
        const wing = new THREE.Shape();
        wing.moveTo(0, 0);
        wing.lineTo(0.16, 0.08);
        wing.lineTo(0.12, 0.02);
        wing.lineTo(0.15, -0.02);
        wing.lineTo(0.08, -0.03);
        wing.lineTo(0, 0);
        d.geo(extrudeFlat(wing, 0.012, 2), [s * 0.05, 0.1, -0.02], C.stoneDark, { ...STN, rot: [0, s > 0 ? -0.5 : Math.PI + 0.5, 0.2] });
      }
    });
  }

  // ---- build ---------------------------------------------------------------------------------
  const subTris = subs.reduce((n, s) => n + s.mesh.geometry.index!.count / 3, 0);
  tally.push(`moving ${(subTris / 1000).toFixed(1)}k`);
  await pause("Hanging the chandelier…");
  const mesh = d.build("stacks-decor");
  c.scene.add(mesh);
  for (const s of subs) if (!s.mesh.parent) c.scene.add(s.mesh);
  c.onUpdate((_, t) => {
    for (const s of subs) s.update(t);
  });
  busy += performance.now() - tSlice;
  worst = Math.max(worst, performance.now() - tSlice);
  console.info(
    `[stacks] decor: ${Math.round((d.triangles + subTris) / 1000)}k triangles (${tally.join(", ")}), ${subs.length} moving parts; ` +
      `${Math.round(busy)}ms of work in slices of ≤${Math.round(worst)}ms over ${Math.round(performance.now() - t0)}ms`,
  );
  return { mesh, triangles: d.triangles + subTris };
}

/** A flat end cap for a helixSweep of `profile`, at angle `a`, facing along (+1) or against (−1) the sweep. */
function profileCap(profile: P2[], a: number, y: number, out: number) {
  const pts = profile.filter((p, i) => i === 0 || p[0] !== profile[i - 1][0] || p[1] !== profile[i - 1][1]);
  const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([r, dy]) => new THREE.Vector2(r, dy))));
  const P = g.getAttribute("position") as THREE.BufferAttribute, N = g.getAttribute("normal") as THREE.BufferAttribute;
  const co = Math.cos(a), si = Math.sin(a);
  for (let i = 0; i < P.count; i++) {
    const u = P.getX(i), v = P.getY(i);
    P.setXYZ(i, co * u, y + v, si * u);
    N.setXYZ(i, -si * out, 0, co * out);
  }
  // (a shape faces +z, which lands on +tangent here: flip the other end)
  const idx = g.index?.array;
  if (out < 0 && idx) for (let i = 0; i < idx.length; i += 3) [idx[i], idx[i + 1]] = [idx[i + 1], idx[i]];
  return g;
}

/** Sweep a [radius, dy] profile along the helix y = thetaY(a): a carved band that follows the stair. */
function helixSweep(profile: P2[], a0: number, a1: number, step: number, thetaY: (a: number) => number) {
  const n = Math.max(1, Math.ceil((a1 - a0) / step)), m = profile.length;
  const pos = new Float32Array((n + 1) * m * 3), uv = new Float32Array((n + 1) * m * 2);
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n, co = Math.cos(a), si = Math.sin(a), y = thetaY(a);
    for (let j = 0; j < m; j++) {
      const [r, dy] = profile[j];
      pos.set([co * r, y + dy, si * r], (i * m + j) * 3);
      uv.set([i / n, j / (m - 1)], (i * m + j) * 2);
    }
  }
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m - 1; j++) {
      const a = i * m + j, b = (i + 1) * m + j, c2 = i * m + j + 1, e = (i + 1) * m + j + 1;
      idx.push(a, b, c2, b, e, c2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ============================================================================================
// canvas art (drawn once into the builder's atlas)
// ============================================================================================
function drawArt(d: DecorBuilder) {
  let s = 99;
  const r = () => rand(s++);
  const leaf = d.canvas(64, 64, (c) => {
    const pts: P2[] = [[32, 3], [46, 14], [60, 20], [54, 34], [60, 46], [44, 50], [32, 61], [20, 50], [4, 46], [10, 34], [4, 20], [18, 14]];
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i <= pts.length; i++) {
      const p = pts[i % pts.length], q = pts[(i - 1) % pts.length];
      const inner = i % 2 === 1;
      const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
      c.quadraticCurveTo(inner ? mx + (32 - mx) * 0.25 : mx, inner ? my + (36 - my) * 0.25 : my, p[0], p[1]);
    }
    const g = c.createRadialGradient(32, 36, 4, 32, 36, 32);
    g.addColorStop(0, "#5f8a3a");
    g.addColorStop(1, "#24461c");
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = "#9ab868";
    c.lineWidth = 1.6;
    for (const [x, y] of [[32, 6], [58, 21], [58, 45], [6, 45], [6, 21]] as P2[]) {
      c.beginPath();
      c.moveTo(32, 50);
      c.lineTo(x, y);
      c.stroke();
    }
  });
  const web = d.canvas(128, 128, (c) => {
    c.strokeStyle = "rgba(225,225,232,1)";
    c.lineWidth = 2.2;
    const spokes = 7;
    const ang = (i: number) => (i / (spokes - 1)) * (Math.PI / 2);
    for (let i = 0; i < spokes; i++) {
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(Math.cos(ang(i)) * 180, Math.sin(ang(i)) * 180);
      c.stroke();
    }
    for (let k = 1; k < 9; k++) {
      const rr = k * 14 + k * k * 0.6;
      c.beginPath();
      for (let i = 0; i < spokes; i++) {
        const x = Math.cos(ang(i)) * rr, y = Math.sin(ang(i)) * rr;
        if (i === 0) c.moveTo(x, y);
        else {
          const am = (ang(i) + ang(i - 1)) / 2;
          c.quadraticCurveTo(Math.cos(am) * rr * 0.86, Math.sin(am) * rr * 0.86, x, y);
        }
      }
      c.stroke();
    }
  });
  const globe = d.canvas(256, 128, (c, w, h) => {
    c.fillStyle = "#3d6466";
    c.fillRect(0, 0, w, h);
    for (let k = 0; k < 9; k++) {
      const cx = r() * w, cy = h * (0.2 + r() * 0.6), rad = 12 + r() * 26;
      c.beginPath();
      for (let i = 0; i <= 14; i++) {
        const a = (i / 14) * TAU, rr = rad * (0.6 + r() * 0.6);
        const x = cx + Math.cos(a) * rr * 1.4, y = cy + Math.sin(a) * rr;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.closePath();
      c.fillStyle = "#d8c28c";
      c.fill();
      c.strokeStyle = "#6a4a26";
      c.lineWidth = 1.5;
      c.stroke();
    }
    c.strokeStyle = "rgba(60,40,20,0.35)";
    c.lineWidth = 1;
    for (let i = 1; i < 12; i++) {
      c.beginPath();
      c.moveTo((i * w) / 12, 0);
      c.lineTo((i * w) / 12, h);
      c.stroke();
    }
    for (let j = 1; j < 6; j++) {
      c.beginPath();
      c.moveTo(0, (j * h) / 6);
      c.lineTo(w, (j * h) / 6);
      c.stroke();
    }
  });
  const scribble = (c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, gap: number, col: string) => {
    c.fillStyle = col;
    for (let y = y0; y < y1; y += gap) {
      let x = x0;
      while (x < x1 - 4) {
        const wl = 3 + r() * 9;
        c.fillRect(x, y, Math.min(wl, x1 - x), Math.max(1, gap * 0.35));
        x += wl + 2 + r() * 2;
      }
    }
  };
  const pages = d.canvas(192, 128, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, "#d9c79c");
    g.addColorStop(0.45, "#efe2bf");
    g.addColorStop(0.5, "#b9a57c");
    g.addColorStop(0.55, "#efe2bf");
    g.addColorStop(1, "#d9c79c");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#9a1c18";
    c.fillRect(10, 10, 18, 18);
    c.fillStyle = "#d8a840";
    c.fillRect(14, 14, 10, 10);
    scribble(c, 32, 12, 88, 28, 5, "rgba(50,30,18,0.85)");
    scribble(c, 10, 34, 88, 118, 5, "rgba(50,30,18,0.85)");
    c.strokeStyle = "rgba(120,40,20,0.9)";
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(140, 44, 26, 0, TAU);
    c.stroke();
    for (let i = 0; i < 8; i++) {
      c.beginPath();
      c.moveTo(140, 44);
      c.lineTo(140 + Math.cos((i * TAU) / 8) * 26, 44 + Math.sin((i * TAU) / 8) * 26);
      c.stroke();
    }
    scribble(c, 104, 80, 182, 118, 5, "rgba(50,30,18,0.85)");
  });
  const letter = d.canvas(64, 80, (c, w, h) => {
    c.fillStyle = "#e6d6ac";
    c.fillRect(0, 0, w, h);
    scribble(c, 6, 8, w - 6, h - 12, 5, "rgba(40,24,14,0.8)");
    c.fillStyle = "rgba(90,60,30,0.35)";
    c.fillRect(0, h - 3, w, 3);
  });
  const tabby = d.canvas(64, 32, (c, w, h) => {
    c.fillStyle = "#c8783c";
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#8a4a1e";
    for (let i = 0; i < 9; i++) {
      const x = (i / 9) * w + 2;
      c.beginPath();
      c.moveTo(x, 0);
      c.quadraticCurveTo(x + 4, h / 2, x, h);
      c.lineTo(x + 3, h);
      c.quadraticCurveTo(x + 7, h / 2, x + 3, 0);
      c.fill();
    }
    c.fillStyle = "#ead8c0";
    c.fillRect(0, h * 0.82, w, h * 0.18);
  });

  // heraldry
  const FIELDS: [string, string][] = [["#7a1418", "#d8aa48"], ["#1c2a6a", "#d8d4c8"], ["#1d4a28", "#d8aa48"], ["#4a1c5a", "#d8d4c8"], ["#1a1a1a", "#d8aa48"], ["#8a2a14", "#e8e0cc"]];
  const charge = (c: CanvasRenderingContext2D, kind: number, x: number, y: number, s: number, col: string) => {
    c.fillStyle = col;
    c.strokeStyle = col;
    c.beginPath();
    if (kind === 0) {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? s * 0.4 : s;
        c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      c.fill();
    } else if (kind === 1) {
      // crown
      c.moveTo(x - s, y + s * 0.5);
      c.lineTo(x - s, y - s * 0.4);
      c.lineTo(x - s * 0.5, y + s * 0.05);
      c.lineTo(x, y - s * 0.7);
      c.lineTo(x + s * 0.5, y + s * 0.05);
      c.lineTo(x + s, y - s * 0.4);
      c.lineTo(x + s, y + s * 0.5);
      c.fill();
    } else if (kind === 2) {
      // open book
      c.moveTo(x, y - s * 0.4);
      c.quadraticCurveTo(x - s * 0.5, y - s * 0.7, x - s, y - s * 0.5);
      c.lineTo(x - s, y + s * 0.5);
      c.quadraticCurveTo(x - s * 0.5, y + s * 0.3, x, y + s * 0.6);
      c.quadraticCurveTo(x + s * 0.5, y + s * 0.3, x + s, y + s * 0.5);
      c.lineTo(x + s, y - s * 0.5);
      c.quadraticCurveTo(x + s * 0.5, y - s * 0.7, x, y - s * 0.4);
      c.fill();
    } else if (kind === 3) {
      // key
      c.lineWidth = s * 0.22;
      c.arc(x, y - s * 0.55, s * 0.35, 0, TAU);
      c.stroke();
      c.fillRect(x - s * 0.1, y - s * 0.25, s * 0.2, s * 1.2);
      c.fillRect(x, y + s * 0.55, s * 0.4, s * 0.16);
      c.fillRect(x, y + s * 0.8, s * 0.3, s * 0.16);
    } else if (kind === 4) {
      // tower
      c.fillRect(x - s * 0.5, y - s * 0.4, s, s * 1.3);
      for (let i = 0; i < 3; i++) c.fillRect(x - s * 0.6 + i * s * 0.45, y - s * 0.75, s * 0.3, s * 0.4);
    } else {
      // sun
      c.arc(x, y, s * 0.45, 0, TAU);
      c.fill();
      c.lineWidth = s * 0.1;
      for (let i = 0; i < 12; i++) {
        const a = (i * TAU) / 12;
        c.beginPath();
        c.moveTo(x + Math.cos(a) * s * 0.6, y + Math.sin(a) * s * 0.6);
        c.lineTo(x + Math.cos(a) * s, y + Math.sin(a) * s);
        c.stroke();
      }
    }
  };
  const ordinary = (c: CanvasRenderingContext2D, k: number, w: number, h: number, col: string) => {
    c.fillStyle = col;
    c.beginPath();
    if (k === 0) {
      c.moveTo(0, h * 0.75);
      c.lineTo(w / 2, h * 0.42);
      c.lineTo(w, h * 0.75);
      c.lineTo(w, h * 0.9);
      c.lineTo(w / 2, h * 0.57);
      c.lineTo(0, h * 0.9);
    } else if (k === 1) c.rect(w * 0.38, 0, w * 0.24, h);
    else if (k === 2) c.rect(0, h * 0.4, w, h * 0.18);
    else if (k === 3) {
      c.moveTo(0, 0);
      c.lineTo(w * 0.22, 0);
      c.lineTo(w, h * 0.78);
      c.lineTo(w, h);
      c.lineTo(w * 0.78, h);
      c.lineTo(0, h * 0.22);
    } else if (k === 4) {
      c.rect(0, 0, w / 2, h / 2);
      c.rect(w / 2, h / 2, w / 2, h / 2);
    }
    c.fill();
  };
  const banners = FIELDS.map(([f, m], k) =>
    d.canvas(96, 224, (c, w, h) => {
      const body = h - 34;
      c.save();
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(w, 0);
      c.lineTo(w, body);
      if (k % 2) {
        c.lineTo(w / 2, h - 2);
      } else {
        c.lineTo(w * 0.72, h - 2);
        c.lineTo(w / 2, body - 4);
        c.lineTo(w * 0.28, h - 2);
      }
      c.lineTo(0, body);
      c.closePath();
      c.clip();
      c.fillStyle = f;
      c.fillRect(0, 0, w, h);
      ordinary(c, k % 5, w, body, m === "#d8aa48" ? "rgba(216,170,72,0.85)" : "rgba(216,212,200,0.8)");
      charge(c, k, w / 2, body * 0.3, 22, m);
      // woven texture + gilt border
      c.fillStyle = "rgba(0,0,0,0.12)";
      for (let y = 0; y < h; y += 3) c.fillRect(0, y, w, 1);
      c.strokeStyle = "#d8aa48";
      c.lineWidth = 6;
      c.stroke();
      c.restore();
      c.fillStyle = "#d8aa48";
      c.fillRect(0, 0, w, 8);
    }),
  );
  const shields = [0, 1, 2, 3].map((k) =>
    d.canvas(64, 80, (c, w, h) => {
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(w, 0);
      c.lineTo(w, h * 0.45);
      c.quadraticCurveTo(w * 0.95, h * 0.82, w / 2, h);
      c.quadraticCurveTo(w * 0.05, h * 0.82, 0, h * 0.45);
      c.closePath();
      c.save();
      c.clip();
      const [f, m] = FIELDS[(k * 2 + 1) % FIELDS.length];
      c.fillStyle = f;
      c.fillRect(0, 0, w, h);
      ordinary(c, (k + 2) % 5, w, h, m);
      charge(c, (k + 3) % 6, w / 2, h * 0.32, 13, m);
      c.restore();
      c.strokeStyle = "#c8a048";
      c.lineWidth = 5;
      c.stroke();
    }),
  );
  const tapestries = [0, 1].map((k) =>
    d.canvas(160, 272, (c, w, h) => {
      const body = h - 16;
      c.fillStyle = k === 0 ? "#1f3a24" : "#1a2450";
      c.fillRect(0, 0, w, body);
      if (k === 0) {
        // millefleurs and a tree of life
        for (let i = 0; i < 160; i++) {
          const x = r() * w, y = r() * body;
          c.fillStyle = pick(r, ["#c84a3a", "#e8dcc0", "#d8b048", "#5a7ac8", "#8ac060"]);
          for (let p = 0; p < 5; p++) c.fillRect(x + Math.cos((p * TAU) / 5) * 2.5, y + Math.sin((p * TAU) / 5) * 2.5, 2, 2);
        }
        c.strokeStyle = "#6a4422";
        c.lineWidth = 9;
        c.beginPath();
        c.moveTo(w / 2, body - 30);
        c.lineTo(w / 2, 90);
        c.stroke();
        c.lineWidth = 4;
        for (let i = 0; i < 6; i++) {
          const y = 90 + i * 22, s2 = i % 2 ? 1 : -1;
          c.beginPath();
          c.moveTo(w / 2, y + 20);
          c.quadraticCurveTo(w / 2 + s2 * 30, y, w / 2 + s2 * 50, y - 10);
          c.stroke();
        }
        for (let i = 0; i < 26; i++) {
          const a = r() * TAU, rr = r() * 52;
          c.fillStyle = r() < 0.75 ? "#3d6e2e" : "#d8a840";
          c.beginPath();
          c.arc(w / 2 + Math.cos(a) * rr, 92 + Math.sin(a) * rr * 0.85, r() < 0.75 ? 10 : 5, 0, TAU);
          c.fill();
        }
      } else {
        // a zodiac wheel with the sun at its heart
        const cx = w / 2, cy = body * 0.48;
        c.strokeStyle = "#d8aa48";
        c.lineWidth = 3;
        for (const rr of [64, 48]) {
          c.beginPath();
          c.arc(cx, cy, rr, 0, TAU);
          c.stroke();
        }
        for (let i = 0; i < 12; i++) {
          const a = (i * TAU) / 12;
          c.beginPath();
          c.moveTo(cx + Math.cos(a) * 48, cy + Math.sin(a) * 48);
          c.lineTo(cx + Math.cos(a) * 64, cy + Math.sin(a) * 64);
          c.stroke();
          const am = a + TAU / 24;
          charge(c, i % 6, cx + Math.cos(am) * 56, cy + Math.sin(am) * 56, 5, "#e8dcc0");
        }
        charge(c, 5, cx, cy, 30, "#e0a838");
        for (let i = 0; i < 70; i++) {
          c.fillStyle = "#e8dcc0";
          c.fillRect(r() * w, r() * body, 2, 2);
        }
      }
      // border and fringe
      c.strokeStyle = "#8a1c1c";
      c.lineWidth = 12;
      c.strokeRect(6, 6, w - 12, body - 12);
      c.strokeStyle = "#d8aa48";
      c.lineWidth = 2;
      c.strokeRect(9, 9, w - 18, body - 18);
      c.fillStyle = "#c8a048";
      for (let x = 4; x < w - 4; x += 6) c.fillRect(x, body, 3, 10 + (x % 12 ? 2 : 6));
    }),
  );
  const ROSES = [["#1f3a9a", "#c8202c", "#d8b040"], ["#7a1428", "#2a62c8", "#e0c050"], ["#1a6a5a", "#d8a030", "#c84020"]];
  const roses = ROSES.map(([a, b2, g]) =>
    d.canvas(128, 128, (c, w) => {
      const cx = w / 2;
      c.beginPath();
      c.arc(cx, cx, cx - 1, 0, TAU);
      c.fillStyle = "#101010";
      c.fill();
      for (let i = 0; i < 12; i++) {
        const a0 = (i * TAU) / 12, a1 = ((i + 1) * TAU) / 12;
        c.beginPath();
        c.moveTo(cx, cx);
        c.arc(cx, cx, cx - 6, a0 + 0.04, a1 - 0.04);
        c.closePath();
        c.fillStyle = i % 2 ? a : b2;
        c.fill();
      }
      for (let i = 0; i < 6; i++) {
        const a = (i * TAU) / 6;
        c.beginPath();
        c.arc(cx + Math.cos(a) * 26, cx + Math.sin(a) * 26, 14, 0, TAU);
        c.fillStyle = g;
        c.fill();
        c.lineWidth = 3;
        c.strokeStyle = "#101010";
        c.stroke();
      }
      c.beginPath();
      c.arc(cx, cx, 14, 0, TAU);
      c.fillStyle = "#e8e0c8";
      c.fill();
      c.stroke();
    }),
  );
  const GLASS_C = [["#2a5ab8", "#c82830", "#e0b040"], ["#7a1a6a", "#2a8a5a", "#e0b040"], ["#1a3a8a", "#e07a20", "#d8d0b0"], ["#2a6a9a", "#a82838", "#e8c860"]];
  const glass = GLASS_C.map(([main, acc, gold], k) =>
    d.canvas(128, 320, (c, w, h) => {
      // the window's outline is cut by the geometry; here: quarries, a border, a medallion
      c.fillStyle = "#121212";
      c.fillRect(0, 0, w, h);
      // diamond quarries (leaded lattice)
      const q = 18, lw = 1.1;
      for (let row = -2; (row * q) / 2 < h + q; row++)
        for (let x = -q; x < w + q; x += q) {
          const y = (row * q) / 2, ox = row % 2 ? q / 2 : 0;
          c.beginPath();
          c.moveTo(x + ox, y - q / 2 + lw);
          c.lineTo(x + ox + q / 2 - lw, y);
          c.lineTo(x + ox, y + q / 2 - lw);
          c.lineTo(x + ox - q / 2 + lw, y);
          c.closePath();
          const t = r();
          c.fillStyle = t < 0.08 ? "#b0c4cc" : t < 0.55 ? "#7890a0" : "#86a09c";
          c.fill();
        }
      // border of coloured panes
      for (let y = 0; y < h; y += 14)
        for (const x of [2, w - 14]) {
          c.fillStyle = (y / 14) % 2 ? main : acc;
          c.fillRect(x, y + 1.5, 12, 11);
        }
      // medallions
      for (const [cy, rad, kind] of [[h * 0.3, 40, k], [h * 0.68, 34, (k + 2) % 6]] as [number, number, number][]) {
        c.beginPath();
        c.arc(w / 2, cy, rad + 4, 0, TAU);
        c.fillStyle = "#121212";
        c.fill();
        c.beginPath();
        c.arc(w / 2, cy, rad, 0, TAU);
        c.fillStyle = main;
        c.fill();
        c.lineWidth = 5;
        c.strokeStyle = acc;
        c.stroke();
        charge(c, kind, w / 2, cy, rad * 0.62, gold);
      }
    }),
  );
  const runes = d.canvas(512, 512, (c, w) => {
    const cx = w / 2;
    c.strokeStyle = "#9fdcff";
    c.lineCap = "round";
    c.lineWidth = 4;
    for (const rr of [252, 238, 186, 172, 126]) {
      c.beginPath();
      c.arc(cx, cx, rr, 0, TAU);
      c.stroke();
    }
    // runes between the rings
    c.lineWidth = 3.5;
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * TAU;
      c.save();
      c.translate(cx + Math.cos(a) * 212, cx + Math.sin(a) * 212);
      c.rotate(a + Math.PI / 2);
      c.beginPath();
      c.moveTo(0, -11);
      c.lineTo(0, 11);
      const n = 1 + Math.floor(r() * 3);
      for (let j = 0; j < n; j++) {
        const y = -11 + r() * 16, sx = r() < 0.5 ? -1 : 1;
        c.moveTo(0, y);
        c.lineTo(sx * 7, y + (r() < 0.5 ? 6 : -6));
      }
      c.stroke();
      c.restore();
    }
    // a seven-pointed star between the inner rings
    c.lineWidth = 3;
    c.beginPath();
    for (let i = 0; i <= 7; i++) {
      const a = ((i * 3) % 7) * (TAU / 7) - Math.PI / 2;
      const x = cx + Math.cos(a) * 172, y = cx + Math.sin(a) * 172;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
    for (let i = 0; i < 7; i++) {
      const a = i * (TAU / 7) - Math.PI / 2;
      c.beginPath();
      c.arc(cx + Math.cos(a) * 172, cx + Math.sin(a) * 172, 10, 0, TAU);
      c.stroke();
    }
  });
  const sky = d.canvas(256, 256, (c, w) => {
    const cx = w / 2;
    const g = c.createRadialGradient(cx, cx, 10, cx, cx, cx);
    g.addColorStop(0, "#26386a");
    g.addColorStop(1, "#0a1230");
    c.fillStyle = g;
    c.fillRect(0, 0, w, w);
    for (let i = 0; i < 220; i++) {
      const x = r() * w, y = r() * w, b = r();
      c.fillStyle = b > 0.9 ? "#ffffff" : b > 0.5 ? "#c8d8ff" : "#7888b8";
      const sz = b > 0.92 ? 2.5 : 1.3;
      c.fillRect(x, y, sz, sz);
      if (b > 0.97) {
        c.fillRect(x - 3, y + 0.7, 8, 1);
        c.fillRect(x + 0.7, y - 3, 1, 8);
      }
    }
    // a crescent moon
    c.fillStyle = "#f2ecd6";
    c.beginPath();
    c.arc(178, 72, 22, 0, TAU);
    c.fill();
    c.fillStyle = "#1a2650";
    c.beginPath();
    c.arc(188, 64, 20, 0, TAU);
    c.fill();
  });
  const vault = d.canvas(1024, 112, (c, w, h) => {
    c.fillStyle = "#14204e";
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#d8a84a";
    for (let row = 0; row < 9; row++)
      for (let x = 0; x < w; x += 18) {
        const cx = x + (row % 2 ? 9 : 0), cy = 14 + row * 10.5;
        c.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? 1.1 : 2.8;
          c.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        }
        c.fill();
      }
    c.fillRect(0, 0, w, 5);
    c.fillStyle = "#8a1c1c";
    c.fillRect(0, 5, w, 3);
    c.fillStyle = "#e0b04c";
    c.fillRect(0, h - 4, w, 4);
  });
  const mapArt = (k: number) =>
    d.canvas(192, 144, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, w * 0.6);
      g.addColorStop(0, "#e6d4a4");
      g.addColorStop(1, "#a88850");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      c.strokeStyle = "#5a3a1c";
      c.fillStyle = "rgba(150,120,60,0.35)";
      c.lineWidth = 1.6;
      for (let isl = 0; isl < 2 + k; isl++) {
        const cx = w * (0.3 + r() * 0.4), cy = h * (0.3 + r() * 0.4), rad = 20 + r() * 26;
        c.beginPath();
        for (let i = 0; i <= 20; i++) {
          const a = (i / 20) * TAU, rr = rad * (0.6 + r() * 0.5);
          c.lineTo(cx + Math.cos(a) * rr * 1.3, cy + Math.sin(a) * rr);
        }
        c.closePath();
        c.fill();
        c.stroke();
        for (let m = 0; m < 4; m++) {
          const mx = cx + (r() - 0.5) * rad, my = cy + (r() - 0.5) * rad * 0.6;
          c.beginPath();
          c.moveTo(mx - 5, my + 4);
          c.lineTo(mx, my - 4);
          c.lineTo(mx + 5, my + 4);
          c.stroke();
        }
      }
      // dotted route to an X, a compass rose, a sea serpent
      c.setLineDash([3, 4]);
      c.strokeStyle = "#8a1c14";
      c.beginPath();
      c.moveTo(w * 0.2, h * 0.75);
      c.bezierCurveTo(w * 0.4, h * 0.4, w * 0.55, h * 0.9, w * 0.72, h * 0.45);
      c.stroke();
      c.setLineDash([]);
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(w * 0.72 - 5, h * 0.45 - 5);
      c.lineTo(w * 0.72 + 5, h * 0.45 + 5);
      c.moveTo(w * 0.72 + 5, h * 0.45 - 5);
      c.lineTo(w * 0.72 - 5, h * 0.45 + 5);
      c.stroke();
      c.strokeStyle = "#5a3a1c";
      c.lineWidth = 1.5;
      const rx = w * 0.85, ry = h * 0.2;
      for (let i = 0; i < 8; i++) {
        const a = (i * TAU) / 8, rr = i % 2 ? 7 : 14;
        c.beginPath();
        c.moveTo(rx, ry);
        c.lineTo(rx + Math.cos(a) * rr, ry + Math.sin(a) * rr);
        c.stroke();
      }
      c.beginPath();
      for (let i = 0; i < 4; i++) c.arc(w * 0.15 + i * 9, h * 0.25, 4.5, Math.PI * (i % 2), Math.PI * (1 + (i % 2)));
      c.stroke();
      c.fillStyle = "#4a2a14";
      c.font = `12px "Cinzel", serif`;
      c.textAlign = "center";
      c.fillText(k === 0 ? "TERRA INCOGNITA" : k === 1 ? "MARE LUDORUM" : "HIC SVNT DRACONES", w / 2, h - 10);
      c.strokeStyle = "#6a4a26";
      c.lineWidth = 3;
      c.strokeRect(3, 3, w - 6, h - 6);
    });
  const maps = [0, 1, 2].map(mapArt);
  const chart = d.canvas(128, 128, (c, w) => {
    c.fillStyle = "#e2d2a6";
    c.fillRect(0, 0, w, w);
    c.strokeStyle = "rgba(60,40,90,0.6)";
    c.lineWidth = 1;
    for (const rr of [20, 40, 60]) {
      c.beginPath();
      c.arc(w / 2, w / 2, rr, 0, TAU);
      c.stroke();
    }
    for (let i = 0; i < 12; i++) {
      c.beginPath();
      c.moveTo(w / 2, w / 2);
      c.lineTo(w / 2 + Math.cos((i * TAU) / 12) * 62, w / 2 + Math.sin((i * TAU) / 12) * 62);
      c.stroke();
    }
    c.strokeStyle = "#2a3a8a";
    c.fillStyle = "#2a3a8a";
    c.lineWidth = 1.5;
    for (let k = 0; k < 5; k++) {
      let x = 20 + r() * 88, y = 20 + r() * 88;
      c.beginPath();
      c.moveTo(x, y);
      for (let i = 0; i < 4; i++) {
        c.fillRect(x - 2, y - 2, 4, 4);
        x += (r() - 0.5) * 30;
        y += (r() - 0.5) * 30;
        c.lineTo(x, y);
      }
      c.stroke();
    }
  });
  const labels = ["#7a1414", "#14407a", "#1a5a2a"].map((col, k) =>
    d.canvas(32, 24, (c, w, h) => {
      c.fillStyle = "#e6d8b0";
      c.fillRect(0, 0, w, h);
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.strokeRect(2, 2, w - 4, h - 4);
      c.fillStyle = col;
      c.font = `bold 14px "Cinzel", serif`;
      c.textAlign = "center";
      c.fillText("ΑΩΣ"[k], w / 2, 17);
    }),
  );
  return { leaf, web, globe, pages, letter, tabby, banners, shields, tapestries, roses, glass, runes, sky, vault, maps, chart, labels };
}
