// Lab decor: Aperture-flavoured equipment that fills both test chambers of Backlog Science.
//
// Everything static is baked by ONE DecorBuilder (one material + one canvas atlas), built into one
// mesh per chamber so the far chamber gets frustum-culled. The only moving parts are a ceiling
// robotic arm in chamber 02 and a panning security camera in chamber 01 (sub-builders sharing the
// same material). Glass is opaque in the DecorBuilder, so glassware is pale tinted glass above
// softly glowing liquid, and the observation windows are painted interiors.
//
// Chamber-local coordinates: origin at the floor centre, +z toward the front wall. Kept clear:
// the back-wall grid + its key strip and caption, the portals (left wall, z ≈ 0.6), the chamber
// signs (right wall, z ≈ -1.4), the stats boards (front wall x ∈ [-1.4, 3.9], y ∈ [0.9, 3.4];
// right wall z ∈ [0.3, 3.0], y ∈ [0.9, 3.2]), the wishlist tubes, the cube and the Archivist.

import * as THREE from "three/webgpu";
import { DecorBuilder, roundedRect, rand, type Vec3, type Color, type PropOpts, type UVRect } from "../../world/kit/decorkit";
import type { Stats } from "../../../shared/stats";
import type { LevelCtx } from "../types";

type Side = "back" | "front" | "left" | "right";
type Profile = [number, number][];

const P = {
  white: "#eceef0",
  panel: "#dcdfe3",
  grey: "#9ea4ac",
  mid: "#646a73",
  dark: "#2a2d33",
  black: "#16181c",
  steel: "#b9c0c8",
  chrome: "#e4e8ee",
  epoxy: "#26282d",
  beige: "#d9d3c3",
  rack: "#24272c",
  orange: "#ff8a1a",
  blue: "#3aa0ff",
  red: "#e2382f",
  yellow: "#f2c230",
  green: "#46e08a",
  pink: "#ff5fa2",
  amber: "#ffb000",
  glass: "#d3e7ee",
  smoke: "#2e3a44",
};
const PLAST: PropOpts = { rough: 0.45 };
const METAL: PropOpts = { rough: 0.3, metal: 0.85 };
const GLASS: PropOpts = { rough: 0.06, metal: 0.5 };
const FRAME: PropOpts = { rough: 0.4, metal: 0.5 };
const LIQUID = (o: PropOpts = {}): PropOpts => ({ rough: 0.25, glow: 0.35, ...o });

// rack layout in units (1U = 1/40 of the rack face); 4U blanks on odd slots are storage
const RACK_U = [2, 1, 1, 2, 4, 1, 1, 2, 3, 1, 2, 1, 1, 4, 2, 1, 2, 3, 1, 2, 1, 1, 1];
const rackBlank = (k: number, n: number) => n === 4 && k % 2 === 1;

export interface LabDecorOpts {
  W: number;
  D: number;
  H: number;
  /** Chamber floor centres: [chamber 01 (queue), chamber 02 (results)]. */
  origins: THREE.Vector3[];
}

