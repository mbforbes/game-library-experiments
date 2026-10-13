// What you see through the den's window. Layered shader planes (real parallax as you move):
// sky, distant + near skylines with lit windows, billboards, and rain on the glass.
// The window is "impossible": tap it to switch worlds (rainy neon city / outrun sunset / deep space).

import * as THREE from "three/webgpu";
import {
  uv, vec2, vec3, float, uniform, time, sin, cos, fract, floor, hash, step, smoothstep, mix, length, abs, max, min, pow, texture,
} from "three/tsl";
import { lin, neonFx } from "./common";

export const outsideFx = {
  mode: uniform(0), // 0 city, 1 outrun, 2 space (fractional during transitions is fine)
  lightning: uniform(0),
};

const isMode = (m: number) => smoothstep(0.5, 0, abs(outsideFx.mode.sub(m)));

function skyMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ depthWrite: false });
  const p = uv();
  // --- city night: deep purple to magenta haze, stars, moon
  const cityTop = vec3(...lin("#07051a").toArray());
  const cityBot = vec3(...lin("#5b1a5e").toArray());
  let city: any = mix(cityBot, cityTop, pow(p.y, 0.7));
  const grid = floor(p.mul(vec2(420, 220)));
  const star = step(0.9965, hash(grid.x.add(grid.y.mul(911.0)))).mul(smoothstep(0.35, 0.8, p.y));
  city = city.add(vec3(star.mul(sin(time.mul(3).add(grid.x)).mul(0.3).add(0.7))));
  const moonC = vec2(0.78, 0.78);
  const md = length(p.sub(moonC).mul(vec2(2, 1)));
  city = city.add(vec3(1.0, 0.85, 0.95).mul(smoothstep(0.052, 0.048, md).mul(1.6))).add(vec3(0.6, 0.25, 0.6).mul(smoothstep(0.25, 0.04, md).mul(0.35)));
  city = city.add(vec3(0.8, 0.85, 1.0).mul(outsideFx.lightning.mul(1.4)));

  // --- outrun: banded sunset, striped sun, perspective grid below the horizon
  const hz = float(0.38);
  const sky = mix(vec3(...lin("#ff7a3d").toArray()), vec3(...lin("#2b0b4d").toArray()), smoothstep(hz, float(1), p.y));
  const sunD = length(p.sub(vec2(0.5, hz.add(0.12))).mul(vec2(2.2, 1)));
  const stripes = step(0.42, fract(p.y.mul(38).sub(time.mul(0.6)))).max(step(p.y, hz.add(0.17)).oneMinus());
  const sunCol = mix(vec3(1.0, 0.25, 0.55), vec3(1.0, 0.85, 0.2), smoothstep(hz, hz.add(0.25), p.y));
  let outrun: any = mix(sky, sunCol.mul(2.2), smoothstep(0.205, 0.2, sunD).mul(stripes).mul(step(hz, p.y)));
  // grid floor
  const gy = hz.sub(p.y).max(0.0001);
  const gz = float(0.06).div(gy);
  const gx = p.x.sub(0.5).mul(gz).mul(6);
  const lineZ = smoothstep(0.06, 0.0, abs(fract(gz.add(time.mul(1.2))).sub(0.5)).sub(0.44).max(0)).mul(0);
  const lz = step(0.9, fract(gz.mul(1.5).add(time.mul(1.4))));
  const lx = step(0.94, fract(gx));
  const below = step(p.y, hz);
  const gridCol = vec3(1.0, 0.2, 0.85).mul(max(lz, lx).mul(1.8)).add(vec3(0.12, 0.0, 0.16));
  outrun = mix(outrun, gridCol.add(lineZ), below);

  // --- deep space: nebula + dense stars + ringed planet
  const n1 = sin(p.x.mul(7).add(sin(p.y.mul(5).add(time.mul(0.05))))).mul(sin(p.y.mul(9).sub(p.x.mul(3)))).mul(0.5).add(0.5);
  let space: any = mix(vec3(0.005, 0.005, 0.02), vec3(0.25, 0.05, 0.35), n1.mul(0.6)).add(vec3(0.0, 0.12, 0.2).mul(pow(n1, 3)));
  const sg = floor(p.mul(vec2(700, 380)));
  space = space.add(vec3(step(0.993, hash(sg.x.add(sg.y.mul(1301.0))))));
  const pc = p.sub(vec2(0.3, 0.6)).mul(vec2(2, 1));
  const pd = length(pc);
  const band = sin(pc.y.mul(60).add(sin(pc.x.mul(10)))).mul(0.15).add(0.85);
  space = mix(space, vec3(0.9, 0.55, 0.3).mul(band).mul(smoothstep(0.13, 0.02, pd).mul(0.9).add(0.25)), smoothstep(0.125, 0.12, pd));
  const ringD = abs(length(pc.mul(vec2(1, 3.2))).sub(0.2));
  space = space.add(vec3(0.8, 0.7, 0.6).mul(smoothstep(0.012, 0.0, ringD).mul(step(0.12, pd).max(step(pc.y, 0)))));

  const col = city.mul(isMode(0)).add(outrun.mul(isMode(1))).add(space.mul(isMode(2)));
  m.colorNode = vec3(0);
  m.emissiveNode = col;
  return m;
}

