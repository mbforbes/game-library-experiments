// Props for old-world levels: procedural stone, carved wood, floating candles, dust motes,
// god-ray shafts, filler tomes, and the Codex (a giant floating book that renders text).

import * as THREE from "three/webgpu";
import { tagQuality } from "../../engine/quality";
import {
  positionWorld, positionLocal, cameraPosition, vec2, vec3, float, floor, fract, hash, mix, smoothstep, sin, cos, time, instanceIndex, uv, texture,
  normalView, positionViewDirection, abs, uniform, max,
} from "three/tsl";
import { canvas, canvasTexture, lin } from "./common";
import { wrap } from "../../library/art";

/** Rough cut stone blocks (world-space, so any geometry can use it). `axis` picks the wall mapping. */
export function stoneMaterial(opts: { color?: string; scale?: number; cylindrical?: boolean } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
  const s = float(opts.scale ?? 1);
  // map: around a cylinder use (angle * radius, y); otherwise (x+z, y)
  const ang = positionWorld.z.atan(positionWorld.x).mul(3.2);
  const u = opts.cylindrical ? ang : positionWorld.x.add(positionWorld.z);
  const p = vec2(u, positionWorld.y).mul(s);
  const row = floor(p.y.div(0.32));
  const off = hash(row).mul(0.6);
  const bx = p.x.add(off).div(0.55);
  const cell = vec2(floor(bx), row);
  const f = vec2(fract(bx), fract(p.y.div(0.32)));
  const mortar = smoothstep(0.0, 0.04, f.x).mul(smoothstep(1.0, 0.96, f.x)).mul(smoothstep(0.0, 0.06, f.y)).mul(smoothstep(1.0, 0.94, f.y));
  const tone = hash(cell.x.add(cell.y.mul(57.3))).mul(0.35).add(0.65);
  const grit = hash(floor(p.mul(90)).dot(vec2(1, 157))).mul(0.12).add(0.88);
  const c = lin(opts.color ?? "#5a5248");
  const base = vec3(c.r, c.g, c.b).mul(tone).mul(grit);
  m.colorNode = mix(vec3(0.03, 0.028, 0.026), base, mortar);
  m.roughnessNode = mix(float(1), float(0.85), mortar);
  return m;
}

export function woodMaterial(color = "#3b2414") {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
  const c = lin(color);
  const grain = sin(positionWorld.y.mul(140).add(sin(positionWorld.x.add(positionWorld.z).mul(9)).mul(2))).mul(0.5).add(0.5);
  m.colorNode = vec3(c.r, c.g, c.b).mul(grain.mul(0.25).add(0.8));
  return m;
}

/** Floating candles: instanced wax cylinders with flickering emissive flames. */
export function candles(positions: THREE.Vector3[]) {
  const g = new THREE.Group();
  const n = positions.length;
  const wax = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.018, 0.02, 0.14, 10).translate(0, 0.07, 0), new THREE.MeshStandardNodeMaterial({ color: 0xe8dcc0, roughness: 0.7 }), n);
  const flameMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const i = float(instanceIndex);
  const flick = sin(time.mul(hash(i).mul(6).add(9)).add(i)).mul(0.15).add(sin(time.mul(23).add(i.mul(3.1))).mul(0.08)).add(1);
  // (the flame's stretch + sway live in the instance matrices, see bobCandles: on an InstancedMesh
  // positionLocal already includes the instance transform, so scaling it here flung the flames
  // metres up and down the tower)
  const fy = uv().y; // 0 at the base of the flame, 1 at the tip
  const col = mix(vec3(1.0, 0.45, 0.08), vec3(1.0, 0.92, 0.6), fy);
  flameMat.colorNode = vec3(0);
  flameMat.emissiveNode = col.mul(2.4).mul(flick);
  const flame = new THREE.InstancedMesh(new THREE.SphereGeometry(0.012, 8, 6).scale(1, 2.2, 1), flameMat, n);
  const m = new THREE.Matrix4();
  positions.forEach((p, k) => {
    m.makeTranslation(p.x, p.y, p.z);
    wax.setMatrixAt(k, m);
    flame.setMatrixAt(k, m.makeTranslation(p.x, p.y + FLAME_Y, p.z));
  });
  g.add(wax, flame);
  return { group: g, wax, flame, positions };
}

const FLAME_Y = 0.165;
const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Euler();