/** Builds in a few slices (yielding a frame between them) so a background build never stalls the screen. */
export async function decorateLab(c: LevelCtx, opts: LabDecorOpts) {
  const t0 = performance.now();
  let busy = 0;
  const slice = async (fn: () => void) => {
    const t = performance.now();
    fn();
    busy += performance.now() - t;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  };
  const { W, D, H } = opts;
  const d = new DecorBuilder();
  let tx!: ReturnType<typeof makeTextures>;
  await slice(() => (tx = makeTextures(d, c.store.stats)));
  const tTex = busy;
  let b: DecorBuilder = d; // builder the helpers draw into (swapped for the moving parts)
  let seed = 7;
  const rnd = () => rand(seed++);

  // ---- small geometry helpers ------------------------------------------------------------------
  const ext = (shape: THREE.Shape, depth: number, at: Vec3, color: Color, o: PropOpts = {}) =>
    b.geo(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 3 }), at, color, o);
  /** Rounded slab: w×h shape centred on at.xy, extruded from at.z by `depth` toward +z. */
  const slab = (w: number, h: number, depth: number, r: number, at: Vec3, color: Color, o: PropOpts = {}) => ext(roundedRect(w, h, r), depth, at, color, o);
  const xcyl = (r: number, len: number, at: Vec3, color: Color, o: PropOpts & { seg?: number } = {}) => b.cyl(r, r, len, at, color, { ...o, rot: [0, 0, Math.PI / 2] });
  const zcyl = (r: number, len: number, at: Vec3, color: Color, o: PropOpts & { seg?: number } = {}) => b.cyl(r, r, len, at, color, { ...o, rot: [Math.PI / 2, 0, 0] });
  /** A plane lying on the floor (faces up); rot[2] spins it in place (0 = canvas top toward -z). */
  const flat = (size: [number, number], at: Vec3, color: Color, o: PropOpts = {}) => b.plane(size, at, color, { ...o, rot: [-Math.PI / 2, 0, o.rot?.[2] ?? 0] });
  /** Local frame on a wall: origin on the wall at (u along the wall, y), +z into the room, +x to the viewer's right. */
  const wall = (side: Side, u: number, y: number, fn: () => void) => {
    if (side === "back") b.at([u, y, -D / 2], null, fn);
    else if (side === "front") b.at([u, y, D / 2], [0, Math.PI, 0], fn);
    else if (side === "left") b.at([-W / 2, y, u], [0, Math.PI / 2, 0], fn);
    else b.at([W / 2, y, u], [0, -Math.PI / 2, 0], fn);
  };

  // ---- glassware -------------------------------------------------------------------------------
  function beaker(at: Vec3, r: number, h: number, fill: number, liq: Color) {
    const f = Math.max(0.008, h * fill), ri = r * 0.9;
    b.lathe([[0, 0], [r * 0.94, 0], [r, 0.005], [r, f], [ri, f], [0, f]], at, liq, { ...LIQUID(), seg: 14 });
    b.lathe([[r, f], [r, h], [r * 1.08, h + 0.004], [ri, h], [ri, f]], at, P.glass, { ...GLASS, seg: 14 });
  }
  function erlenmeyer(at: Vec3, r: number, h: number, fill: number, liq: Color) {
    const hc = h * 0.62, rn = r * 0.32, fy = hc * fill, rf = r + (rn - r) * fill;
    b.lathe([[0, 0], [r * 0.95, 0], [r, 0.006], [rf, fy], [0, fy]], at, liq, { ...LIQUID(), seg: 14 });
    b.lathe([[rf, fy], [rn, hc], [rn, h], [rn * 1.3, h + 0.004], [rn * 0.78, h], [rn * 0.78, hc]], at, P.glass, { ...GLASS, seg: 14 });
  }
  function rbFlask(at: Vec3, R: number, neck: number, fill: number, liq: Color) {
    const rn = R * 0.3, aTop = Math.acos(rn / R), aL = -Math.PI / 2 + Math.PI * fill * 0.9;
    const L: Profile = [[0, 0]];
    for (let k = 1; k <= 5; k++) {
      const a = -Math.PI / 2 + ((aL + Math.PI / 2) * k) / 5;
      L.push([R * Math.cos(a), R + R * Math.sin(a)]);
    }
    L.push([0, R + R * Math.sin(aL)]);
    b.lathe(L, at, liq, { ...LIQUID(), seg: 14 });
    const G: Profile = [];
    for (let k = 0; k <= 5; k++) {
      const a = aL + ((aTop - aL) * k) / 5;
      G.push([R * Math.cos(a), R + R * Math.sin(a)]);
    }
    const yn = R + R * Math.sin(aTop);
    G.push([rn, yn + neck], [rn * 1.3, yn + neck + 0.004], [rn * 0.75, yn + neck], [rn * 0.75, yn]);
    b.lathe(G, at, P.glass, { ...GLASS, seg: 14 });
  }
  function gradCylinder(at: Vec3, r: number, h: number, fill: number, liq: Color) {
    b.cyl(r * 2.2, r * 2.2, 0.008, [at[0], at[1] + 0.004, at[2]], P.glass, { ...GLASS, seg: 6 });
    beaker([at[0], at[1] + 0.008, at[2]], r, h, fill, liq);
  }
  function bottle(at: Vec3, r: number, h: number, glass: Color, cap: Color, label = true) {
    b.lathe([[0, 0], [r * 0.95, 0], [r, 0.006], [r, h * 0.68], [r * 0.82, h * 0.8], [r * 0.42, h * 0.88], [r * 0.42, h * 0.94], [0, h * 0.94]], at, glass, { rough: 0.12, metal: 0.3, seg: 12 });
    b.cyl(r * 0.48, r * 0.48, h * 0.1, [at[0], at[1] + h * 0.97, at[2]], cap, { rough: 0.5, seg: 10 });
    if (label) b.cyl(r * 1.02, r * 1.02, h * 0.34, [at[0], at[1] + h * 0.36, at[2]], "#fff", { open: true, seg: 12, tex: tx.label, rot: [0, Math.PI, 0] });
  }
  function tubeRack(at: Vec3, n: number) {
    b.at(at, null, () => {
      const w = 0.028 * n + 0.03, cols = [P.orange, P.blue, P.green, P.pink, P.amber, P.blue, P.orange];
      for (const y of [0.075, 0.02]) b.box([w, 0.007, 0.05], [0, y, 0], P.white, PLAST);
      for (const s of [-1, 1]) b.box([0.007, 0.085, 0.05], [(s * w) / 2, 0.0425, 0], P.white, PLAST);
      for (let k = 0; k < n; k++) {
        const x = -w / 2 + 0.029 + k * 0.028, h = 0.12 + rnd() * 0.025, f = 0.035 + rnd() * 0.05, r = 0.0085;
        if (k === 3) continue; // one empty slot
        b.lathe([[0, 0], [r * 0.7, 0.003], [r, 0.009], [r, f], [0, f]], [x, 0.012, 0], cols[k % cols.length], { ...LIQUID({ glow: 0.45 }), seg: 8 });
        b.lathe([[r, f], [r, h], [r * 1.2, h + 0.002], [r * 0.8, h], [r * 0.8, f]], [x, 0.012, 0], P.glass, { ...GLASS, seg: 8 });
        if (k % 3 === 1) b.cyl(r * 1.05, r * 0.95, 0.014, [x, 0.012 + h, 0], k % 2 ? P.red : P.dark, { seg: 8 });
      }
    });
  }

  // ---- bench-top instruments -------------------------------------------------------------------
  function microscope(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      ext(roundedRect(0.15, 0.2, 0.03), 0.028, [0, 0, 0], P.white, { ...PLAST, rot: [-Math.PI / 2, 0, 0] });
      b.box([0.05, 0.26, 0.055], [0, 0.158, -0.07], P.white, PLAST); // pillar
      b.box([0.055, 0.06, 0.15], [0, 0.29, -0.015], P.white, PLAST); // arm
      b.cyl(0.03, 0.03, 0.02, [0, 0.252, 0.03], P.chrome, METAL); // nosepiece
      for (let k = 0; k < 3; k++) {
        const a = (k - 1) * 0.55;
        b.cyl(0.007, 0.009, 0.045, [Math.sin(a) * 0.018, 0.226, 0.03], P.chrome, { ...METAL, rot: [0, 0, a * 0.5], seg: 8 });
      }
      b.box([0.13, 0.012, 0.12], [0, 0.165, 0.02], P.black, { rough: 0.5 }); // stage
      b.box([0.075, 0.003, 0.026], [0, 0.1725, 0.03], P.glass, GLASS); // slide
      b.cyl(0.007, 0.007, 0.002, [0, 0.175, 0.03], P.pink, { glow: 0.5, seg: 8 });
      b.cyl(0.018, 0.02, 0.012, [0, 0.034, 0.03], "#fff3d6", { glow: 0.9, seg: 10 }); // lamp
      xcyl(0.024, 0.075, [0, 0.12, -0.07], P.black, { rough: 0.6, seg: 12 }); // coarse focus
      xcyl(0.015, 0.095, [0, 0.12, -0.07], P.mid, { seg: 10 }); // fine focus
      b.at([0, 0.33, -0.01], [0.55, 0, 0], () => {
        b.box([0.07, 0.05, 0.06], [0, 0, 0], P.white, PLAST);
        for (const s of [-1, 1]) b.cyl(0.011, 0.012, 0.07, [s * 0.02, 0.055, 0], P.black, { seg: 10 });
      });
    });
  }
  function centrifuge(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      b.lathe([[0, 0], [0.15, 0], [0.16, 0.015], [0.16, 0.13], [0.15, 0.15], [0, 0.15]], [0, 0, 0], P.white, { ...PLAST, seg: 20 });
      b.lathe([[0, 0], [0.142, 0], [0.142, 0.012], [0.12, 0.03], [0, 0.034]], [0, 0.15, 0], P.grey, { rough: 0.35, seg: 20 });
      b.cyl(0.065, 0.065, 0.004, [0, 0.184, 0], P.smoke, { rough: 0.05, metal: 0.5, seg: 16 });
      b.at([0, 0.075, 0.15], [-0.35, 0, 0], () => {
        b.box([0.17, 0.07, 0.04], [0, 0, 0], P.white, PLAST);
        b.plane([0.08, 0.03], [-0.03, 0.006, 0.0205], "#fff", { tex: tx.rpm, glow: 0.8 });
        b.box([0.014, 0.014, 0.008], [0.035, 0.006, 0.022], P.green, { glow: 0.9 });
        b.box([0.014, 0.014, 0.008], [0.06, 0.006, 0.022], P.red, { rough: 0.4 });
      });
      xcyl(0.014, 0.12, [0, 0.155, -0.14], P.mid, METAL); // lid hinge
    });
  }
  function oscilloscope(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      slab(0.34, 0.19, 0.27, 0.018, [0, 0.105, -0.135], "#c9c4b4", PLAST);
      for (const [x, z] of [[-0.14, -0.1], [0.14, -0.1], [-0.14, 0.1], [0.14, 0.1]] as const) b.box([0.03, 0.01, 0.03], [x, 0.005, z], P.black);
      b.box([0.175, 0.13, 0.006], [-0.07, 0.11, 0.136], P.black, { rough: 0.5 });
      b.plane([0.15, 0.1], [-0.07, 0.11, 0.1395], "#fff", { tex: tx.scope, glow: 0.6, rough: 0.15 });
      b.plane([0.15, 0.1], [-0.07, 0.11, 0.1405], "#fff", { tex: tx.trace, glow: 1.3, blink: 3, rough: 0.15 });
      for (let r = 0; r < 3; r++)
        for (let k = 0; k < 2; k++) {
          zcyl(0.011, 0.014, [0.06 + k * 0.04, 0.16 - r * 0.042, 0.142], P.dark, { seg: 10 });
          zcyl(0.003, 0.016, [0.06 + k * 0.04, 0.16 - r * 0.042, 0.143], P.chrome, { seg: 6 });
        }
      for (let k = 0; k < 3; k++) zcyl(0.007, 0.02, [-0.12 + k * 0.05, 0.03, 0.142], P.chrome, { ...METAL, seg: 8 });
      b.box([0.01, 0.008, 0.004], [0.14, 0.03, 0.137], P.green, { glow: 1.8, blink: 2.2 });
      b.torus(0.09, 0.008, [0, 0.2, 0], P.dark, { arc: Math.PI, scale: [1, 0.35, 1], seg: 12 });
    });
  }
  /** CRT monitor sitting on its foot at `at`, screen facing +z. */
  function crt(at: Vec3, rotY: number, sz: number, screen: UVRect, tilt = -0.06) {
    b.at(at, [0, rotY, 0], () => {
      const w = sz, h = sz * 0.82;
      b.box([w * 0.55, 0.02, w * 0.5], [0, 0.01, -w * 0.3], P.beige, PLAST);
      b.box([w * 0.22, 0.05, w * 0.18], [0, 0.04, -w * 0.3], P.beige, PLAST);
      b.at([0, 0.065 + h / 2, 0], [tilt, 0, 0], () => {
        slab(w, h, 0.07, 0.025, [0, 0, -0.07], P.beige, PLAST);
        b.cyl(w * 0.33, w * 0.62, w * 0.62, [0, -0.01, -0.07 - w * 0.31], P.beige, { ...PLAST, seg: 4, rot: [-Math.PI / 2, Math.PI / 4, 0] });
        b.box([w * 0.84, h * 0.78, 0.004], [0, h * 0.04, 0.001], P.black, { rough: 0.4 });
        b.plane([w * 0.78, h * 0.72], [0, h * 0.04, 0.0035], "#fff", { tex: screen, glow: 0.75, rough: 0.1 });
        b.box([0.012, 0.006, 0.004], [w * 0.38, -h * 0.42, 0.002], P.green, { glow: 1.6, blink: 1.7 });
        for (let k = 0; k < 3; k++) zcyl(0.006, 0.008, [w * 0.12 + k * 0.022, -h * 0.42, 0.003], P.mid, { seg: 8 });
      });
    });
  }
  function clipboard(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      b.box([0.23, 0.006, 0.31], [0, 0.003, 0], "#8a6a4a", { rough: 0.75 });
      flat([0.21, 0.28], [0, 0.0066, 0.012], "#fff", { tex: tx.paper, rough: 0.8 });
      b.box([0.09, 0.012, 0.03], [0, 0.01, -0.135], P.chrome, METAL);
      b.cyl(0.0045, 0.0045, 0.14, [0.075, 0.011, 0.04], P.blue, { rot: [Math.PI / 2, 0, 0.25], seg: 8 });
    });
  }
  function mug(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      const r = 0.04, h = 0.095;
      b.lathe([[0, 0], [r * 0.9, 0], [r, 0.006], [r, h], [r * 0.86, h], [r * 0.86, h * 0.82]], [0, 0, 0], P.white, { rough: 0.25, seg: 16 });
      b.lathe([[r * 0.86, h * 0.82], [0, h * 0.82]], [0, 0, 0], "#3a2416", { rough: 0.15, seg: 16 });
      b.cyl(r + 0.0012, r + 0.0012, h * 0.62, [0, h * 0.52, 0], "#fff", { open: true, seg: 16, tex: tx.mug, rot: [0, Math.PI, 0], rough: 0.25 });
      b.torus(0.026, 0.0065, [-r, h * 0.5, 0], P.white, { arc: Math.PI, rot: [0, 0, Math.PI / 2], seg: 10, rough: 0.25 });
    });
  }
  function cactus(at: Vec3) {
    b.at(at, null, () => {
      const green = "#4a8f4c";
      b.lathe([[0, 0], [0.042, 0], [0.056, 0.085], [0.062, 0.088], [0.062, 0.1], [0.052, 0.1], [0.05, 0.088]], [0, 0, 0], "#c8693c", { rough: 0.85, seg: 14 });
      b.cyl(0.05, 0.05, 0.004, [0, 0.09, 0], "#3b2a1e", { seg: 14, rough: 1 });
      b.lathe([[0.001, 0], [0.03, 0.005], [0.033, 0.08], [0.029, 0.13], [0.017, 0.158], [0, 0.165]], [0, 0.09, 0], green, { rough: 0.8, seg: 8 });
      for (const [s, y, hh] of [[1, 0.16, 0.06], [-1, 0.13, 0.045]] as const) {
        xcyl(0.012, 0.035, [s * 0.045, y, 0], green, { rough: 0.8, seg: 8 });
        b.lathe([[0.001, 0], [0.013, 0.004], [0.013, hh * 0.7], [0.008, hh * 0.95], [0, hh]], [s * 0.062, y - 0.008, 0], green, { rough: 0.8, seg: 8 });
      }
      b.sphere(0.012, [0, 0.258, 0], P.pink, { seg: 8 });
    });
  }
  function bunsen(at: Vec3) {
    b.lathe([[0, 0], [0.035, 0], [0.035, 0.01], [0.012, 0.02], [0.009, 0.1], [0.011, 0.11], [0, 0.11]], at, P.steel, { ...METAL, seg: 12 });
    b.cyl(0, 0.009, 0.05, [at[0], at[1] + 0.135, at[2]], "#5aa8ff", { glow: 1.4, blink: 11, seg: 8 });
    b.tube([[at[0] + 0.03, at[1] + 0.006, at[2]], [at[0] + 0.09, at[1] + 0.008, at[2] - 0.05], [at[0] + 0.12, at[1] + 0.006, at[2] - 0.2]], 0.006, P.orange, { seg: 10 });
  }
  function distillation(at: Vec3) {
    b.at(at, null, () => {
      b.box([0.14, 0.012, 0.2], [0, 0.006, -0.03], P.dark, METAL); // stand base
      b.cyl(0.006, 0.006, 0.45, [0, 0.225, -0.11], P.steel, { ...METAL, seg: 8 }); // stops under the reagent shelf
      for (const y of [0.22, 0.43]) {
        b.box([0.022, 0.025, 0.025], [0, y, -0.11], P.dark);
        b.box([0.008, 0.008, 0.08], [0, y, -0.065], P.steel, METAL);
      }
      b.torus(0.05, 0.005, [0, 0.22, 0.02], P.steel, { ...METAL, rot: [Math.PI / 2, 0, 0], seg: 16 }); // the flask rests on it
      bunsen([0, 0.012, 0.02]);
      rbFlask([0, 0.2, 0.02], 0.06, 0.07, 0.55, P.orange);
      // condenser (glass jacket) down to a receiving flask
      const top = 0.2 + 0.06 + 0.06 * Math.sin(Math.acos(0.3)) + 0.07;
      b.tube([[0, top - 0.01, 0.02], [0.02, top + 0.025, 0.02], [0.07, top + 0.01, 0.02], [0.3, top - 0.13, 0.02], [0.34, 0.2, 0.02]], 0.007, P.glass, { ...GLASS, seg: 24 });
      b.tube([[0.1, top - 0.015, 0.02], [0.27, top - 0.12, 0.02]], 0.02, "#bfe2f0", { ...GLASS, glow: 0.08, seg: 6 });
      b.box([0.008, 0.008, 0.08], [0.19, top - 0.07, -0.06], P.steel, METAL);
      erlenmeyer([0.34, 0, 0.02], 0.055, 0.19, 0.25, P.amber);
    });
  }

  // ---- furniture ------------------------------------------------------------------------------
  /** Lab bench against a wall (wall frame): epoxy top, white cabinets, drawers and doors. */
  function bench(L: number, dep = 0.66, Ht = 0.9, splash = true) {
    const top = 0.04, ch = Ht - top - 0.09;
    b.box([L, top, dep], [0, Ht - top / 2, dep / 2], P.epoxy, { rough: 0.3, metal: 0.1 });
    b.box([L - 0.03, ch, dep - 0.06], [0, 0.09 + ch / 2, (dep - 0.06) / 2], P.white, PLAST);
    b.box([L - 0.1, 0.09, dep - 0.12], [0, 0.045, (dep - 0.12) / 2], P.dark, { rough: 0.6 });
    const n = Math.max(1, Math.round(L / 0.55)), uw = (L - 0.03) / n, fz = dep - 0.06 + 0.009;
    for (let i = 0; i < n; i++) {
      const x = -(L - 0.03) / 2 + uw * (i + 0.5);
      if (i % 2 === 0) {
        for (let k = 0; k < 3; k++) {
          const hh = ch / 3 - 0.012, y = 0.09 + (ch / 3) * (k + 0.5);
          b.box([uw - 0.012, hh, 0.018], [x, y, fz], P.panel, PLAST);
          b.box([uw * 0.42, 0.014, 0.014], [x, y + hh / 2 - 0.035, fz + 0.016], P.steel, METAL);
        }
      } else {
        b.box([uw - 0.012, ch - 0.012, 0.018], [x, 0.09 + ch / 2, fz], P.panel, PLAST);
        b.box([0.014, 0.18, 0.014], [x + uw / 2 - 0.06, 0.09 + ch - 0.16, fz + 0.016], P.steel, METAL);
      }
    }
    if (splash) b.box([L, 0.1, 0.012], [0, Ht + 0.05, 0.006], P.epoxy, { rough: 0.3 });
  }
  /** Two wall shelves of reagent bottles (wall frame). */
  function reagentShelf(L: number, ys: number[], dep = 0.24) {
    const y0 = ys[0], y1 = ys[ys.length - 1];
    for (const s of [-1, 1]) b.box([0.025, y1 - y0 + 0.4, 0.02], [s * (L / 2 - 0.06), (y0 + y1) / 2 + 0.1, 0.01], P.steel, METAL);
    const glasses = ["#8a4a14", P.glass, "#2a5fa8", "#3d7a4a", "#e8e8e8", "#8a4a14"];
    const caps = [P.black, P.white, P.red, P.blue, P.black];
    for (const y of ys) {
      b.box([L, 0.022, dep], [0, y, dep / 2], P.white, PLAST);
      b.box([L, 0.03, 0.008], [0, y + 0.025, dep - 0.004], P.steel, METAL);
      for (const s of [-1, 1]) b.box([0.012, 0.12, dep * 0.8], [s * (L / 2 - 0.06), y - 0.07, dep * 0.4], P.steel, METAL);
      let x = -L / 2 + 0.09;
      while (x < L / 2 - 0.1) {
        const r = 0.026 + rnd() * 0.018, h = 0.13 + rnd() * 0.1;
        bottle([x + r, y + 0.011, 0.1 + rnd() * 0.04], r, h, glasses[Math.floor(rnd() * glasses.length)], caps[Math.floor(rnd() * caps.length)], rnd() < 0.8);
        x += r * 2 + 0.025 + rnd() * 0.06;
      }
    }
  }
  function whiteboard(w: number, h: number) {
    b.box([w + 0.05, h + 0.05, 0.02], [0, 0, 0.01], P.steel, METAL);
    b.plane([w, h], [0, 0, 0.0205], "#fff", { tex: tx.board, rough: 0.25, glow: 0.05 });
    b.box([w * 0.7, 0.015, 0.06], [0, -h / 2 - 0.03, 0.04], P.steel, METAL);
    b.box([w * 0.7, 0.03, 0.008], [0, -h / 2 - 0.02, 0.07], P.steel, METAL);
    const pens: Color[] = [P.blue, P.red, P.black, P.green];
    pens.forEach((col, k) => {
      xcyl(0.008, 0.11, [-0.5 + k * 0.14, -h / 2 - 0.013, 0.04], P.white, { seg: 8 });
      xcyl(0.0085, 0.03, [-0.5 + k * 0.14 + 0.05, -h / 2 - 0.013, 0.04], col, { seg: 8 });
    });
    b.box([0.13, 0.03, 0.045], [0.35, -h / 2 - 0.007, 0.04], P.dark);
    b.box([0.13, 0.008, 0.045], [0.35, -h / 2 - 0.026, 0.04], P.grey, { rough: 0.95 });
  }
  function rack() {
    const w = 0.6, h = 2.0, dep = 0.62, fh = 1.8, y0 = 0.05;
    b.box([w, h, dep], [0, y0 + h / 2, dep / 2], P.rack, { rough: 0.45, metal: 0.5 });
    b.box([w - 0.06, y0, dep - 0.06], [0, y0 / 2, dep / 2], P.black);
    b.plane([w - 0.1, fh], [0, y0 + h / 2, dep + 0.002], "#fff", { tex: tx.rack, rough: 0.5, metal: 0.3 });
    for (const s of [-1, 1]) b.box([0.045, h, 0.02], [s * (w / 2 - 0.0225), y0 + h / 2, dep + 0.01], P.mid, METAL);
    b.box([w, 0.09, 0.02], [0, y0 + h - 0.045, dep + 0.01], P.mid, METAL);
    b.box([w, 0.06, 0.02], [0, y0 + 0.03, dep + 0.01], P.mid, METAL);
    b.box([0.018, 0.2, 0.025], [w / 2 - 0.022, y0 + h / 2, dep + 0.032], P.chrome, METAL);
    b.plane([0.32, 0.075], [0, y0 + h - 0.045, dep + 0.0205], "#fff", { tex: tx.logo, glow: 0.15 });
    // status LEDs, lined up with the drawn units
    const top = y0 + h / 2 + fh / 2, ux = fh / 40;
    let u = 0;
    RACK_U.forEach((n, k) => {
      const yc = top - (u + n / 2) * ux;
      u += n;
      if (rackBlank(k, n)) return;
      const count = 2 + (k % 3);
      for (let j = 0; j < count; j++) {
        const r = rnd();
        const col = j === 0 ? P.green : r < 0.6 ? P.green : r < 0.85 ? P.amber : P.blue;
        b.box([0.012, 0.007, 0.006], [-(w - 0.1) / 2 + 0.035 + j * 0.022, yc, dep + 0.005], col, { glow: 2.2, blink: j === 0 ? 0 : 2 + rnd() * 9 });
      }
    });
    // cable bundle out of the roof up to the cable tray (on the side away from the corner's PA horn)
    for (let k = 0; k < 3; k++) b.tube([[0.15 - k * 0.05, y0 + h, 0.2], [0.15 - k * 0.05, y0 + h + 0.3, 0.15 + k * 0.02], [0.12 - k * 0.05, 4.6, 0.1]], 0.012, k === 1 ? P.blue : P.black, { seg: 14 });
  }
  function fumeHood() {
    const L = 1.4, dep = 0.75;
    bench(L, dep, 0.9, false);
    for (const s of [-1, 1]) b.box([0.06, 1.35, dep], [s * (L / 2 - 0.03), 1.575, dep / 2], P.white, PLAST);
    b.box([L, 0.32, dep], [0, 2.41, dep / 2], P.white, PLAST);
    b.box([L - 0.12, 1.35, 0.03], [0, 1.575, 0.03], P.panel, PLAST);
    for (const y of [1.2, 1.7, 2.12]) b.box([L - 0.3, 0.03, 0.006], [0, y, 0.048], P.dark);
    b.box([L - 0.2, 0.03, 0.08], [0, 2.235, dep * 0.45], "#fff6e6", { glow: 1.0 }); // interior light
    // sash: half raised glass panel in steel channels
    for (const s of [-1, 1]) b.box([0.03, 1.35, 0.04], [s * (L / 2 - 0.075), 1.575, dep - 0.05], P.steel, METAL);
    b.box([L - 0.14, 0.62, 0.012], [0, 1.93, dep - 0.05], P.glass, { ...GLASS, glow: 0.05 });
    b.box([L - 0.14, 0.05, 0.03], [0, 1.6, dep - 0.045], P.steel, METAL);
    b.box([L - 0.14, 0.03, 0.03], [0, 2.235, dep - 0.045], P.steel, METAL);
    b.box([0.5, 0.025, 0.025], [0, 1.57, dep - 0.015], P.chrome, METAL); // handle
    b.plane([L - 0.3, 0.035], [0, 1.6, dep - 0.0295], "#fff", { tex: tx.caution });
    // airflow monitor + label on the housing
    b.plane([0.16, 0.08], [L / 2 - 0.18, 2.41, dep + 0.001], "#fff", { tex: tx.hoodMon, glow: 0.7 });
    b.plane([0.44, 0.11], [-0.2, 2.41, dep + 0.001], "#fff", { tex: tx.logo, glow: 0.12 });
    // contents
    b.at([0, 0.9, 0.3], null, () => {
      erlenmeyer([-0.3, 0, 0], 0.06, 0.2, 0.4, P.green);
      beaker([0.05, 0, 0.1], 0.05, 0.12, 0.5, P.pink);
      bottle([0.3, 0, -0.1], 0.04, 0.24, "#8a4a14", P.black);
      bottle([0.42, 0, -0.05], 0.03, 0.18, P.glass, P.red);
    });
    // exhaust duct, elbowing back into the wall
    b.cyl(0.15, 0.15, 0.06, [0.35, 2.6, 0.38], P.steel, { ...METAL, seg: 16 });
    b.tube([[0.35, 2.6, 0.38], [0.35, 2.95, 0.38], [0.35, 3.15, 0.3], [0.35, 3.22, 0.12], [0.35, 3.23, -0.02]], 0.12, P.steel, { ...METAL, seg: 20 });
    b.torus(0.125, 0.012, [0.35, 2.8, 0.38], P.mid, { ...METAL, rot: [Math.PI / 2, 0, 0], seg: 16 });
  }
  function controlDesk() {
    const L = 1.1, dep = 0.62, Ht = 0.74;
    b.box([L, 0.035, dep], [0, Ht - 0.0175, dep / 2], P.white, PLAST);
    b.box([L, 0.012, 0.012], [0, Ht - 0.03, dep], P.orange, { rough: 0.4 });
    for (const s of [-1, 1]) b.box([0.03, Ht - 0.035, dep - 0.04], [s * (L / 2 - 0.02), (Ht - 0.035) / 2, dep / 2], P.grey, METAL);
    b.box([L - 0.06, 0.35, 0.015], [0, 0.5, 0.06], P.mid, FRAME);
    b.box([0.38, 0.55, dep - 0.08], [L / 2 - 0.23, 0.36, (dep - 0.08) / 2], P.white, PLAST);
    for (let k = 0; k < 3; k++) {
      b.box([0.36, 0.16, 0.015], [L / 2 - 0.23, 0.18 + k * 0.18, dep - 0.075], P.panel, PLAST);
      b.box([0.12, 0.012, 0.012], [L / 2 - 0.23, 0.24 + k * 0.18, dep - 0.062], P.steel, METAL);
    }
    b.at([0, Ht, 0], null, () => {
      crt([-0.26, 0, 0.36], 0.16, 0.36, tx.crtBars);
      crt([0.24, 0, 0.34], -0.18, 0.31, tx.crtWave);
      b.box([0.42, 0.022, 0.14], [-0.02, 0.011, 0.5], P.beige, PLAST);
      flat([0.4, 0.12], [-0.02, 0.0225, 0.5], "#fff", { tex: tx.keys, rough: 0.6 });
      b.box([0.05, 0.02, 0.08], [0.3, 0.01, 0.5], P.beige, PLAST);
      mug([0.44, 0, 0.4], 0.5);
    });
  }
  function chair(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        b.box([0.03, 0.03, 0.26], [Math.sin(a) * 0.13, 0.065, Math.cos(a) * 0.13], P.dark, { rot: [0, a, 0] });
        b.sphere(0.022, [Math.sin(a) * 0.26, 0.025, Math.cos(a) * 0.26], P.black, { seg: 8 });
      }
      b.cyl(0.024, 0.024, 0.36, [0, 0.25, 0], P.chrome, METAL);
      ext(roundedRect(0.46, 0.44, 0.08), 0.07, [0, 0.42, 0], P.dark, { rough: 0.8, rot: [-Math.PI / 2, 0, 0] });
      b.box([0.04, 0.3, 0.03], [0, 0.58, -0.21], P.mid, METAL);
      b.at([0, 0.85, -0.23], [-0.12, 0, 0], () => slab(0.42, 0.4, 0.06, 0.08, [0, 0, -0.03], P.dark, { rough: 0.8 }));
    });
  }

  // ---- signage + wall fixtures -----------------------------------------------------------------
  function obsWindow(w: number, h: number) {
    const t = 0.09;
    b.plane([w, h], [0, 0, 0.01], "#fff", { tex: tx.window, glow: 0.4, rough: 0.08, metal: 0.3 });
    b.box([w + 2 * t, t, 0.15], [0, h / 2 + t / 2, 0.075], P.dark, FRAME);
    b.box([w + 2 * t, t, 0.15], [0, -h / 2 - t / 2, 0.075], P.dark, FRAME);
    for (const s of [-1, 1]) b.box([t, h, 0.15], [s * (w / 2 + t / 2), 0, 0.075], P.dark, FRAME);
    for (const s of [-1, 1]) b.box([0.035, h, 0.05], [(s * w) / 6, 0, 0.03], P.dark, FRAME);
    b.box([w + 2 * t + 0.08, 0.03, 0.24], [0, -h / 2 - t - 0.015, 0.12], P.panel, PLAST);
    b.box([w * 0.7, 0.018, 0.01], [0, h / 2 + t + 0.02, 0.01], P.orange, { glow: 0.5 });
  }
  function pictoPanel() {
    slab(0.66, 0.98, 0.03, 0.04, [0, 0, 0], P.panel, PLAST);
    b.plane([0.6, 0.9], [0, 0, 0.031], "#fff", { tex: tx.picto, glow: 0.18, rough: 0.6 });
  }
  function exitSign() {
    slab(0.44, 0.18, 0.05, 0.015, [0, 0, 0], P.white, PLAST);
    b.plane([0.4, 0.15], [0, 0, 0.0505], "#fff", { tex: tx.exit, glow: 0.65 });
  }
  function poster(t: UVRect, w: number, h: number) {
    b.box([w + 0.02, h + 0.02, 0.008], [0, 0, 0.004], P.dark);
    b.plane([w, h], [0, 0, 0.0085], "#fff", { tex: t, rough: 0.6, glow: 0.08 });
  }
  function clock() {
    b.lathe([[0, 0], [0.17, 0], [0.18, 0.015], [0.176, 0.04], [0.162, 0.045]], [0, 0, 0], P.dark, { ...FRAME, rot: [Math.PI / 2, 0, 0], seg: 28 });
    b.plane([0.33, 0.33], [0, 0, 0.03], "#fff", { tex: tx.clock, rough: 0.3, glow: 0.12 });
  }
  function vent(w: number, h: number) {
    b.box([w + 0.06, h + 0.06, 0.015], [0, 0, 0.0075], P.grey, METAL);
    b.box([w, h, 0.004], [0, 0, 0.017], P.black);
    const n = Math.max(3, Math.round(h / 0.045));
    for (let k = 0; k < n; k++) b.box([w, 0.012, 0.035], [0, -h / 2 + (k + 0.5) * (h / n), 0.03], P.steel, { ...METAL, rot: [0.6, 0, 0] });
  }
  function beacon(col: Color = P.orange) {
    b.box([0.08, 0.012, 0.13], [0, 0, 0.065], P.dark, METAL);
    b.box([0.08, 0.08, 0.012], [0, -0.04, 0.006], P.dark, METAL);
    b.cyl(0.05, 0.055, 0.035, [0, 0.0235, 0.08], P.dark, { seg: 14 });
    b.lathe([[0.045, 0], [0.045, 0.035], [0.036, 0.065], [0.018, 0.08], [0, 0.083]], [0, 0.041, 0.08], col, { glow: 1.1, blink: 3.2, seg: 14, rough: 0.2 });
    b.torus(0.049, 0.004, [0, 0.075, 0.08], P.dark, { rot: [Math.PI / 2, 0, 0], seg: 14 });
    for (const a of [0, Math.PI / 2]) b.torus(0.05, 0.004, [0, 0.041, 0.08], P.dark, { rot: [0, a, 0], arc: Math.PI, seg: 10 });
  }
  function extinguisher() {
    b.box([0.1, 0.14, 0.02], [0, 0.62, 0.01], P.dark, METAL);
    b.lathe([[0, 0], [0.07, 0], [0.075, 0.02], [0.075, 0.46], [0.06, 0.52], [0.025, 0.54], [0, 0.54]], [0, 0.2, 0.09], P.red, { rough: 0.3, metal: 0.1, seg: 14 });
    b.cyl(0.018, 0.02, 0.05, [0, 0.765, 0.09], P.dark, { seg: 10 });
    b.box([0.12, 0.012, 0.025], [0.03, 0.8, 0.09], P.dark, { rot: [0, 0, -0.2] });
    b.tube([[0.02, 0.77, 0.11], [0.08, 0.72, 0.16], [0.095, 0.5, 0.17], [0.085, 0.32, 0.165]], 0.008, P.black, { seg: 14 });
    b.cyl(0.0765, 0.0765, 0.12, [0, 0.45, 0.09], "#fff", { open: true, seg: 14, tex: tx.label, rot: [0, Math.PI, 0] });
  }
  /** Camera on a wall arm (wall frame); the head is built separately so it can pan. */
  function camMount() {
    b.cyl(0.05, 0.05, 0.02, [0, 0, 0.01], P.white, { rot: [Math.PI / 2, 0, 0], seg: 12 });
    b.box([0.03, 0.03, 0.2], [0, 0, 0.11], P.grey, METAL);
    b.sphere(0.028, [0, 0, 0.22], P.dark, { seg: 10 });
  }
  /** Camera head, looking along +z, pivot at the origin. */
  function camHead() {
    b.box([0.025, 0.06, 0.025], [0, 0.03, 0], P.dark);
    zcyl(0.05, 0.24, [0, 0.075, 0.04], P.white, { rough: 0.35, seg: 14 });
    b.box([0.125, 0.008, 0.29], [0, 0.13, 0.05], P.white, { rough: 0.35 });
    zcyl(0.047, 0.02, [0, 0.075, 0.17], P.dark, { seg: 14 });
    zcyl(0.028, 0.012, [0, 0.075, 0.182], "#0d1620", { rough: 0.05, metal: 0.7, seg: 14 });
    zcyl(0.012, 0.004, [0, 0.075, 0.19], "#3a6a9a", { glow: 0.6, seg: 10 });
    b.box([0.01, 0.01, 0.005], [0.03, 0.04, 0.181], P.red, { glow: 2, blink: 2.5 });
    zcyl(0.048, 0.02, [0, 0.075, -0.09], P.grey, { seg: 14 });
  }
  function staticCam(side: Side, u: number, y: number, yaw: number, pitch: number) {
    wall(side, u, y, () => {
      camMount();
      b.at([0, 0, 0.22], [0, yaw, 0], () => b.at([0, 0, 0], [pitch, 0, 0], camHead));
    });
  }
  function lightStrip(len: number) {
    b.box([0.14, len + 0.06, 0.02], [0, 0, 0.01], P.dark, FRAME);
    b.box([0.07, len, 0.012], [0, 0, 0.024], "#eef6ff", { glow: 0.85 });
  }

  // ---- ceiling + floor -------------------------------------------------------------------------
  function troffer(x: number, z: number) {
    const y = H - 0.018;
    for (const s of [-1, 1]) b.box([1.72, 0.03, 0.06], [x, y, z + s * 0.28], P.steel, METAL);
    for (const s of [-1, 1]) b.box([0.06, 0.03, 0.5], [x + s * 0.83, y, z], P.steel, METAL);
  }
  function ceilingVent(x: number, z: number) {
    b.at([x, H, z], [Math.PI / 2, 0, 0], () => vent(0.6, 0.6));
  }
  function pipeRun(a: Vec3, e: Vec3, r: number, col: Color, bands?: Color) {
    const len = Math.hypot(e[0] - a[0], e[2] - a[2]);
    const alongX = Math.abs(e[0] - a[0]) > Math.abs(e[2] - a[2]);
    const cylAlong = alongX ? xcyl : zcyl;
    cylAlong(r, len, [(a[0] + e[0]) / 2, a[1], (a[2] + e[2]) / 2], col, { rough: 0.35, metal: 0.6, seg: 12 });
    const n = Math.floor(len / 1.1);
    for (let k = 1; k <= n; k++) {
      const f = k / (n + 1), p: Vec3 = [a[0] + (e[0] - a[0]) * f, a[1], a[2] + (e[2] - a[2]) * f];
      cylAlong(r * 1.25, 0.04, p, P.dark, { seg: 12 });
      b.cyl(0.008, 0.008, H - p[1], [p[0], (H + p[1]) / 2, p[2]], P.dark, { seg: 6 });
      if (bands && k % 2) {
        const q: Vec3 = [p[0] + (alongX ? 0.35 : 0), p[1], p[2] + (alongX ? 0 : 0.35)];
        cylAlong(r * 1.03, 0.12, q, bands, { rough: 0.4, seg: 12 });
      }
    }
  }
  /**
   * Bundle of cables sagging between J-hooks along a side wall, from one wall-mounted pull box to
   * another (`box0` / `box1`: the boxes' z extents; the bundle's ends run into them).
   */
  function cableRun(x: number, z0: number, z1: number, y: number, inward: number, box0: [number, number], box1: [number, number]) {
    const hooks = Math.max(2, Math.round((z1 - z0) / 1.4));
    for (let k = 1; k < hooks; k++) {
      const z = z0 + ((z1 - z0) * k) / hooks;
      b.box([0.12, 0.015, 0.03], [x + inward * 0.05, y + 0.06, z], P.dark, METAL);
      b.box([0.015, 0.08, 0.03], [x + inward * 0.11, y + 0.025, z], P.dark, METAL);
    }
    for (const [za, zb] of [box0, box1]) {
      b.box([0.13, 0.13, zb - za], [x + inward * 0.065, y - 0.04, (za + zb) / 2], P.grey, METAL);
      b.box([0.134, 0.01, zb - za + 0.004], [x + inward * 0.065, y + 0.02, (za + zb) / 2], P.dark, METAL); // lid seam
    }
    const cols: Color[] = [P.black, P.dark, P.orange, P.blue];
    cols.forEach((col, ci) => {
      const pts: Vec3[] = [];
      for (let k = 0; k <= hooks; k++) {
        const z = z0 + ((z1 - z0) * k) / hooks;
        pts.push([x + inward * (0.035 + ci * 0.018), y + ci * 0.008, z]);
        if (k < hooks) pts.push([x + inward * (0.035 + ci * 0.02), y - 0.1 - ci * 0.035, z + (z1 - z0) / hooks / 2]);
      }
      b.tube(pts, 0.011, col, { seg: pts.length * 5, rough: 0.6 });
    });
  }
  function drain(x: number, z: number) {
    flat([0.36, 0.36], [x, 0.003, z], "#fff", { tex: tx.drain, metal: 0.6, rough: 0.4 });
  }
  function stencil(t: UVRect, x: number, z: number, w: number, h: number, spin = 0) {
    flat([w, h], [x, 0.003, z], "#fff", { tex: t, rough: 0.8, rot: [0, 0, spin] });
  }
  function hazardRect(cx: number, cz: number, w: number, dz: number, t = 0.07) {
    for (const s of [-1, 1]) flat([w, t], [cx, 0.003, cz + s * (dz / 2 - t / 2)], "#fff", { tex: tx.hazard, rough: 0.7 });
    for (const s of [-1, 1]) flat([dz - 2 * t, t], [cx + s * (w / 2 - t / 2), 0.003, cz], "#fff", { tex: tx.hazard, rough: 0.7, rot: [0, 0, Math.PI / 2] });
  }

  // ---- test elements ---------------------------------------------------------------------------
  function floorButton(at: Vec3) {
    b.at(at, null, () => {
      b.lathe([[0, 0], [0.55, 0], [0.55, 0.02], [0.5, 0.05], [0.4, 0.06], [0.4, 0.075], [0.36, 0.075], [0.36, 0.05], [0, 0.05]], [0, 0, 0], P.white, { rough: 0.4, seg: 32 });
      b.torus(0.455, 0.008, [0, 0.055, 0], P.orange, { rot: [Math.PI / 2, 0, 0], seg: 40, glow: 1.0 });
      b.lathe([[0, 0.05], [0.34, 0.05], [0.34, 0.1], [0.32, 0.115], [0.12, 0.12], [0, 0.12]], [0, 0, 0], P.red, { rough: 0.35, glow: 0.22, seg: 32 });
      b.torus(0.22, 0.006, [0, 0.118, 0], "#9a1d18", { rot: [Math.PI / 2, 0, 0], seg: 28 });
    });
  }
  function pedestalButton(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      b.cyl(0.17, 0.19, 0.03, [0, 0.015, 0], P.grey, { seg: 20, rough: 0.4 });
      b.lathe([[0.055, 0], [0.036, 0.06], [0.032, 0.7], [0.048, 0.82], [0.05, 0.84], [0, 0.845]], [0, 0.03, 0], P.white, { rough: 0.35, seg: 16 });
      b.cyl(0.037, 0.037, 0.05, [0, 0.45, 0], P.dark, { seg: 16 });
      b.at([0, 0.88, 0], [0.35, 0, 0], () => {
        b.cyl(0.075, 0.085, 0.05, [0, 0, 0], P.white, { rough: 0.35, seg: 20 });
        b.cyl(0.05, 0.05, 0.03, [0, 0.035, 0], P.red, { glow: 0.3, seg: 20, rough: 0.3 });
        b.torus(0.062, 0.005, [0, 0.026, 0], P.dark, { rot: [Math.PI / 2, 0, 0], seg: 20 });
      });
      b.tube([[0, 0.012, -0.15], [-0.1, 0.012, -0.45], [-0.42, 0.012, -0.85], [-0.5, 0.012, -0.975]], 0.012, P.black, { seg: 16 }); // into the wall beside the exit door
    });
  }
  /** Weighted storage cube (grey, dark corners, round emblems). */
  function storageCube(sz: number) {
    b.box([sz * 0.92, sz * 0.92, sz * 0.92], [0, 0, 0], "#b9bec4", { rough: 0.5, metal: 0.2 });
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) b.box([sz * 0.3, sz * 0.3, sz * 0.3], [x * sz * 0.36, y * sz * 0.36, z * sz * 0.36], "#5a5f68", { rough: 0.5, metal: 0.3 });
    const faces: [Vec3, Vec3][] = [[[0, 0, 1], [Math.PI / 2, 0, 0]], [[0, 0, -1], [Math.PI / 2, 0, 0]], [[1, 0, 0], [0, 0, Math.PI / 2]], [[-1, 0, 0], [0, 0, Math.PI / 2]], [[0, 1, 0], [0, 0, 0]], [[0, -1, 0], [0, 0, 0]]];
    for (const [n, rot] of faces) {
      const p = (k: number): Vec3 => [n[0] * k, n[1] * k, n[2] * k];
      b.cyl(sz * 0.17, sz * 0.17, 0.008, p(sz * 0.462), "#5a5f68", { rot, seg: 16 });
      b.cyl(sz * 0.09, sz * 0.09, 0.008, p(sz * 0.466), P.orange, { rot, seg: 12, glow: 0.4 });
    }
  }
  /** Cube dispenser hanging from the ceiling point `at` (a caged cube waiting inside). */
  function dispenser(at: Vec3) {
    b.at(at, null, () => {
      b.cyl(0.47, 0.47, 0.04, [0, -0.02, 0], P.grey, { seg: 24, ...FRAME }); // (clear of the troffer next to it)
      b.cyl(0.42, 0.42, 0.32, [0, -0.2, 0], P.white, { seg: 24, rough: 0.4 });
      b.cyl(0.44, 0.44, 0.05, [0, -0.385, 0], P.dark, { seg: 24 });
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        b.cyl(0.013, 0.013, 0.6, [Math.cos(a) * 0.4, -0.71, Math.sin(a) * 0.4], P.steel, { ...METAL, seg: 6 });
      }
      for (const y of [-0.42, -0.72]) b.torus(0.4, 0.016, [0, y, 0], P.steel, { ...METAL, rot: [Math.PI / 2, 0, 0], seg: 28 });
      b.at([0, -0.74, 0], [0.12, 0.55, 0.06], () => storageCube(0.4));
      b.cyl(0.46, 0.42, 0.18, [0, -1.1, 0], P.white, { seg: 24, rough: 0.4 });
      b.cyl(0.462, 0.455, 0.05, [0, -1.05, 0], "#fff", { open: true, seg: 24, tex: tx.hazard, rough: 0.6 });
      b.cyl(0.44, 0.44, 0.02, [0, -1.19, 0], P.dark, { seg: 24 });
      for (let k = 0; k < 4; k++)
        b.at([0, -1.2, 0], [0, (k * Math.PI) / 2 + Math.PI / 4, 0], () =>
          b.at([0.4, 0, 0], [0, 0, 1.25], () => {
            b.box([0.2, 0.018, 0.42], [-0.1, 0, 0], P.white, { rough: 0.4 });
            b.box([0.2, 0.004, 0.42], [-0.1, -0.011, 0], P.dark);
          }),
        );
      b.plane([0.34, 0.08], [0, -0.2, 0.4205], "#fff", { tex: tx.logo, glow: 0.1 });
    });
  }
  /** A sleeping sentry turret (white shell halves, dark core, one dim red eye). */
  function turret(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      const R = 0.2, S: Vec3 = [0.62, 1.45, 0.8], cy = 0.7;
      b.geo(new THREE.SphereGeometry(R * 0.93, 16, 12), [0, cy, 0], P.black, { scale: S, rough: 0.5 });
      for (const s of [-1, 1]) b.geo(new THREE.SphereGeometry(R, 18, 14, s > 0 ? Math.PI / 2 : -Math.PI / 2, Math.PI), [s * 0.014, cy, 0], P.white, { scale: S, rough: 0.3 });
      const ez = R * S[2] * 0.93;
      b.sphere(0.022, [0, cy + 0.07, ez - 0.004], P.red, { glow: 1.1, blink: 0.8, seg: 10 });
      b.torus(0.026, 0.005, [0, cy + 0.07, ez - 0.006], P.dark, { seg: 14 });
      const legs: Vec3[][] = [
        [[0, cy - 0.22, -0.05], [0, 0.36, -0.24], [0, 0.0, -0.34]],
        [[0.05, cy - 0.24, 0.03], [0.17, 0.3, 0.13], [0.24, 0.0, 0.22]],
        [[-0.05, cy - 0.24, 0.03], [-0.17, 0.3, 0.13], [-0.24, 0.0, 0.22]],
      ];
      for (const l of legs) {
        b.tube(l, 0.014, P.dark, { seg: 10, ...FRAME });
        b.box([0.05, 0.02, 0.07], [l[2][0], 0.01, l[2][2]], P.white, { rough: 0.4 });
      }
      b.cyl(0.007, 0.007, 0.06, [0, cy + R * S[1] + 0.01, -0.03], P.dark, { seg: 6 });
    });
  }
  function faithPlate(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      b.box([1.16, 0.03, 1.16], [0, 0.015, 0], P.dark, FRAME);
      hazardRect(0, 0, 1.46, 1.46, 0.08);
      for (const s of [-1, 1]) b.cyl(0.03, 0.03, 0.16, [s * 0.32, 0.07, -0.28], P.chrome, { ...METAL, rot: [0.6, 0, 0], seg: 10 });
      b.at([0, 0.075, 0], [-0.1, 0, 0], () => {
        b.box([1.0, 0.05, 1.0], [0, 0, 0], P.white, { rough: 0.35 });
        flat([0.92, 0.92], [0, 0.0255, 0], "#fff", { tex: tx.faith, glow: 0.12, rough: 0.4 });
      });
      for (const [x, z] of [[-0.54, -0.54], [0.54, -0.54], [-0.54, 0.54], [0.54, 0.54]] as const) b.box([0.05, 0.035, 0.05], [x, 0.03, z], P.orange, { glow: 1.0, blink: 2.4 });
    });
  }
  /** Hard-light bridge from an emitter on the left wall across to the right wall. */
  function lightBridge(y: number, z: number, w = 0.6) {
    const x0 = -W / 2 + 0.27, x1 = W / 2 - 0.005, len = x1 - x0, xm = (x0 + x1) / 2;
    wall("left", z, y, () => {
      slab(w + 0.25, 0.34, 0.26, 0.05, [0, 0, 0], P.white, PLAST);
      for (const s of [-1, 1]) b.box([0.05, 0.44, 0.22], [s * (w / 2 + 0.16), 0, 0.11], P.grey, METAL);
      b.box([w + 0.04, 0.06, 0.012], [0, 0, 0.262], P.black);
      b.box([w, 0.02, 0.01], [0, 0, 0.266], "#8fd6ff", { glow: 1.8 });
      b.plane([w + 0.2, 0.05], [0, 0.13, 0.2605], "#fff", { tex: tx.hazard, rough: 0.6 });
    });
    b.plane([len, w], [xm, y + 0.004, z], "#c4ecff", { tex: tx.bridge, glow: 0.55, rot: [-Math.PI / 2, 0, 0] });
    b.plane([len, w], [xm, y - 0.004, z], "#c4ecff", { tex: tx.bridge, glow: 0.55, rot: [Math.PI / 2, 0, 0] });
    for (const s of [-1, 1]) b.box([len, 0.014, 0.014], [xm, y, z + (s * w) / 2], "#9ad8ff", { glow: 1.4 });
    // where it lands: a faint scorch line on the right wall
    b.box([0.006, 0.03, w], [W / 2 - 0.003, y, z], "#9ad8ff", { glow: 0.8 });
  }
  function gasCylinder(at: Vec3, body: Color, band: Color, h = 1.4) {
    b.at(at, null, () => {
      const r = 0.11;
      b.lathe([[0, 0], [r * 0.95, 0], [r, 0.02], [r, h - 0.16], [r * 0.82, h - 0.07], [0.04, h - 0.02], [0.035, h], [0, h]], [0, 0, 0], body, { rough: 0.35, metal: 0.25, seg: 16 });
      b.cyl(r + 0.002, r + 0.002, 0.07, [0, h - 0.28, 0], band, { open: true, seg: 16, rough: 0.35 });
      b.cyl(0.018, 0.022, 0.07, [0, h + 0.035, 0], "#b08a3a", { ...METAL, seg: 10 });
      b.torus(0.03, 0.006, [0, h + 0.075, 0], P.dark, { rot: [Math.PI / 2, 0, 0], seg: 12 });
      zcyl(0.025, 0.02, [0, h + 0.03, -0.035], P.chrome, { ...METAL, seg: 12 });
      zcyl(0.021, 0.003, [0, h + 0.03, -0.046], "#f4f4f4", { seg: 12 });
    });
  }
  function dewar(at: Vec3) {
    b.at(at, null, () => {
      b.cyl(0.21, 0.21, 0.05, [0, 0.025, 0], P.dark, { seg: 20 });
      b.lathe([[0, 0], [0.19, 0], [0.205, 0.03], [0.205, 0.58], [0.15, 0.68], [0.06, 0.7], [0.06, 0.78], [0, 0.78]], [0, 0.05, 0], P.chrome, { rough: 0.22, metal: 0.9, seg: 20 });
      b.cyl(0.207, 0.207, 0.13, [0, 0.42, 0], "#fff", { open: true, seg: 20, tex: tx.ln2, rot: [0, Math.PI, 0] });
      for (const s of [-1, 1]) b.torus(0.05, 0.008, [s * 0.12, 0.76, 0], P.dark, { rot: [0, Math.PI / 2, 0], arc: Math.PI, seg: 10 });
      b.cyl(0.03, 0.03, 0.06, [0, 0.86, 0], P.mid, { seg: 10 });
      b.sphere(0.03, [0, 0.9, 0], "#eaf6ff", { glow: 0.25, seg: 8 });
    });
  }

  /** Cardboard box, label facing -z (out from the front wall). */
  function cardboard(at: Vec3, size: Vec3, rotY: number) {
    b.at(at, [0, rotY + Math.PI, 0], () => {
      b.box(size, [0, size[1] / 2, 0], "#c99a62", { rough: 0.9 });
      b.box([size[0] + 0.004, 0.003, 0.06], [0, size[1] + 0.001, 0], "#d6b483", { rough: 0.5 });
      b.box([0.06, size[1] * 0.3, size[2] + 0.004], [0, size[1] * 0.85, 0], "#d6b483", { rough: 0.5 });
      b.plane([size[0] * 0.8, size[1] * 0.5], [0, size[1] * 0.45, size[2] / 2 + 0.002], "#fff", { tex: tx.boxLabel, rough: 0.9 });
    });
  }
  function wetFloor(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      for (const s of [-1, 1])
        b.at([0, 0.62, 0], [-s * 0.18, 0, 0], () => {
          b.box([0.3, 0.63, 0.012], [0, -0.315, s * 0.006], P.yellow, { rough: 0.4 }); // 0.62 / cos(0.18): feet on the floor
          b.plane([0.26, 0.48], [0, -0.33, s * 0.0125], "#fff", { tex: tx.wet, rough: 0.4, rot: [0, s > 0 ? 0 : Math.PI, 0] });
        });
      b.box([0.32, 0.03, 0.03], [0, 0.62, 0], P.dark);
    });
  }
  /** Horn speaker for the announcer, angled down into the room (wall frame). */
  function paSpeaker() {
    b.box([0.07, 0.07, 0.14], [0, 0, 0.07], P.dark, METAL);
    b.at([0, -0.02, 0.15], [Math.PI / 2 + 0.4, 0, 0], () => {
      b.lathe([[0.035, 0], [0.045, 0.08], [0.12, 0.2], [0.125, 0.208], [0.112, 0.204], [0.04, 0.085], [0.03, 0.01]], [0, 0, 0], P.white, { rough: 0.35, seg: 16 });
      b.cyl(0.04, 0.04, 0.01, [0, 0.05, 0], P.dark, { seg: 12 });
    });
  }
  /** Floor-to-ceiling pipe with a red handwheel valve and a gauge, in a front corner. */
  function cornerPipe(x: number, z: number, faceX: number, vy = 1.35) {
    b.cyl(0.045, 0.045, H, [x, H / 2, z], P.steel, { ...METAL, seg: 12 });
    for (const y of [0.5, 2.3, 4.1]) b.cyl(0.058, 0.058, 0.05, [x, y, z], P.dark, { seg: 12 });
    b.cyl(0.07, 0.07, 0.18, [x, vy, z], "#b08a3a", { ...METAL, seg: 12 });
    b.at([x + faceX * 0.13, vy, z], [0, Math.PI / 2, 0], () => {
      b.torus(0.1, 0.013, [0, 0, 0], P.red, { rough: 0.4, seg: 20 });
      for (let k = 0; k < 3; k++) b.box([0.2, 0.014, 0.014], [0, 0, 0], P.red, { rough: 0.4, rot: [0, 0, (k * Math.PI) / 3] });
    });
    xcyl(0.015, 0.13, [x + faceX * 0.065, vy, z], P.dark, { seg: 8 });
    b.at([x + faceX * 0.06, vy + 0.4, z], [0, faceX > 0 ? Math.PI / 2 : -Math.PI / 2, 0], () => {
      zcyl(0.05, 0.03, [0, 0, 0], P.chrome, { ...METAL, seg: 16 });
      b.plane([0.085, 0.085], [0, 0, 0.0155], "#fff", { tex: tx.gauge, rough: 0.3 });
    });
  }
  function intercom() {
    slab(0.22, 0.34, 0.03, 0.02, [0, 0, 0], P.panel, PLAST);
    for (let k = 0; k < 5; k++) b.box([0.13, 0.008, 0.004], [0, 0.1 - k * 0.02, 0.031], P.dark);
    zcyl(0.025, 0.02, [0, -0.06, 0.04], P.red, { rough: 0.35, seg: 14 });
    b.box([0.012, 0.012, 0.006], [0.07, -0.06, 0.033], P.green, { glow: 1.6, blink: 1.1 }); // beside the button, clear of the label
    b.plane([0.16, 0.04], [0, -0.13, 0.031], "#fff", { tex: tx.talk, rough: 0.6 });
  }
  /** A row of ten status lights: the first `frac` of them lit (wall frame, centred). */
  function progressLights(frac: number, color: Color, label: UVRect) {
    slab(1.62, 0.36, 0.04, 0.05, [0, 0, 0], P.dark, FRAME);
    const n = Math.round(frac * 10);
    for (let k = 0; k < 10; k++) b.box([0.11, 0.11, 0.02], [-0.675 + k * 0.15, -0.05, 0.05], k < n ? color : "#3a3d44", { glow: k < n ? 0.85 : 0, rough: 0.3 });
    b.plane([1.4, 0.09], [0, 0.1, 0.0405], "#fff", { tex: label, glow: 0.3 });
  }
  function sticky(at: Vec3, rotZ: number) {
    b.plane([0.075, 0.075], at, "#fff", { tex: tx.sticky, rough: 0.8, rot: [0, 0, rotZ] });
  }

  function baseboards() {
    const t = 0.07, dz = 0.012;
    for (const s of [-1, 1]) {
      b.box([W, t, dz], [0, t / 2, s * (D / 2 - dz / 2)], P.dark, FRAME);
      b.box([dz, t, D], [s * (W / 2 - dz / 2), t / 2, 0], P.dark, FRAME);
    }
  }
  /** Portal-style articulated wall panels, pushed out at different depths (wall frame, centred). */
  function panelCluster() {
    b.box([1.3, 1.3, 0.02], [0, 0, 0.01], P.black);
    const cells: [number, number, number][] = [[-0.31, 0.31, 0.07], [0.31, 0.31, 0.24], [-0.31, -0.31, 0.14], [0.31, -0.31, 0.03]];
    for (const [x, y, dz] of cells) {
      if (dz > 0.04) {
        b.box([0.5, 0.5, dz], [x, y, dz / 2 + 0.01], P.mid, FRAME);
        for (const sx of [-1, 1]) zcyl(0.014, dz, [x + sx * 0.16, y - 0.27, dz / 2 + 0.01], P.chrome, { ...METAL, seg: 8 });
      }
      slab(0.58, 0.58, 0.05, 0.03, [x, y, dz], P.white, PLAST);
    }
  }
  function gloveBox(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      b.box([0.24, 0.075, 0.12], [0, 0.0375, 0], "#f2f4f7", PLAST);
      b.box([0.242, 0.028, 0.122], [0, 0.035, 0], P.blue, PLAST);
      b.sphere(0.03, [0.02, 0.078, 0], "#7fb8ff", { seg: 8, scale: [1.5, 0.5, 1] });
    });
  }
  function goggles(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      for (const s of [-1, 1]) b.cyl(0.03, 0.028, 0.03, [s * 0.034, 0.015, 0], "#cfe8f0", { ...GLASS, seg: 12 });
      b.box([0.022, 0.012, 0.012], [0, 0.022, 0], P.dark);
      b.torus(0.072, 0.004, [0, 0.008, -0.01], P.orange, { rot: [-Math.PI / 2, 0, 0], arc: Math.PI, seg: 12 });
    });
  }
  function notebook(at: Vec3, rotY: number, col: Color) {
    b.at(at, [0, rotY, 0], () => {
      b.box([0.17, 0.018, 0.23], [0, 0.009, 0], col, { rough: 0.7 });
      b.box([0.16, 0.012, 0.225], [0.006, 0.009, 0], "#f4f2ea", { rough: 0.9 });
      b.box([0.17, 0.0185, 0.03], [0, 0.009, 0.08], P.white, { rough: 0.7 });
    });
  }
  function mopBucket(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      b.lathe([[0, 0.03], [0.17, 0.03], [0.2, 0.33], [0.21, 0.34], [0.19, 0.34], [0.165, 0.07]], [0, 0, 0], P.yellow, { rough: 0.45, seg: 18 });
      b.cyl(0.183, 0.183, 0.004, [0, 0.27, 0], "#6aa0b8", { seg: 18, rough: 0.1, metal: 0.2 });
      for (const [x, z] of [[0.13, 0.13], [-0.13, 0.13], [0.13, -0.13], [-0.13, -0.13]] as const) b.sphere(0.028, [x, 0.028, z], P.dark, { seg: 8 });
      b.box([0.2, 0.16, 0.12], [0, 0.42, -0.12], P.grey, FRAME);
      b.box([0.03, 0.2, 0.03], [0.09, 0.5, -0.04], P.mid, FRAME);
      b.torus(0.2, 0.006, [0, 0.34, 0], P.mid, { arc: Math.PI, seg: 12 });
      b.cyl(0.012, 0.012, 1.3, [0.04, 0.72, 0.05], "#d8b77a", { rot: [0.22, 0, -0.18], seg: 8 });
      b.cyl(0.07, 0.05, 0.14, [-0.03, 0.12, -0.04], "#e8e4d8", { seg: 10, rough: 1 });
    });
  }
  /** A two-shelf rolling lab trolley with supplies. */
  function trolley(at: Vec3, rotY: number) {
    b.at(at, [0, rotY, 0], () => {
      const w = 0.5, dp = 0.38;
      for (const y of [0.22, 0.78]) {
        b.box([w, 0.02, dp], [0, y, 0], P.steel, METAL);
        b.box([w, 0.04, 0.01], [0, y + 0.02, dp / 2], P.steel, METAL);
      }
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        b.cyl(0.012, 0.012, 0.82, [(x * (w - 0.03)) / 2, 0.46, (z * (dp - 0.03)) / 2], P.chrome, { ...METAL, seg: 8 }); // caster to handle
        b.sphere(0.03, [(x * (w - 0.03)) / 2, 0.03, (z * (dp - 0.03)) / 2], P.dark, { seg: 8 });
      }
      xcyl(0.012, w, [0, 0.865, -(dp - 0.03) / 2], P.chrome, { ...METAL, seg: 8 }); // on top of the back posts
      b.at([0, 0.79, 0], null, () => {
        gloveBox([-0.1, 0, 0.05], 0.1);
        beaker([0.14, 0, -0.06], 0.035, 0.09, 0.5, P.green);
        bottle([0.16, 0, 0.09], 0.028, 0.15, "#8a4a14", P.black);
      });
      b.at([0, 0.23, 0], null, () => {
        cardboardSmall([-0.08, 0, 0], [0.26, 0.16, 0.24]);
        bottle([0.15, 0, 0.03], 0.04, 0.22, "#e8e8e8", P.blue);
      });
    });
  }
  function cardboardSmall(at: Vec3, size: Vec3) {
    b.box(size, [at[0], at[1] + size[1] / 2, at[2]], "#c99a62", { rough: 0.9 });
    b.box([size[0] + 0.004, 0.003, 0.05], [at[0], at[1] + size[1] + 0.001, at[2]], "#d6b483", { rough: 0.5 });
  }

  // ---- shared by both chambers ---------------------------------------------------------------
  function common(i: number) {
    baseboards();
    // pipes along the top of the side and front walls, hung from the ceiling
    pipeRun([-W / 2 + 0.18, 5.05, -D / 2], [-W / 2 + 0.18, 5.05, D / 2], 0.055, P.steel); // (clear of the front-left corner pipe)
    pipeRun([-W / 2 + 0.3, 5.08, -D / 2], [-W / 2 + 0.3, 5.08, D / 2], 0.035, P.white, P.orange);
    pipeRun([W / 2 - 0.13, 5.03, -D / 2], [W / 2 - 0.13, 5.03, D / 2], 0.07, P.white, P.blue);
    // the front pipe elbows into the front wall short of the floor-to-ceiling corner pipe
    pipeRun([-W / 2 + 0.3, 4.78, D / 2 - 0.12], [W / 2, 4.78, D / 2 - 0.12], 0.06, P.grey, P.yellow);
    b.sphere(0.06, [-W / 2 + 0.3, 4.78, D / 2 - 0.12], P.grey, { rough: 0.35, metal: 0.6, seg: 12 });
    zcyl(0.06, 0.12, [-W / 2 + 0.3, 4.78, D / 2 - 0.06], P.grey, { rough: 0.35, metal: 0.6, seg: 12 });
    zcyl(0.08, 0.02, [-W / 2 + 0.3, 4.78, D / 2 - 0.01], P.dark, { seg: 12 });
    // cable bundles between pull boxes: the back ones sit on the corner conduits; the front-left one
    // stops short of the corner pipe
    cableRun(-W / 2, -D / 2 + 0.1, D / 2 - 0.24, 4.62, 1, [-D / 2, -D / 2 + 0.16], [D / 2 - 0.3, D / 2 - 0.18]);
    cableRun(W / 2, -D / 2 + 0.1, D / 2 - 0.1, 4.62, -1, [-D / 2, -D / 2 + 0.16], [D / 2 - 0.16, D / 2]);
    for (const [x, z] of [[-2.5, -1.5], [2.5, -1.5], [-2.5, 1.5], [2.5, 1.5]]) troffer(x, z);
    ceilingVent(-2.5, 0);
    ceilingVent(0, -0.4);
    // back corners: recessed light strips and a conduit, beyond the edges of the game grid
    for (const s of [-1, 1]) {
      wall("back", s * 4.22, 2.9, () => lightStrip(3.0));
      b.cyl(0.035, 0.035, 4.53, [s * 4.42, 4.53 / 2, -D / 2 + 0.07], P.grey, { ...METAL, seg: 10 }); // up into the pull box
      for (const y of [0.8, 2.4, 4.0]) b.box([0.1, 0.03, 0.09], [s * 4.42, y, -D / 2 + 0.045], P.dark, METAL);
    }
    // right wall, clear of the chamber sign and the stats boards
    wall("right", -2.75, 2.0, pictoPanel);
    wall("right", -2.75, 0.3, () => vent(0.5, 0.22));
    wall("right", -0.25, 1.95, () => poster(i ? tx.poster2 : tx.poster1, 0.42, 0.56));
    wall("right", -0.25, 0, extinguisher);
    wall("right", -0.62, 4.15, () => vent(0.9, 0.36));
    // left wall: warning beacon over the portal
    wall("left", 0.6, 2.62, () => b.at([0, 0, 0], null, () => beacon(), [1.5, 1.5, 1.5]));
    wall("left", 0.6, 3.65, panelCluster);
    // front wall: low intake vent under the boards
    wall("front", 0.6, 0.27, () => vent(0.8, 0.24));
    // announcer horns high in the front corners, a valve pipe in the front-left corner
    wall("left", 3.15, 4.3, paSpeaker);
    wall("right", 3.15, 4.3, paSpeaker);
    cornerPipe(-W / 2 + 0.07, D / 2 - 0.12, 1, i ? 2.8 : 1.35);
    // testing progress lights above the chamber sign
    const st = c.store.stats;
    const excellent = st.completed ? (st.grades["A+"] + st.grades.A) / st.completed : 0;
    wall("right", -2.0, 3.78, () => (i ? progressLights(excellent, P.blue, tx.lblExcellent) : progressLights(st.pct, P.amber, tx.lblCleared)));
  }

  // ---- chamber 01: test queue -----------------------------------------------------------------
  let camPivot: THREE.Vector3 | null = null;
  function chamberA(o: THREE.Vector3) {
    // left wall: bench + whiteboard + clock, racks in the front corner
    wall("left", -1.45, 0, () => {
      bench(2.2);
      b.at([0, 0.9, 0], null, () => {
        microscope([-0.85, 0, 0.3], 0.15);
        tubeRack([-0.45, 0, 0.14], 7);
        beaker([-0.55, 0, 0.47], 0.04, 0.1, 0.55, P.orange);
        beaker([-0.4, 0, 0.53], 0.03, 0.075, 0.6, P.blue);
        centrifuge([-0.06, 0, 0.3], -0.1);
        erlenmeyer([0.26, 0, 0.47], 0.055, 0.17, 0.5, P.green);
        erlenmeyer([0.3, 0, 0.18], 0.045, 0.14, 0.45, P.pink);
        clipboard([0.48, 0, 0.47], 0.25);
        crt([0.7, 0, 0.36], -0.15, 0.32, tx.crtText);
        mug([0.92, 0, 0.5], -0.5);
        cactus([0.98, 0, 0.18]);
        goggles([-0.62, 0, 0.32], 0.4);
        gloveBox([0.06, 0, 0.56], -0.05);
      });
    });
    wall("left", -1.45, 1.98, () => whiteboard(2.0, 1.0));
    wall("left", -1.45, 3.2, clock);
    wall("left", 2.34, 0, rack);
    wall("left", 2.96, 0, rack);
    // front wall, above the boards: the observation room
    wall("front", 0.5, 4.08, () => obsWindow(2.8, 0.9));
    // front-right corner pocket: gas cylinders chained to the wall
    gasCylinder([4.33, 0, 3.33], "#4a7a52", P.white);
    gasCylinder([4.05, 0, 3.36], P.white, P.blue, 1.32);
    {
      // a chain from the front wall, round the fronts of both cylinders (r 0.11 + clearance), to the right wall
      const R = 0.12, arc = (cx: number, cz: number, a0: number, a1: number, n: number) =>
        Array.from({ length: n + 1 }, (_, k) => a0 + ((a1 - a0) * k) / n).map((a): [number, number] => [cx + R * Math.cos(a), cz + R * Math.sin(a)]);
      const path: [number, number][] = [[3.93, 3.505], [3.93, 3.42], ...arc(4.05, 3.36, Math.PI, Math.PI * 1.5, 4), [4.19, 3.228], ...arc(4.33, 3.33, Math.PI * 1.5, Math.PI * 1.9, 4), [4.505, 3.31]];
      for (const y of [0.75, 1.1]) b.tube(path.map(([x, z]): Vec3 => [x, y, z]), 0.006, P.steel, { ...METAL, seg: 48 });
    }
    // the cube dispenser hangs right over the companion cube, inside a drop zone
    dispenser([2.7, H, 2.3]);
    hazardRect(2.7, 2.3, 1.05, 1.05, 0.07);
    stencil(tx.stDrop, 2.7, 1.62, 1.0, 0.13);
    floorButton([0.55, 0, 2.2]);
    stencil(tx.stIntake, -2.6, 2.32, 1.5, 0.19, Math.PI);
    drain(-1.1, 0.5);
    drain(1.8, -1.2);
    // unopened acquisitions stacked under the boards (kept below 0.8 m)
    cardboard([1.62, 0, 3.17], [0.5, 0.4, 0.42], 0.08);
    cardboard([1.6, 0.4, 3.18], [0.38, 0.3, 0.34], -0.12);
    cardboard([2.12, 0, 3.25], [0.34, 0.26, 0.3], 0.3);
    wall("left", 1.65, 1.45, intercom);
    trolley([4.15, 0, -3.15], -Math.PI / 2);
    wall("front", -4.0, 3.65, () => b.at([0, 0, 0], null, () => beacon(P.red), [1.5, 1.5, 1.5]));
    wall("left", -1.45, 1.98, () => {
      sticky([0.03, 0.375, 0.022], 0.12); // a clear patch right of the title, not over the writing
      sticky([0.115, 0.345, 0.023], -0.18);
    });
    // security camera mount in the back-right corner (head pans, see below)
    wall("right", -3.2, 4.3, camMount); // below the cable bundle
    camPivot = new THREE.Vector3(W / 2 - 0.22, 4.3, -3.2).add(o);
  }

  // ---- chamber 02: results -----------------------------------------------------------------------
  let armShoulder: THREE.Vector3 | null = null;
  function chamberB(o: THREE.Vector3) {
    // left wall: bench + reagent shelves under the observation window, control desk at the front
    wall("left", -1.45, 0, () => {
      bench(2.2);
      reagentShelf(2.0, [1.38, 1.78]);
      b.at([0, 0.9, 0], null, () => {
        oscilloscope([-0.78, 0, 0.32], 0.12);
        distillation([-0.32, 0, 0.32]);
        gradCylinder([0.18, 0, 0.18], 0.018, 0.2, 0.6, P.blue);
        gradCylinder([0.26, 0, 0.14], 0.014, 0.16, 0.4, P.green);
        beaker([0.22, 0, 0.47], 0.045, 0.11, 0.45, P.pink);
        clipboard([0.5, 0, 0.45], -0.2);
        mug([0.72, 0, 0.5], 0.4);
        bottle([0.9, 0, 0.2], 0.035, 0.2, "#8a4a14", P.black);
        bottle([0.98, 0, 0.32], 0.028, 0.16, "#2a5fa8", P.white);
        notebook([-0.08, 0, 0.535], 0.2, P.blue); // in front of the receiving flask, not under it
        goggles([-0.55, 0, 0.56], -0.3);
        gloveBox([0.93, 0, 0.53], 0.15);
      });
    });
    wall("left", -1.85, 3.7, () => obsWindow(2.3, 0.9));
    wall("left", 2.05, 0, controlDesk);
    wall("left", 2.05, 2.15, clock);
    chair([-3.42, 0, 2.0], -Math.PI / 2 + 0.35);
    // front wall, left of the boards: fume hood and the chamber exit
    wall("front", -3.63, 0, fumeHood);
    wall("front", -2.15, 0, () => {
      const w = 1.2, h = 2.3;
      for (const s of [-1, 1]) b.box([0.12, h + 0.12, 0.1], [s * (w / 2 + 0.06), (h + 0.12) / 2, 0.05], P.dark, FRAME);
      b.box([w + 0.24, 0.12, 0.1], [0, h + 0.06, 0.05], P.dark, FRAME);
      b.box([w, h, 0.03], [0, h / 2, 0.015], P.panel, PLAST);
      b.plane([w, h], [0, h / 2, 0.0305], "#fff", { tex: tx.door, rough: 0.4 });
      zcyl(0.035, 0.02, [0.45, h + 0.06, 0.105], P.orange, { glow: 1.2, seg: 12 });
      flat([w, 0.1], [0, 0.003, 0.16], "#fff", { tex: tx.hazard, rough: 0.7 });
    });
    wall("front", -2.15, 2.72, exitSign);
    stencil(tx.stExit, -2.15, 2.75, 1.0, 0.16, Math.PI);
    pedestalButton([-1.6, 0, 2.45], Math.PI - 0.2);
    // front-right corner pocket: liquid nitrogen
    dewar([4.2, 0, 3.24]);
    // hard-light bridge across the top of the front wall
    lightBridge(3.8, 2.83); // emitter clear of the corner pipe and the front wall
    // aerial faith plate + its launch stencil; a robotic arm services it from the ceiling
    faithPlate([1.3, 0, 0.75], 0);
    stencil(tx.stLaunch, 1.3, 1.72, 1.3, 0.16);
    const ax = 1.2, az = 1.9;
    b.cyl(0.27, 0.27, 0.04, [ax, H - 0.02, az], P.grey, { seg: 20, ...FRAME });
    b.cyl(0.17, 0.2, 0.18, [ax, H - 0.13, az], P.white, { seg: 20, rough: 0.4 });
    b.cyl(0.2, 0.2, 0.025, [ax, H - 0.23, az], P.orange, { seg: 20, rough: 0.4 });
    for (const s of [-1, 1]) b.box([0.22, 0.24, 0.03], [ax, H - 0.33, az + s * 0.125], P.mid, FRAME);
    armShoulder = new THREE.Vector3(ax, H - 0.36, az).add(o);
    turret([4.12, 0, -3.08], -0.93);
    wetFloor([-4.08, 0, -2.76], 0.7);
    mopBucket([-4.18, 0, -3.18], 0.5);
    cardboard([3.3, 0, 3.2], [0.48, 0.38, 0.4], -0.1);
    cardboard([3.32, 0.38, 3.22], [0.36, 0.3, 0.32], 0.15);
    wall("front", -2.15, 3.05, () => b.at([0, 0, 0], null, () => beacon(P.red), [1.5, 1.5, 1.5]));
    drain(-0.6, 0.2);
    staticCam("left", -3.2, 4.3, -0.62, 0.5); // below the cable bundle, clear of its pull box
  }

  // ---- build -----------------------------------------------------------------------------------
  for (const [i, o] of opts.origins.entries()) {
    await slice(() => {
      b.at([o.x, o.y, o.z], null, () => {
        common(i);
        if (i === 0) {
          chamberA(o);
          turret([-4.12, 0, -3.08], 0.93);
        } else chamberB(o);
      });
      c.scene.add(d.build(`lab-decor-${i}`));
    });
  }

  // moving parts share the material and atlas
  const sub = (fn: () => void, name: string) => {
    const s = d.sub();
    b = s;
    try {
      fn();
    } finally {
      b = d;
    }
    return s.build(name);
  };
  const head = sub(camHead, "lab-cam-head");
  if (camPivot) head.position.copy(camPivot);
  const upper = sub(() => {
    zcyl(0.09, 0.2, [0, 0, 0], P.dark, { ...FRAME, seg: 16 });
    zcyl(0.06, 0.24, [0, 0, 0], P.orange, { rough: 0.4, seg: 12 });
    slab(0.12, 0.52, 0.12, 0.04, [0, -0.26, -0.06], P.white, PLAST);
    b.box([0.125, 0.05, 0.125], [0, -0.17, 0], P.orange, { rough: 0.4 });
    b.cyl(0.024, 0.024, 0.22, [0.085, -0.2, 0], P.mid, { ...METAL, seg: 8 });
    b.cyl(0.014, 0.014, 0.2, [0.085, -0.38, 0], P.chrome, { ...METAL, seg: 8 });
    b.tube([[-0.05, 0.02, 0.07], [-0.08, -0.25, 0.07], [-0.05, -0.5, 0.07]], 0.012, P.black, { seg: 10 });
    zcyl(0.075, 0.17, [0, -0.5, 0], P.dark, { ...FRAME, seg: 14 });
  }, "lab-arm-upper");
  const fore = sub(() => {
    slab(0.09, 0.44, 0.09, 0.03, [0, -0.22, -0.045], P.white, PLAST);
    b.box([0.095, 0.04, 0.095], [0, -0.1, 0], P.orange, { rough: 0.4 });
    b.cyl(0.05, 0.05, 0.08, [0, -0.47, 0], P.dark, { seg: 12, ...FRAME });
    b.box([0.17, 0.04, 0.09], [0, -0.53, 0], P.grey, METAL);
    for (const s of [-1, 1]) {
      b.box([0.025, 0.12, 0.06], [s * 0.065, -0.6, 0], P.dark, FRAME);
      b.box([0.03, 0.03, 0.065], [s * 0.058, -0.66, 0], P.orange, { rough: 0.4 });
    }
    b.box([0.03, 0.01, 0.03], [0, -0.555, 0], "#9ad8ff", { glow: 2 });
  }, "lab-arm-fore");
  fore.position.set(0, -0.5, 0);
  upper.add(fore);
  if (armShoulder) upper.position.copy(armShoulder);
  c.scene.add(head, upper);
  const wallYaw = -Math.PI / 2;
  c.onUpdate((_dt, t) => {
    head.rotation.set(0.5, wallYaw + 0.64 + 0.5 * Math.sin(t * 0.21), 0, "YXZ");
    upper.rotation.z = 0.42 * Math.sin(t * 0.31) + 0.14 * Math.sin(t * 0.83);
    fore.rotation.z = -0.75 + 0.42 * Math.sin(t * 0.47 + 1.3);
  });
  console.info(`[lab] decor: ${Math.round(d.triangles / 1000)}k triangles, ${Math.round(busy)}ms of work (atlas ${Math.round(tTex)}ms) over ${Math.round(performance.now() - t0)}ms`);
}