/** A skyline layer: building silhouettes with lit windows and neon roof trims. */
function skylineMaterial(opts: { seed: number; cols: number; base: string; min: number; max: number; windows: number; neon: string[] }) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const p = uv();
  const x = p.x.mul(opts.cols);
  const cell = floor(x);
  const r = hash(cell.add(opts.seed));
  const h = float(opts.min).add(r.mul(r).mul(opts.max - opts.min));
  const inB = step(p.y, h);
  const fx = fract(x);
  const gap = step(0.04, fx).mul(step(fx, 0.96));
  const wx = fract(x.mul(opts.windows / 2));
  const wy = fract(p.y.mul(opts.windows * 3));
  const win = step(0.28, wx).mul(step(wx, 0.72)).mul(step(0.3, wy)).mul(step(wy, 0.7));
  const wid = floor(x.mul(opts.windows / 2)).add(floor(p.y.mul(opts.windows * 3)).mul(17.17)).add(opts.seed * 3.1);
  const lit = step(0.64, hash(wid.add(floor(time.mul(0.05).add(hash(wid).mul(4))))));
  const warm = mix(vec3(1.0, 0.75, 0.4), vec3(0.5, 0.85, 1.0), step(0.7, hash(wid.mul(1.7))));
  const base = lin(opts.base);
  let col: any = vec3(base.r, base.g, base.b).add(warm.mul(win.mul(lit).mul(1.2)));
  // neon roof line on some buildings
  const n0 = lin(opts.neon[0]), n1 = lin(opts.neon[1] ?? opts.neon[0]);
  const neonC = mix(vec3(n0.r, n0.g, n0.b), vec3(n1.r, n1.g, n1.b), step(0.5, hash(cell.mul(3.3))));
  const roof = step(h.sub(0.006), p.y).mul(inB).mul(step(0.55, r));
  col = col.add(neonC.mul(roof.mul(5)).mul(neonFx.boost));
  // in outrun/space modes the skyline becomes black silhouettes / disappears
  const vis = isMode(0).add(isMode(1).mul(0.9));
  col = mix(col, vec3(0.02, 0.0, 0.04), isMode(1));
  m.colorNode = vec3(0);
  m.emissiveNode = col;
  m.opacityNode = inB.mul(gap.max(step(0.5, hash(cell.add(77))))).mul(vis);
  m.alphaTest = 0.5;
  return m;
}

function rainMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const p = uv();
  const cols = float(140);
  const col = floor(p.x.mul(cols));
  const rx = fract(p.x.mul(cols)).sub(0.5);
  const speed = hash(col).mul(0.8).add(0.7);
  const y = fract(p.y.mul(2).add(time.mul(speed)).add(hash(col.add(3)).mul(10)));
  const streak = smoothstep(0.0, 0.03, y).mul(smoothstep(0.16, 0.03, y)).mul(smoothstep(0.12, 0.0, abs(rx)));
  // static droplets on the glass
  const dg = floor(p.mul(vec2(90, 60)));
  const dr = hash(dg.x.add(dg.y.mul(173.0)));
  const dl = length(fract(p.mul(vec2(90, 60))).sub(0.5));
  const drop = step(0.93, dr).mul(smoothstep(0.3, 0.1, dl));
  const a = streak.mul(0.22).add(drop.mul(0.25)).mul(isMode(0));
  m.colorNode = vec3(0);
  m.emissiveNode = vec3(0.6, 0.75, 1.0).mul(a);
  m.opacityNode = a;
  return m;
}

/** Build the outside world for a window centred at `center` in a wall whose inside normal is `normal`. */
export function buildOutside(center: THREE.Vector3, normal: THREE.Vector3, width: number, height: number) {
  const g = new THREE.Group();
  const out = normal.clone().negate(); // direction away from the room
  const right = new THREE.Vector3(0, 1, 0).cross(normal).normalize();
  const place = (mesh: THREE.Mesh, dist: number, yOff: number) => {
    mesh.position.copy(center).addScaledVector(out, dist).add(new THREE.Vector3(0, yOff, 0));
    mesh.lookAt(mesh.position.clone().add(normal));
    g.add(mesh);
  };
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(140, 70), skyMaterial());
  place(sky, 60, 14);
  sky.renderOrder = -10;
  const far = new THREE.Mesh(new THREE.PlaneGeometry(90, 30), skylineMaterial({ seed: 3, cols: 60, base: "#120a24", min: 0.2, max: 0.75, windows: 10, neon: ["#ff3d9a", "#4fd8ff"] }));
  place(far, 40, -2);
  far.renderOrder = -9;
  const mid = new THREE.Mesh(new THREE.PlaneGeometry(50, 22), skylineMaterial({ seed: 11, cols: 22, base: "#0b0614", min: 0.15, max: 0.7, windows: 8, neon: ["#a35cff", "#ff7a1a"] }));
  place(mid, 22, -3.5);
  mid.renderOrder = -8;
  const near = new THREE.Mesh(new THREE.PlaneGeometry(24, 12), skylineMaterial({ seed: 29, cols: 8, base: "#06040b", min: 0.1, max: 0.55, windows: 6, neon: ["#4fd8ff", "#3dffa8"] }));
  place(near, 9, -4.2);
  near.renderOrder = -7;
  const rain = new THREE.Mesh(new THREE.PlaneGeometry(width, height), rainMaterial());
  place(rain, 0.02, 0);
  rain.renderOrder = 5;
  void right;
  return { group: g, sky, layers: [far, mid, near], rain };
}

/** Billboard on the skyline showing a texture (e.g. a currently-playing game's cover). */
export function billboard(width: number, height: number) {
  const m = new THREE.MeshBasicNodeMaterial();
  const t = texture(new THREE.Texture());
  const p = uv();
  const scan = sin(p.y.mul(300).add(time.mul(3))).mul(0.08).add(0.92);
  m.colorNode = vec3(0);
  m.emissiveNode = t.rgb.mul(scan).mul(1.4).mul(isMode(0));
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), m);
  return { mesh, tex: t };
}

export { cos, min };