/** Bobbing animation helper for floating candles (also flickers + sways each flame). */
export function bobCandles(c: ReturnType<typeof candles>, t: number) {
  const m = new THREE.Matrix4();
  c.positions.forEach((p, k) => {
    const y = p.y + Math.sin(t * 0.8 + k * 1.7) * 0.03;
    m.makeTranslation(p.x, y, p.z);
    c.wax.setMatrixAt(k, m);
    const flick = 1 + Math.sin(t * (9 + ((k * 0.37) % 1) * 6) + k) * 0.15 + Math.sin(t * 23 + k * 3.1) * 0.08;
    _e.set(0, 0, Math.sin(t * 7 + k) * 0.08);
    _q.setFromEuler(_e);
    _s.set(1, flick, 1);
    // stretch from the wick: the flame's centre rises with its height
    _p.set(p.x, y + FLAME_Y + (flick - 1) * 0.026, p.z);
    c.flame.setMatrixAt(k, m.compose(_p, _q, _s));
  });
  c.wax.instanceMatrix.needsUpdate = true;
  c.flame.instanceMatrix.needsUpdate = true;
}

/** Dust motes drifting in a cylinder volume (all motion in the vertex shader). */
export function dust(count: number, radius: number, y0: number, y1: number, color = "#ffd9a0") {
  const geo = new THREE.OctahedronGeometry(0.004, 0);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const i = float(instanceIndex);
  const r = hash(i).sqrt().mul(radius);
  const a = hash(i.add(17)).mul(6.283).add(time.mul(hash(i.add(5)).mul(0.04).add(0.01)));
  const h = fract(hash(i.add(33)).add(time.mul(hash(i.add(9)).mul(0.004).add(0.001)))).mul(y1 - y0).add(y0);
  const wob = vec3(sin(time.mul(0.7).add(i)).mul(0.05), sin(time.mul(0.5).add(i.mul(1.3))).mul(0.04), cos(time.mul(0.6).add(i)).mul(0.05));
  m.positionNode = positionLocal.add(vec3(cos(a).mul(r), h, sin(a).mul(r))).add(wob);
  const c = lin(color);
  const tw = sin(time.mul(2).add(i.mul(7.7))).mul(0.5).add(0.5);
  m.colorNode = vec3(0);
  m.emissiveNode = vec3(c.r, c.g, c.b).mul(tw.mul(1.5).add(0.3));
  const mesh = new THREE.InstancedMesh(geo, m, count);
  mesh.frustumCulled = false;
  tagQuality(mesh, "fx");
  return mesh;
}

/** A soft additive light shaft (god ray) from `from` to `to`. */
export function lightShaft(from: THREE.Vector3, to: THREE.Vector3, radius: number, color = "#9fc4ff", strength = 0.18) {
  const len = from.distanceTo(to);
  const geo = new THREE.CylinderGeometry(radius * 0.6, radius, len, 24, 1, true);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const along = uv().y; // 0 bottom .. 1 top
  const edge = float(1).sub(abs(normalView.dot(positionViewDirection))).oneMinus().pow(1.5);
  const c = lin(color);
  const shimmer = sin(time.mul(0.6).add(uv().x.mul(18))).mul(0.15).add(0.85);
  // fade out as the camera gets close, so zooming out never parks you inside a wall of light
  const near = smoothstep(0.8, 3.0, positionWorld.distance(cameraPosition));
  m.colorNode = vec3(0);
  m.emissiveNode = vec3(c.r, c.g, c.b).mul(edge.mul(along.pow(0.7)).mul(strength).mul(shimmer).mul(near));
  m.fog = false;
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.copy(from).lerp(to, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), from.clone().sub(to).normalize());
  mesh.renderOrder = 4;
  tagQuality(mesh, "fx");
  return mesh;
}