// ---- atlas art ----------------------------------------------------------------------------------

function makeTextures(d: DecorBuilder, s: Stats) {
  const F = (wgt: number, px: number, fam = "Oswald") => `${wgt} ${Math.round(px)}px "${fam}", sans-serif`;

  const hazard = d.canvas(512, 32, (g, w, h) => {
    g.fillStyle = "#f2c230";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#1d1d1f";
    for (let x = -h; x < w + h; x += 40) {
      g.beginPath();
      g.moveTo(x, h);
      g.lineTo(x + 20, h);
      g.lineTo(x + 20 + h, 0);
      g.lineTo(x + h, 0);
      g.closePath();
      g.fill();
    }
  });

  const obs = d.canvas(512, 192, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#2a3440");
    bg.addColorStop(1, "#0b0f13");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(255,255,255,0.05)";
    for (let x = 0; x < w; x += 64) g.fillRect(x, 0, 2, 128);
    g.fillStyle = "#dfe8f0";
    g.fillRect(60, 6, 150, 5);
    g.fillRect(300, 6, 150, 5);
    const glowCone = g.createLinearGradient(0, 10, 0, 90);
    glowCone.addColorStop(0, "rgba(220,235,255,0.16)");
    glowCone.addColorStop(1, "rgba(220,235,255,0)");
    g.fillStyle = glowCone;
    g.fillRect(40, 10, 190, 80);
    g.fillRect(280, 10, 190, 80);
    const mon = (x: number, y: number, mw: number, mh: number, col: string) => {
      g.fillStyle = "#05080b";
      g.fillRect(x - 4, y - 4, mw + 8, mh + 8);
      g.fillStyle = col;
      g.fillRect(x, y, mw, mh);
      g.fillStyle = "rgba(0,0,0,0.4)";
      for (let yy = y + 6; yy < y + mh - 3; yy += 7) g.fillRect(x + 5, yy, mw * (0.3 + rand(yy + x) * 0.55), 2);
    };
    mon(66, 68, 72, 46, "#3cff9a");
    mon(156, 60, 88, 56, "#4fb2ff");
    mon(330, 70, 66, 46, "#ffb347");
    mon(412, 76, 52, 40, "#3cff9a");
    g.fillStyle = "#07090c";
    g.fillRect(0, 128, w, 64);
    g.fillStyle = "#1c242d";
    g.fillRect(0, 125, w, 4);
    g.fillStyle = "#020304";
    // a seated observer at the blue screen, another standing with a clipboard
    g.beginPath();
    g.arc(204, 100, 14, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.roundRect(176, 112, 56, 70, 18);
    g.fill();
    g.beginPath();
    g.arc(300, 58, 12, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.roundRect(283, 70, 36, 122, 14);
    g.fill();
    g.fillStyle = "#151b22";
    g.fillRect(310, 92, 18, 24);
    g.fillStyle = "#0e1318";
    g.fillRect(100, 112, 14, 14); // mug
    g.fillStyle = "rgba(255,255,255,0.08)";
    for (const [x, ww] of [[30, 60], [120, 24], [360, 70], [450, 22]]) {
      g.beginPath();
      g.moveTo(x, h);
      g.lineTo(x + ww, h);
      g.lineTo(x + ww + 90, 0);
      g.lineTo(x + 90, 0);
      g.closePath();
      g.fill();
    }
  });

  const board = d.canvas(640, 320, (g, w, h) => {
    g.fillStyle = "#f6f7f5";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(120,130,150,0.07)";
    for (let k = 0; k < 7; k++) g.fillRect(rand(k) * w, rand(k + 20) * h, 60 + rand(k + 40) * 120, 10 + rand(k + 60) * 22);
    const pen = (col: string, px: number, wgt = 500) => {
      g.fillStyle = col;
      g.strokeStyle = col;
      g.font = F(wgt, px, "Barlow Condensed");
    };
    const write = (txt: string, x: number, y: number, rot = 0) => {
      g.save();
      g.translate(x, y);
      g.rotate(rot);
      g.fillText(txt, 0, 0);
      g.restore();
    };
    const avgH = s.backlog ? Math.round(s.backlogHours / s.backlog) : 0;
    const days = Math.round(s.backlogHours / 24);
    pen("#1b2a4a", 42, 600);
    write("BACKLOG MATHS", 24, 50, -0.02);
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(24, 60);
    g.lineTo(250, 54);
    g.stroke();
    pen("#1f4fbf", 29);
    write(`${s.backlog} games × ~${avgH} h ≈ ${s.backlogHours.toLocaleString()} h`, 28, 102, -0.01);
    write(`÷ 24 = ${days.toLocaleString()} days (no sleep)`, 46, 140, 0.006);
    pen("#1b1d22", 29);
    const paceTxt = `pace ≈ ${s.pace} / yr  →  done in `, yearTxt = `${s.clearYear ?? "????"}`;
    write(paceTxt + yearTxt, 28, 186, -0.012);
    // ring the year itself (a fixed ellipse cut through the neighbouring letters when the text width changed)
    const yx = 28 + g.measureText(paceTxt).width, yw = g.measureText(yearTxt).width;
    g.strokeStyle = "#d0302a";
    g.lineWidth = 3;
    g.beginPath();
    g.ellipse(yx + yw / 2, 176 - (yx + yw / 2 - 28) * 0.012, yw / 2 + 5, 22, -0.05, 0, Math.PI * 2);
    g.stroke();
    pen("#d0302a", 28);
    write(`+ ${s.wishlist} on the wishlist ($${s.wishlistLoose.toLocaleString()}) !!`, 28, 232, 0.01);
    pen("#1b1d22", 27);
    write("TODO:", 28, 284);
    write("buy games", 96, 284);
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(92, 276);
    g.lineTo(196, 272);
    g.stroke();
    pen("#1a8a4a", 27, 600);
    write("play games ✓?", 210, 286, -0.02);
    // the graph
    g.strokeStyle = "#1b1d22";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(430, 40);
    g.lineTo(430, 260);
    g.lineTo(624, 260);
    g.stroke();
    g.strokeStyle = "#1f4fbf";
    g.beginPath();
    for (let k = 0; k <= 20; k++) {
      const x = 432 + k * 9, y = 250 - Math.pow(k / 20, 1.8) * 190;
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.strokeStyle = "#1a8a4a";
    g.beginPath();
    g.moveTo(432, 252);
    g.lineTo(616, 214);
    g.stroke();
    pen("#1f4fbf", 22);
    write("backlog", 540, 82, -0.5);
    pen("#1a8a4a", 22);
    write("beaten", 560, 238, -0.2);
    pen("#d0302a", 34, 700);
    write("?!", 600, 60);
    pen("#1b1d22", 18);
    write("time →", 560, 282);
  });

  const picto = d.canvas(256, 384, (g) => {
    const BG = "#ebebe7";
    g.fillStyle = BG;
    g.fillRect(0, 0, 256, 384);
    const icons: [boolean, (ink: string) => void][] = [
      [true, (ink) => { // cube dispenser
        g.fillRect(38, 22, 52, 14);
        g.fillRect(48, 36, 32, 10);
        g.fillRect(46, 56, 36, 36);
        g.fillStyle = BG;
        g.beginPath();
        g.arc(64, 74, 8, 0, 7);
        g.fill();
        g.fillStyle = ink;
        g.fillRect(40, 100, 48, 5);
      }],
      [true, (ink) => { // cube on button
        g.fillRect(46, 26, 36, 36);
        g.fillStyle = BG;
        g.beginPath();
        g.arc(64, 44, 8, 0, 7);
        g.fill();
        g.fillStyle = ink;
        g.beginPath();
        g.moveTo(64, 66);
        g.lineTo(54, 76);
        g.lineTo(74, 76);
        g.closePath();
        g.fill();
        g.fillRect(40, 84, 48, 8);
        g.fillRect(26, 92, 76, 10);
      }],
      [false, () => { // water hazard
        for (let k = 0; k < 3; k++) {
          g.beginPath();
          for (let x = 24; x <= 104; x += 4) {
            const y = 68 + k * 15 + Math.sin(x / 7) * 4;
            x === 24 ? g.moveTo(x, y) : g.lineTo(x, y);
          }
          g.stroke();
        }
        g.beginPath();
        g.arc(64, 38, 9, 0, 7);
        g.fill();
        g.beginPath();
        g.moveTo(42, 50);
        g.lineTo(54, 60);
        g.moveTo(86, 50);
        g.lineTo(74, 60);
        g.stroke();
      }],
      [true, () => { // turret
        g.beginPath();
        g.ellipse(40, 56, 13, 24, 0, 0, 7);
        g.fill();
        g.beginPath();
        g.moveTo(34, 78);
        g.lineTo(26, 102);
        g.moveTo(46, 78);
        g.lineTo(54, 102);
        g.moveTo(40, 80);
        g.lineTo(40, 100);
        g.stroke();
        g.lineWidth = 4;
        for (const dy of [-8, 0, 8]) {
          g.beginPath();
          g.moveTo(58, 54 + dy);
          g.lineTo(76, 54 + dy * 1.6);
          g.stroke();
        }
        g.beginPath();
        g.arc(94, 42, 7, 0, 7);
        g.fill();
        g.lineWidth = 6;
        g.beginPath();
        g.moveTo(94, 50);
        g.lineTo(98, 76);
        g.lineTo(90, 100);
        g.moveTo(98, 76);
        g.lineTo(106, 100);
        g.moveTo(84, 58);
        g.lineTo(106, 62);
        g.stroke();
      }],
      [true, () => { // cake
        g.beginPath();
        g.moveTo(24, 98);
        g.lineTo(104, 98);
        g.lineTo(104, 64);
        g.lineTo(24, 80);
        g.closePath();
        g.fill();
        g.fillStyle = BG;
        g.fillRect(28, 86, 72, 4);
        g.fillStyle = "#1c1d20";
        g.fillRect(62, 40, 6, 26);
        g.beginPath();
        g.ellipse(65, 32, 5, 8, 0, 0, 7);
        g.fill();
      }],
      [true, () => { // the backlog: a stack of cases and a clock
        for (let k = 0; k < 4; k++) g.fillRect(28 + (k % 2) * 6, 90 - k * 16, 56, 12);
        g.lineWidth = 5;
        g.beginPath();
        g.arc(94, 34, 14, 0, 7);
        g.stroke();
        g.beginPath();
        g.moveTo(94, 34);
        g.lineTo(94, 25);
        g.moveTo(94, 34);
        g.lineTo(101, 37);
        g.stroke();
      }],
    ];
    icons.forEach(([on, draw], i) => {
      g.save();
      g.translate((i % 2) * 128, Math.floor(i / 2) * 128);
      const ink = on ? "#1c1d20" : "#c3c3be";
      g.fillStyle = ink;
      g.strokeStyle = ink;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.lineWidth = 4;
      g.beginPath();
      g.roundRect(10, 10, 108, 108, 10);
      g.stroke();
      g.lineWidth = 6;
      draw(ink);
      g.restore();
    });
  });

  const rack = d.canvas(128, 448, (g, w, h) => {
    g.fillStyle = "#121418";
    g.fillRect(0, 0, w, h);
    const uh = h / 40;
    let u = 0;
    RACK_U.forEach((n, k) => {
      const y = u * uh, hh = n * uh;
      u += n;
      if (rackBlank(k, n)) {
        g.fillStyle = "#202329";
        g.fillRect(2, y + 1, w - 4, hh - 2);
        g.fillStyle = "#15171b";
        for (let yy = y + 5; yy < y + hh - 3; yy += 5) for (let x = 12; x < w - 12; x += 5) g.fillRect(x, yy, 2, 2);
        return;
      }
      g.fillStyle = k % 3 === 0 ? "#2c3037" : "#353941";
      g.fillRect(2, y + 1, w - 4, hh - 2);
      g.fillStyle = "#4a4f58";
      g.fillRect(2, y + 1, 5, hh - 2);
      g.fillRect(w - 7, y + 1, 5, hh - 2);
      g.fillStyle = "#0c0d10";
      for (let j = 0; j < 4; j++) g.fillRect(8 + j * 5.6, y + hh / 2 - 2, 4, 4);
      if (n >= 2) {
        for (let i = 0; i < 7; i++) {
          g.fillStyle = "#1c1f24";
          g.fillRect(36 + i * 11, y + 3, 9, hh - 6);
          g.fillStyle = "#6a707a";
          g.fillRect(37 + i * 11, y + hh - 6, 7, 2);
        }
      } else {
        g.fillStyle = "#1c1f24";
        for (let x = 36; x < w - 14; x += 4) g.fillRect(x, y + 3, 2, hh - 6);
      }
      g.fillStyle = "#c9ced6";
      g.fillRect(w - 24, y + 2, 13, 3);
    });
  });

  const crtCanvas = (draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) =>
    d.canvas(256, 192, (g, w, h) => {
      g.fillStyle = "#03150b";
      g.fillRect(0, 0, w, h);
      draw(g, w, h);
      g.fillStyle = "rgba(0,0,0,0.28)";
      for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
      const v = g.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.85);
      v.addColorStop(0, "rgba(0,0,0,0)");
      v.addColorStop(1, "rgba(0,0,0,0.55)");
      g.fillStyle = v;
      g.fillRect(0, 0, w, h);
    });
  const crtText = crtCanvas((g) => {
    g.fillStyle = "#6dffa8";
    g.font = `24px "VT323", monospace`;
    const lines = [
      "BACKLOG SCIENCE TERMINAL",
      `> QUEUE ......... ${s.backlog}`,
      `> IN PROGRESS ... ${s.playing}`,
      `> HOURS LEFT .... ${s.backlogHours.toLocaleString()}`,
      `> ETA ........... ${s.clearYear ?? "????"}`,
      "> STATUS: TESTING",
      "> _",
    ];
    lines.forEach((l, k) => g.fillText(l, 12, 28 + k * 23, 232));
  });
  const crtBars = crtCanvas((g, w) => {
    g.fillStyle = "#6dffa8";
    g.font = `24px "VT323", monospace`;
    g.fillText("RESULTS BY GRADE", 14, 26);
    const keys = ["A+", "A", "B", "C", "D", "F"] as const;
    const max = Math.max(1, ...keys.map((k) => s.grades[k] ?? 0));
    keys.forEach((k, i) => {
      const n = s.grades[k] ?? 0, bh = (n / max) * 110, x = 18 + i * 38;
      g.fillStyle = k === "A+" ? "#ffd25c" : "#6dffa8";
      g.fillRect(x, 154 - bh, 26, bh);
      g.font = `20px "VT323", monospace`;
      g.fillText(k, x + 4, 176);
      g.fillStyle = "#3a9a62";
      g.fillText(String(n), x + 2, 148 - bh);
    });
    g.fillStyle = "#3a9a62";
    g.fillRect(12, 156, w - 24, 2);
  });
  const crtWave = crtCanvas((g, w) => {
    g.fillStyle = "#6dffa8";
    g.font = `24px "VT323", monospace`;
    g.fillText("SUBJECT VITALS", 14, 26);
    g.strokeStyle = "#6dffa8";
    g.lineWidth = 3;
    g.beginPath();
    for (let x = 10; x < w - 10; x += 2) {
      const p = (x % 80) / 80;
      const y = 100 - (p > 0.42 && p < 0.47 ? -50 : p > 0.47 && p < 0.52 ? 34 : Math.sin(p * Math.PI * 2) * 6);
      x === 10 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
    g.font = `22px "VT323", monospace`;
    g.fillText("BPM 72", 14, 172);
    g.fillStyle = "#ffd25c";
    g.fillText(`MORALE ${Math.round(s.pct * 100)}%`, 130, 172);
  });
  const scope = d.canvas(192, 128, (g, w, h) => {
    g.fillStyle = "#04120a";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#0f3a24";
    for (let x = 0; x <= w; x += 24) g.fillRect(x, 0, 1, h);
    for (let y = 0; y <= h; y += 16) g.fillRect(0, y, w, 1);
    g.fillStyle = "#1f6a42";
    g.fillRect(w / 2, 0, 2, h);
    g.fillRect(0, h / 2, w, 2);
    g.font = `14px "VT323", monospace`;
    g.fillText("CH1 2V  CH2 5V  1ms", 6, 12);
  });
  const trace = d.canvas(192, 128, (g, w) => {
    g.lineWidth = 4;
    g.lineJoin = "round";
    g.strokeStyle = "#7dffb0";
    g.beginPath();
    for (let x = 0; x <= w; x += 3) {
      const y = 52 + Math.sin(x / 12) * 22 * (0.7 + 0.3 * Math.sin(x / 50));
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.strokeStyle = "#ffd25c";
    g.beginPath();
    for (let x = 0; x <= w; x += 32) {
      g.lineTo(x, 100);
      g.lineTo(x, 84);
      g.lineTo(x + 16, 84);
      g.lineTo(x + 16, 100);
    }
    g.stroke();
  });

  const rpm = d.canvas(128, 48, (g) => {
    g.fillStyle = "#140505";
    g.fillRect(0, 0, 128, 48);
    g.fillStyle = "#ff4a3a";
    g.font = `42px "VT323", monospace`;
    g.fillText("4200", 8, 38);
    g.font = `18px "VT323", monospace`;
    g.fillText("RPM", 92, 38);
  });

  const exit = d.canvas(256, 96, (g, w, h) => {
    g.fillStyle = "#13924c";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#f4fff8";
    g.strokeStyle = "#f4fff8";
    g.font = F(700, 66);
    g.textBaseline = "middle";
    g.fillText("EXIT", 104, h / 2 + 3);
    g.save();
    g.translate(54, 50);
    g.lineWidth = 9;
    g.lineCap = "round";
    g.beginPath();
    g.arc(8, -27, 8, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(2, -14);
    g.lineTo(-6, 10);
    g.lineTo(10, 24);
    g.moveTo(-6, 10);
    g.lineTo(-24, 22);
    g.moveTo(-16, -6);
    g.lineTo(2, -14);
    g.lineTo(18, -2);
    g.stroke();
    g.restore();
  });

  const drain = d.canvas(96, 96, (g) => {
    g.fillStyle = "#3a3e44";
    g.beginPath();
    g.arc(48, 48, 46, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#121417";
    g.beginPath();
    g.arc(48, 48, 38, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#5a5f66";
    for (let x = 14; x < 84; x += 9) g.fillRect(x, 12, 4, 72);
    g.strokeStyle = "#5a5f66";
    g.lineWidth = 5;
    g.beginPath();
    g.arc(48, 48, 38, 0, Math.PI * 2);
    g.stroke();
  });

  const mug = d.canvas(256, 64, (g) => {
    g.fillStyle = "#26282d";
    g.textAlign = "center";
    g.font = F(600, 17);
    g.fillText("WORLD'S OKAYEST", 128, 27);
    g.font = F(700, 24);
    g.fillText("TESTER", 128, 54);
  });

  const paper = d.canvas(128, 176, (g, w, h) => {
    g.fillStyle = "#fbfbf7";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#222";
    g.font = F(600, 17);
    g.fillText("TEST LOG", 10, 22);
    g.fillRect(10, 28, 108, 2);
    for (let k = 0; k < 9; k++) {
      const y = 46 + k * 14;
      g.strokeStyle = "#888";
      g.lineWidth = 1.5;
      g.strokeRect(10, y - 8, 8, 8);
      g.fillStyle = "#aaa";
      g.fillRect(24, y - 4, 40 + rand(k + 3) * 55, 2);
      if (rand(k + 11) < 0.55) {
        g.strokeStyle = "#1f4fbf";
        g.lineWidth = 2.5;
        g.beginPath();
        g.moveTo(10, y - 4);
        g.lineTo(14, y);
        g.lineTo(21, y - 11);
        g.stroke();
      }
    }
  });

  const door = d.canvas(192, 384, (g, w, h) => {
    g.fillStyle = "#d7dadd";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#b9bdc2";
    for (const y of [64, 300]) g.fillRect(0, y, w, 3);
    g.fillStyle = "#2c2f35";
    g.beginPath();
    g.arc(w / 2, h * 0.45, 54, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#d7dadd";
    g.beginPath();
    g.arc(w / 2, h * 0.45, 42, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#ff8a1a";
    g.beginPath();
    g.arc(w / 2, h * 0.45, 22, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#3a3d42";
    g.fillRect(w / 2 - 2, 0, 4, h);
    g.fillStyle = "#4a4e55";
    g.fillRect(0, h - 40, w, 40);
    g.fillStyle = "#3a3d42";
    g.font = F(600, 20);
    g.textAlign = "center";
    g.fillText("CHAMBER", w / 4, 36);
    g.fillText("EXIT", (w * 3) / 4, 36);
    g.font = F(700, 30);
    g.fillText("02", w / 4, h - 60);
    g.fillText("→", (w * 3) / 4, h - 60);
  });

  const faith = d.canvas(256, 256, (g, w) => {
    g.fillStyle = "#e6e8ea";
    g.fillRect(0, 0, w, w);
    g.strokeStyle = "#c2c6cb";
    g.lineWidth = 3;
    g.strokeRect(10, 10, w - 20, w - 20);
    g.strokeStyle = "#2c2f35";
    g.lineWidth = 6;
    g.beginPath();
    g.arc(128, 128, 104, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = "#ff8a1a";
    for (let k = 0; k < 3; k++) {
      const y = 82 + k * 46;
      g.beginPath();
      g.moveTo(128, y - 30);
      g.lineTo(186, y + 8);
      g.lineTo(168, y + 22);
      g.lineTo(128, y - 6);
      g.lineTo(88, y + 22);
      g.lineTo(70, y + 8);
      g.closePath();
      g.fill();
    }
    g.fillStyle = "#2c2f35";
    g.font = F(600, 16);
    g.textAlign = "center";
    g.fillText("AERIAL FAITH PLATE", 128, 246);
  });

  const stencil = (text: string, color: string, w = 512, h = 64) =>
    d.canvas(w, h, (g) => {
      g.fillStyle = color;
      g.font = F(700, h * 0.74);
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(text, w / 2, h / 2 + 3, w - 16);
    });
  const stIntake = stencil("WISHLIST INTAKE · KEEP CLEAR", "#3a3d44");
  const stDrop = stencil("CUBE DROP ZONE", "#c98a10");
  const stLaunch = stencil("LAUNCH ZONE · STAND CLEAR", "#c96a10");
  const stExit = stencil("EXIT ▸ STAY ON THE LINE", "#2a7a4a");

  const posterBase = (head: string, headCol: string, lines: string[], foot: string, icon: (g: CanvasRenderingContext2D) => void) =>
    d.canvas(192, 256, (g, w, h) => {
      g.fillStyle = "#f3f3ef";
      g.fillRect(0, 0, w, h);
      g.fillStyle = headCol;
      g.fillRect(0, 0, w, 38);
      g.fillStyle = "#fff";
      g.font = F(700, 24);
      g.fillText(head, 12, 28, w - 24);
      g.save();
      icon(g);
      g.restore();
      g.fillStyle = "#1c1d20";
      g.font = F(700, 21);
      lines.forEach((l, k) => g.fillText(l, 12, 178 + k * 22, w - 24));
      g.fillStyle = "#6a6e75";
      g.font = F(500, 11, "Barlow Condensed");
      g.fillText(foot, 12, h - 10, w - 24);
    });
  const poster1 = posterBase("SAFETY NOTICE", "#e8781a", ["THE BACKLOG CANNOT", "HURT YOU. (PROBABLY)"], "BACKLOG SCIENCE SAFETY COUNCIL", (g) => {
    g.fillStyle = "#1c1d20";
    for (let k = 0; k < 6; k++) g.fillRect(104 + (k % 2) * 6, 140 - k * 16, 60, 12);
    g.beginPath();
    g.arc(56, 70, 13, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#1c1d20";
    g.lineWidth = 9;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(56, 86);
    g.lineTo(56, 124);
    g.lineTo(42, 154);
    g.moveTo(56, 124);
    g.lineTo(70, 154);
    g.moveTo(36, 98);
    g.lineTo(80, 92);
    g.stroke();
  });
  const poster2 = posterBase("MOTIVATION", "#2a86d8", ["A BEATEN GAME IS", "A HAPPY GAME."], "RESULTS NOT GUARANTEED. CAKE NOT GUARANTEED.", (g) => {
    g.fillStyle = "#1c1d20";
    g.beginPath();
    g.moveTo(40, 150);
    g.lineTo(152, 150);
    g.lineTo(152, 104);
    g.lineTo(40, 124);
    g.closePath();
    g.fill();
    g.fillStyle = "#f3f3ef";
    g.fillRect(44, 132, 104, 5);
    g.fillStyle = "#e2382f";
    g.fillRect(93, 70, 8, 34);
    g.fillStyle = "#ffb000";
    g.beginPath();
    g.ellipse(97, 60, 6, 11, 0, 0, Math.PI * 2);
    g.fill();
  });

  const bridge = d.canvas(512, 32, (g, w, h) => {
    g.fillStyle = "#e6f6ff";
    g.fillRect(0, 0, w, 4);
    g.fillRect(0, h - 4, w, 4);
    g.fillRect(0, h / 2 - 1.5, w, 3);
    g.strokeStyle = "#e6f6ff";
    g.lineWidth = 3;
    for (let x = 0; x < w; x += 16) {
      g.beginPath();
      g.moveTo(x, 3);
      g.lineTo(x + 8, h / 2);
      g.lineTo(x, h - 3);
      g.stroke();
    }
  });

  const labelCanvas = (draw: (g: CanvasRenderingContext2D) => void) =>
    d.canvas(96, 40, (g) => {
      g.fillStyle = "#f7f7f2";
      g.fillRect(28, 2, 40, 36);
      draw(g);
    });
  const label = labelCanvas((g) => {
    g.fillStyle = "#e2382f";
    g.fillRect(28, 2, 40, 7);
    g.fillStyle = "#333";
    for (let k = 0; k < 3; k++) g.fillRect(32, 15 + k * 7, 22 + (k % 2) * 8, 3);
  });
  const ln2 = labelCanvas((g) => {
    g.fillStyle = "#2a86d8";
    g.fillRect(28, 2, 40, 9);
    g.fillStyle = "#1c1d20";
    g.font = F(700, 17);
    g.textAlign = "center";
    g.fillText("LN₂", 48, 31);
  });

  const logo = d.canvas(256, 64, (g, w, h) => {
    g.fillStyle = "#1f2227";
    g.beginPath();
    g.roundRect(0, 0, w, h, 10);
    g.fill();
    // our own mark: a ring around a stack of three bars (the backlog)
    g.strokeStyle = "#f2f4f7";
    g.lineWidth = 4;
    g.beginPath();
    g.arc(32, 32, 21, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = "#ff8a1a";
    for (let k = 0; k < 3; k++) g.fillRect(21 + (k % 2) * 3, 21 + k * 8, 20, 5);
    g.fillStyle = "#f2f4f7";
    g.font = F(600, 25);
    g.fillText("BACKLOG SCIENCE", 64, 34, w - 72);
    g.fillStyle = "#9aa3b2";
    g.font = F(500, 13, "Barlow Condensed");
    g.fillText("ENRICHMENT CENTER", 65, 52);
  });

  const clock = d.canvas(128, 128, (g) => {
    g.fillStyle = "#f7f7f4";
    g.beginPath();
    g.arc(64, 64, 63, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#1c1d20";
    for (let k = 0; k < 12; k++) {
      g.save();
      g.translate(64, 64);
      g.rotate((k / 12) * Math.PI * 2);
      g.fillRect(-2, -58, 4, k % 3 ? 8 : 14);
      g.restore();
    }
    const hand = (a: number, len: number, wd: number, col: string) => {
      g.save();
      g.translate(64, 64);
      g.rotate(a);
      g.fillStyle = col;
      g.fillRect(-wd / 2, -len, wd, len + 8);
      g.restore();
    };
    hand(-0.95, 32, 6, "#1c1d20");
    hand(0.85, 48, 4, "#1c1d20");
    hand(2.6, 52, 2, "#e2382f");
    g.font = F(500, 9, "Barlow Condensed");
    g.textAlign = "center";
    g.fillText("BACKLOG SCIENCE", 64, 88);
  });

  const keys = d.canvas(128, 40, (g, w, h) => {
    g.fillStyle = "#c9c3b2";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#ece7da";
    for (let r = 0; r < 4; r++) for (let k = 0; k < 13; k++) g.fillRect(4 + k * 9.4 + (r % 2) * 3, 4 + r * 9, 7.5, 7);
  });

  const hoodMon = d.canvas(96, 48, (g) => {
    g.fillStyle = "#0a0c0e";
    g.fillRect(0, 0, 96, 48);
    g.fillStyle = "#46e08a";
    g.beginPath();
    g.arc(14, 16, 6, 0, Math.PI * 2);
    g.fill();
    g.font = `20px "VT323", monospace`;
    g.fillText("FLOW OK", 26, 22);
    g.fillText("0.5 m/s", 8, 42);
  });

  const caution = d.canvas(256, 32, (g, w, h) => {
    g.fillStyle = "#f2c230";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#1d1d1f";
    g.font = F(700, 20);
    g.textAlign = "center";
    g.fillText("CAUTION · VOLATILE BACKLOG", w / 2, h / 2 + 7, w - 10);
  });

  const boxLabel = d.canvas(128, 64, (g, w) => {
    g.fillStyle = "#3a2a18";
    g.font = F(700, 17);
    g.textAlign = "center";
    g.fillText("UNOPENED SPECIMENS", w / 2, 22, w - 8);
    g.font = F(500, 13);
    g.fillText("DO NOT PLAY · FRAGILE", w / 2, 40, w - 8);
    g.fillRect(14, 48, w - 28, 2);
    g.font = F(700, 13);
    g.fillText("↑↑ THIS SIDE UP ↑↑", w / 2, 62, w - 8);
  });
  const wet = d.canvas(96, 176, (g, w, h) => {
    g.fillStyle = "#f2c230";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#1d1d1f";
    g.font = F(700, 22);
    g.textAlign = "center";
    g.fillText("CAUTION", w / 2, 26);
    g.beginPath();
    g.moveTo(w / 2, 40);
    g.lineTo(w - 10, 112);
    g.lineTo(10, 112);
    g.closePath();
    g.lineWidth = 5;
    g.strokeStyle = "#1d1d1f";
    g.stroke();
    g.beginPath();
    g.arc(52, 66, 5, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(48, 74);
    g.lineTo(42, 90);
    g.lineTo(54, 100);
    g.moveTo(42, 90);
    g.lineTo(30, 100);
    g.moveTo(36, 78);
    g.lineTo(58, 80);
    g.stroke();
    g.fillRect(24, 103, 46, 3);
    g.font = F(700, 18);
    g.fillText("WET FLOOR", w / 2, 136);
    g.font = F(500, 12, "Barlow Condensed");
    g.fillText("(TEST IN PROGRESS)", w / 2, 156);
  });
  const gauge = d.canvas(64, 64, (g) => {
    g.fillStyle = "#f4f4f2";
    g.beginPath();
    g.arc(32, 32, 31, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#1c1d20";
    g.lineWidth = 2;
    for (let k = 0; k <= 8; k++) {
      const a = Math.PI * 0.75 + (k / 8) * Math.PI * 1.5;
      g.beginPath();
      g.moveTo(32 + Math.cos(a) * 22, 32 + Math.sin(a) * 22);
      g.lineTo(32 + Math.cos(a) * 28, 32 + Math.sin(a) * 28);
      g.stroke();
    }
    g.strokeStyle = "#e2382f";
    g.beginPath();
    g.arc(32, 32, 25, Math.PI * 1.9, Math.PI * 2.25);
    g.stroke();
    g.strokeStyle = "#1c1d20";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(32, 32);
    g.lineTo(32 + Math.cos(-0.3) * 22, 32 + Math.sin(-0.3) * 22);
    g.stroke();
  });
  const talk = d.canvas(96, 24, (g, w, h) => {
    g.fillStyle = "#3a3d42";
    g.font = F(600, 16);
    g.textAlign = "center";
    g.fillText("PRESS TO TALK", w / 2, h - 6, w - 4);
  });
  const lights = (text: string) =>
    d.canvas(512, 32, (g, w, h) => {
      g.fillStyle = "#e6e8ea";
      g.font = F(600, 24);
      g.textAlign = "center";
      g.fillText(text, w / 2, h - 6, w - 10);
    });
  const lblCleared = lights(`BACKLOG CLEARED · ${Math.round(s.pct * 100)}%`);
  const exc = s.completed ? Math.round(((s.grades["A+"] + s.grades.A) / s.completed) * 100) : 0;
  const lblExcellent = lights(`RESULTS GRADED A OR BETTER · ${exc}%`);
  const sticky = d.canvas(48, 48, (g) => {
    g.fillStyle = "#ffe36a";
    g.fillRect(0, 0, 48, 48);
    g.fillStyle = "rgba(0,0,0,0.08)";
    g.fillRect(0, 0, 48, 8);
    g.fillStyle = "#2a3a8a";
    for (let k = 0; k < 3; k++) g.fillRect(6, 16 + k * 9, 20 + ((k * 13) % 17), 2);
  });

  return {
    boxLabel, wet, gauge, talk, lblCleared, lblExcellent, sticky,
    hazard, window: obs, board, picto, rack, crtText, crtBars, crtWave, scope, trace, rpm, exit, drain, mug, paper, door, faith,
    stIntake, stDrop, stLaunch, stExit, poster1, poster2, bridge, label, ln2, logo, clock, keys, hoodMon, caution,
  };
}
