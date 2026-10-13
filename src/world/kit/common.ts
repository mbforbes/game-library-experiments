// Shared helpers for world props: materials, canvas textures, neon glow, merged box geometry.

import * as THREE from "three/webgpu";
import { uniform, vec3, float, sin, time, positionWorld, mix, hash, floor, texture } from "three/tsl";

/** Global neon controls shared by every neon material (Konami-code rainbow mode etc.). */
export const neonFx = {
  rainbow: uniform(0), // 0..1 blend to hue-cycling
  boost: uniform(1), // global neon brightness
};

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

export function canvasTexture(c: HTMLCanvasElement, opts: { nearest?: boolean; srgb?: boolean; repeat?: boolean } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (opts.nearest) {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
  } else {
    t.anisotropy = 8;
  }
  if (opts.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export const lin = (hex: string | number) => new THREE.Color(hex).convertSRGBToLinear();

/** Emissive "neon tube" material. Colour is hex; intensity scales the bloom. Supports flicker + rainbow. */
export function neonMaterial(hex: string | number, intensity = 4, opts: { flicker?: number; seed?: number } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 0.4 });
  const c = lin(hex);
  const base = vec3(c.r, c.g, c.b);
  const hue = sin(time.mul(1.7).add(positionWorld.x.mul(1.3)).add(vec3(0, 2.094, 4.188))).mul(0.5).add(0.5);
  let col: any = mix(base, hue, neonFx.rainbow);
  if (opts.flicker) {
    const seed = float(opts.seed ?? Math.random() * 100);
    const n = hash(floor(time.mul(14)).add(seed));
    const dip = n.greaterThan(1 - opts.flicker).select(float(0.15), float(1));
    col = col.mul(dip);
  }
  m.colorNode = col.mul(0.2);
  m.emissiveNode = col.mul(intensity).mul(neonFx.boost);
  return m;
}

/** Merge a list of boxes [cx,cy,cz,w,h,d] into one geometry (for furniture). */
export function boxes(list: [number, number, number, number, number, number][]): THREE.BufferGeometry {
  const geos = list.map(([x, y, z, w, h, d]) => new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  return mergeGeos(geos);
}

export function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // minimal merge (position/normal/uv, non-indexed)
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [];
  for (let g of geos) {
    if (g.index) g = g.toNonIndexed();
    const p = g.getAttribute("position"), n = g.getAttribute("normal"), u = g.getAttribute("uv");
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/** Text rendered with a neon glow into a transparent canvas (for signs). */
export function glowText(text: string, opts: { font: string; size: number; color: string; pad?: number; blur?: number; tube?: boolean }) {
  const pad = opts.pad ?? opts.size * 0.6;
  const [, m] = canvas(8, 8);
  m.font = `${opts.size}px ${opts.font}`;
  const w = Math.ceil(m.measureText(text).width + pad * 2);
  const h = Math.ceil(opts.size * 1.35 + pad * 2);
  const [c, ctx] = canvas(w, h);
  ctx.font = `${opts.size}px ${opts.font}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const blur = opts.blur ?? opts.size * 0.18;
  // outer glow
  ctx.shadowColor = opts.color;
  ctx.shadowBlur = blur;
  ctx.fillStyle = opts.color;
  ctx.fillText(text, w / 2, h / 2);
  ctx.shadowBlur = blur * 0.4;
  ctx.fillText(text, w / 2, h / 2);
  // hot white core
  if (opts.tube !== false) {
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.85;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(0.985, 0.94);
    ctx.fillText(text, 0, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  return { canvas: c, aspect: w / h };
}

/** A flat neon sign plane (emissive, transparent) of given height in metres. */
export function neonSign(text: string, opts: { font: string; height: number; color: string; intensity?: number; flicker?: number }) {
  const { canvas: c, aspect } = glowText(text, { font: opts.font, size: 120, color: opts.color });
  const tex = canvasTexture(c);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const s = texture(tex);
  const col = lin(opts.color);
  const hue = sin(time.mul(1.7).add(positionWorld.x.mul(1.3)).add(vec3(0, 2.094, 4.188))).mul(0.5).add(0.5);
  // keep the white core but tint the glow; rainbow mode recolours
  const tint = mix(vec3(col.r, col.g, col.b), hue, neonFx.rainbow);
  let rgb: any = mix(tint.mul(s.a), s.rgb, s.r.mul(s.g).mul(s.b).pow(2));
  if (opts.flicker) {
    const n = hash(floor(time.mul(12)).add(float(text.length * 7.13)));
    rgb = rgb.mul(n.greaterThan(1 - opts.flicker).select(float(0.12), float(1)));
  }
  const k = float(opts.intensity ?? 3).mul(neonFx.boost);
  // unlit: emissive only (it is what blooms)
  m.colorNode = vec3(0);
  m.opacityNode = s.a;
  m.emissiveNode = rgb.mul(k);
  const h = opts.height;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(h * aspect, h), m);
  mesh.renderOrder = 2;
  return mesh;
}