/** Instanced generic leather-bound tomes (filler for the endless shelves). */
export function tomes(placements: { pos: THREE.Vector3; quat: THREE.Quaternion; size: THREE.Vector3; color: THREE.Color }[], ghost = false) {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mat = ghost
    ? new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    : new THREE.MeshStandardNodeMaterial({ roughness: 0.75 });
  if (ghost) {
    const rim = float(1).sub(abs(normalView.dot(positionViewDirection))).pow(2.0);
    const pulse = sin(time.mul(0.8).add(positionWorld.y.mul(2))).mul(0.3).add(0.7);
    mat.colorNode = vec3(0);
    (mat as THREE.MeshBasicNodeMaterial).emissiveNode = vec3(0.35, 0.55, 1.0).mul(rim.mul(0.35).add(0.02)).mul(pulse);
  } else {
    // gilt bands across the spine
    const band = smoothstep(0.02, 0.0, abs(fract(uv().y.mul(5)).sub(0.5)).sub(0.42)).mul(0.6);
    (mat as THREE.MeshStandardNodeMaterial).colorNode = mix(vec3(1, 1, 1).mul(0.4), vec3(0.6, 0.45, 0.15), band);
    (mat as THREE.MeshStandardNodeMaterial).metalnessNode = band.mul(0.8);
  }
  const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
  const m = new THREE.Matrix4();
  placements.forEach((p, i) => {
    m.compose(p.pos, p.quat, p.size);
    mesh.setMatrixAt(i, m);
    if (!ghost) mesh.setColorAt(i, p.color);
  });
  mesh.computeBoundingSphere();
  return mesh;
}

/** The Codex: a giant open book whose pages are a canvas (title page + text page). */
export class Codex {
  readonly group = new THREE.Group();
  private c: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private glow = uniform(0.12);
  private leaf: THREE.Mesh;
  private turnT = -1;

  constructor(width = 1.4) {
    [this.c, this.ctx] = canvas(2048, 1400);
    this.tex = canvasTexture(this.c);
    const h = (width / 2) * (1400 / 1024);
    // two gently curved pages
    const pageGeo = (side: -1 | 1) => {
      const g = new THREE.PlaneGeometry(width / 2, h, 24, 1);
      const pos = g.getAttribute("position");
      const uvA = g.getAttribute("uv");
      for (let k = 0; k < pos.count; k++) {
        const x = pos.getX(k) + (side * width) / 4; // -w/2..0 or 0..w/2
        const t = Math.abs(x) / (width / 2);
        pos.setX(k, x);
        pos.setZ(k, Math.sin(t * Math.PI) * 0.06 - t * t * 0.05);
        uvA.setX(k, side < 0 ? uvA.getX(k) * 0.5 : 0.5 + uvA.getX(k) * 0.5);
      }
      g.computeVertexNormals();
      return g;
    };
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, side: THREE.DoubleSide });
    const s = texture(this.tex);
    mat.colorNode = s.rgb;
    mat.emissiveNode = s.rgb.mul(this.glow);
    this.group.add(new THREE.Mesh(pageGeo(-1), mat), new THREE.Mesh(pageGeo(1), mat));
    // leather cover behind
    const cover = new THREE.Mesh(new THREE.BoxGeometry(width * 1.06, h * 1.05, 0.03), new THREE.MeshStandardNodeMaterial({ color: 0x3a1410, roughness: 0.6 }));
    cover.position.z = -0.06;
    this.group.add(cover);
    // a loose leaf that turns over whenever the book shows something new
    const [lc, lctx] = canvas(256, 350);
    lctx.fillStyle = "#e8d9b4";
    lctx.fillRect(0, 0, 256, 350);
    lctx.fillStyle = "rgba(60,40,20,0.25)";
    for (let y = 40; y < 320; y += 14) lctx.fillRect(24, y, 160 + Math.random() * 50, 3);
    const leafGeo = new THREE.PlaneGeometry(width / 2, h, 16, 1);
    const lp = leafGeo.getAttribute("position");
    for (let k = 0; k < lp.count; k++) {
      const x = lp.getX(k) + width / 4; // hinge at x = 0
      lp.setX(k, x);
      lp.setZ(k, Math.sin((x / (width / 2)) * Math.PI) * 0.04 + 0.01);
    }
    leafGeo.computeVertexNormals();
    const leafMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, side: THREE.DoubleSide });
    leafMat.colorNode = texture(canvasTexture(lc)).rgb;
    this.leaf = new THREE.Mesh(leafGeo, leafMat);
    this.leaf.visible = false;
    this.group.add(this.leaf);
    this.drawStats(["The Chronicle"], []);
  }

  private page(side: 0 | 1) {
    const ctx = this.ctx;
    const x0 = side * 1024;
    const g = ctx.createRadialGradient(x0 + 512, 700, 100, x0 + 512, 700, 800);
    g.addColorStop(0, "#efe2c0");
    g.addColorStop(1, "#c9b083");
    ctx.fillStyle = g;
    ctx.fillRect(x0, 0, 1024, 1400);
    // gutter shadow
    const gs = ctx.createLinearGradient(side ? x0 : x0 + 1024, 0, side ? x0 + 120 : x0 + 904, 0);
    gs.addColorStop(0, "rgba(60,30,10,0.45)");
    gs.addColorStop(1, "rgba(60,30,10,0)");
    ctx.fillStyle = gs;
    ctx.fillRect(x0, 0, 1024, 1400);
  }

  private illuminated(letter: string, x: number, y: number, size: number, color = "#8a1c12") {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = "#c9a227";
    ctx.lineWidth = 8;
    ctx.strokeRect(x + 6, y + 6, size - 12, size - 12);
    ctx.fillStyle = "#f4d778";
    ctx.font = `${size * 0.78}px "Cinzel", serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, x + size / 2, y + size / 2 + size * 0.05);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#2a1a0e";
  }

  /** Left page: a heading + lines; right page: paragraphs of body text. */
  draw(opts: { title: string; subtitle?: string; facts?: string[]; body: string; badge?: { text: string; color: string } }) {
    this.turnT = 0;
    const ctx = this.ctx;
    this.page(0);
    this.page(1);
    ctx.fillStyle = "#2a1a0e";
    ctx.textBaseline = "alphabetic";
    // left: illuminated initial + title
    const words = opts.title.split(/\s+/);
    this.illuminated(words[0][0]?.toUpperCase() ?? "?", 110, 150, 200);
    ctx.font = `72px "Cinzel", serif`;
    let y = 210;
    const first = words[0].slice(1);
    ctx.fillText(first, 330, y + 20, 600);
    ctx.font = `66px "Cinzel", serif`;
    const rest = wrap(ctx, words.slice(1), 800);
    y = 420;
    for (const l of rest.slice(0, 3)) {
      ctx.fillText(l, 110, y, 820);
      y += 80;
    }
    if (opts.subtitle) {
      ctx.font = `italic 44px "IM Fell English", serif`;
      ctx.fillStyle = "#5a3a1e";
      ctx.fillText(opts.subtitle, 110, y + 20, 820);
      y += 90;
    }
    ctx.fillStyle = "#2a1a0e";
    ctx.font = `40px "IM Fell English", serif`;
    for (const f of opts.facts ?? []) {
      ctx.fillText("❦  " + f, 120, y + 30, 800);
      y += 62;
    }
    if (opts.badge) {
      ctx.fillStyle = opts.badge.color;
      ctx.beginPath();
      ctx.arc(820, 1180, 110, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#5a1a10";
      ctx.lineWidth = 10;
      ctx.stroke();
      ctx.fillStyle = "#2a1208";
      ctx.font = `110px "Cinzel", serif`;
      ctx.textAlign = "center";
      ctx.fillText(opts.badge.text, 820, 1220);
      ctx.textAlign = "left";
    }
    // right: body text
    ctx.fillStyle = "#2a1a0e";
    let size = 46;
    let lines: string[] = [];
    for (; size > 24; size -= 2) {
      ctx.font = `${size}px "IM Fell English", serif`;
      lines = wrap(ctx, opts.body.split(/\s+/), 840);
      if (lines.length * size * 1.3 < 1180) break;
    }
    y = 150;
    if (opts.body) this.illuminated(opts.body[0].toUpperCase(), 1024 + 92, 110, 110, "#1c3a6a");
    ctx.font = `${size}px "IM Fell English", serif`;
    lines.forEach((l, k) => {
      const indent = k < 2 && opts.body ? 130 : 0;
      ctx.fillText(k === 0 ? l.slice(1) : l, 1024 + 92 + indent, y + size, 840 - indent);
      y += size * 1.3;
    });
    this.tex.needsUpdate = true;
  }

  drawStats(title: string[], lines: string[]) {
    this.draw({ title: title.join(" "), body: lines.join("  "), facts: [] });
  }

  update(t: number, dt = 1 / 60) {
    this.glow.value = 0.12 + Math.sin(t * 1.3) * 0.02;
    if (this.turnT >= 0) {
      this.turnT += dt / 0.7;
      const k = Math.min(1, this.turnT);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.leaf.visible = k < 1;
      this.leaf.rotation.y = -Math.PI * e;
      this.leaf.position.z = Math.sin(e * Math.PI) * 0.05;
      if (k >= 1) this.turnT = -1;
    }
  }
}

export { max };
