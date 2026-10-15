// DecorBuilder: lots of props for one draw call.
//
// Every prop added to a builder (boxes, cylinders, lathes, extrusions, any BufferGeometry) is
// baked into ONE merged mesh with per-vertex colour, roughness, metalness, glow and blink, and an
// optional texture from the builder's canvas atlas (labels, posters, book spines, screens...).
// One material per room means one shader to compile; a thousand props cost about the same to
// draw as one. Use `sub()` for the few parts that need to move (fans, doors): it shares the
// material and atlas but builds its own mesh you can animate.
//
//   const d = new DecorBuilder();
//   d.box([0.8, 0.04, 0.4], [0, 0.75, 0], "#6b4a2f", { rough: 0.6 });           // table top
//   d.at([1, 0, 2], [0, Math.PI / 4, 0], () => { ...props relative to here... });
//   const label = d.canvas(256, 64, (ctx, w, h) => { ctx.fillText("HELLO", 8, 40) });
//   d.plane([0.3, 0.075], [0, 1, -0.5], "#ffffff", { tex: label, glow: 0.4 });
//   scene.add(d.build());

import * as THREE from "three/webgpu";
import { tagQuality } from "../../engine/quality";
import { attribute, texture, mix, vec3, float, sin, time, hash, positionWorld, floor, uv } from "three/tsl";

export type Vec3 = [number, number, number];
export type Color = string | number | THREE.Color;

/** A rectangle in the builder's atlas (from `canvas()`), in 0..1 atlas UVs. */
export interface UVRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface PropOpts {
  /** Euler rotation (radians, XYZ) applied about the prop's own centre/origin. */
  rot?: Vec3;
  /** Non-uniform scale applied before rotation. */
  scale?: Vec3;
  /** 0..1 (default 0.7) */
  rough?: number;
  /** 0..1 (default 0) */
  metal?: number;
  /** Self-illumination as a multiple of the colour: 0 = none, ~0.3 = softly lit sign, 2-4 = neon / LED (blooms). */
  glow?: number;
  /** Blink/pulse speed (rad/s) for the glow: LEDs, screens, warning lights. 0 = steady. */
  blink?: number;
  /** Texture from `canvas()` mapped onto the prop's UVs (multiplied by `color`; use "#fff" for the raw image). */
  tex?: UVRect;
  /** For box(): put the texture only on one face ("front" = +Z, "back", "left", "right", "top", "bottom"); other faces get the plain colour. */
  face?: "front" | "back" | "left" | "right" | "top" | "bottom";
}

interface Shared {
  atlas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  material: THREE.MeshStandardNodeMaterial;
  pack: { x: number; y: number; rowH: number };
  dirty: boolean;
}

const tmpM = new THREE.Matrix4();
const tmpN = new THREE.Matrix3();
const tmpV = new THREE.Vector3();
const tmpC = new THREE.Color();
const BOX_FACES = ["right", "left", "top", "bottom", "front", "back"] as const; // BoxGeometry group order

export class DecorBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uvs: number[] = [];
  private col: number[] = [];
  private mat: number[] = []; // rough, metal, glow, blink
  private texMix: number[] = [];
  private idx: number[] = [];
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  private shared: Shared;
  /** Triangles added so far (keep rooms to roughly 150k on phones). */
  triangles = 0;

  constructor(opts: { atlasSize?: number; share?: DecorBuilder } = {}) {
    if (opts.share) {
      this.shared = opts.share.shared;
      return;
    }
    const size = opts.atlasSize ?? 2048;
    const atlas = document.createElement("canvas");
    atlas.width = atlas.height = size;
    const ctx = atlas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 8, 8); // texel (0,0) is plain white for untextured props
    const tex = new THREE.CanvasTexture(atlas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.flipY = false;
    const material = new THREE.MeshStandardNodeMaterial({ alphaTest: 0.5 });
    const rmgb = attribute("dmat", "vec4");
    const k = attribute("dtex", "float");
    const t = texture(tex, uv());
    const base = attribute("color", "vec3");
    const c = mix(base, base.mul(t.rgb), k);
    material.colorNode = c;
    material.opacityNode = mix(float(1), t.a, k);
    material.roughnessNode = rmgb.x;
    material.metalnessNode = rmgb.y;
    // blink: pulse per prop (phase from its position) when dmat.w > 0
    const phase = hash(floor(positionWorld.mul(3)).dot(vec3(1, 57, 113)));
    const pulse = rmgb.w.greaterThan(0).select(sin(time.mul(rmgb.w).add(phase.mul(6.283))).mul(0.5).add(0.5), float(1));
    material.emissiveNode = c.mul(rmgb.z).mul(pulse);
    this.shared = { atlas, ctx, tex, material, pack: { x: 8, y: 0, rowH: 8 }, dirty: false };
  }

  /** Another builder sharing this one's material + atlas (for parts you want to move separately). */
  sub() {
    return new DecorBuilder({ share: this });
  }

  /** The shared material (e.g. to make your own meshes match). */
  get material() {
    return this.shared.material;
  }

  // ---- transforms -------------------------------------------------------------------------

  /** Run `fn` with props placed relative to `pos` (rotated by `rot`, scaled by `scale`). */
  at(pos: Vec3, rot: Vec3 | null, fn: () => void, scale?: Vec3) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rot ?? [0, 0, 0]))),
      new THREE.Vector3(...(scale ?? [1, 1, 1])),
    );
    this.stack.push(this.stack[this.stack.length - 1].clone().multiply(m));
    try {
      fn();
    } finally {
      this.stack.pop();
    }
  }

  // ---- textures -----------------------------------------------------------------------------

  /**
   * Reserve a w×h pixel area in the atlas, draw into it, get back its UV rect. The context is
   * translated so (0,0) is your area's top-left. Keep areas modest (the atlas is shared by the
   * whole room): ~64-512 px is plenty for labels, spines and posters seen from a few metres.
   */
  canvas(w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): UVRect {
    const S = this.shared;
    const size = S.atlas.width;
    const gap = 4;
    w = Math.ceil(w);
    h = Math.ceil(h);
    if (S.pack.x + w + gap > size) {
      S.pack.x = 0;
      S.pack.y += S.pack.rowH + gap;
      S.pack.rowH = 0;
    }
    if (S.pack.y + h > size) throw new Error(`DecorBuilder atlas full (${size}px): use smaller canvases`);
    const x = S.pack.x, y = S.pack.y;
    S.pack.x += w + gap;
    S.pack.rowH = Math.max(S.pack.rowH, h);
    const ctx = S.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    draw(ctx, w, h);
    ctx.restore();
    S.dirty = true;
    // half-texel inset avoids bleeding from neighbours
    return { u0: (x + 0.5) / size, v0: (y + 0.5) / size, u1: (x + w - 0.5) / size, v1: (y + h - 0.5) / size };
  }

  // ---- primitives ---------------------------------------------------------------------------

  /** Box of size [w,h,d] centred at `at`. */
  box(size: Vec3, at: Vec3, color: Color, o: PropOpts = {}) {
    const g = new THREE.BoxGeometry(...size);
    if (o.tex && o.face) {
      // texture on one face only: the other faces sample the white texel
      const faceIdx = BOX_FACES.indexOf(o.face);
      const uvA = g.getAttribute("uv") as THREE.BufferAttribute;
      for (let f = 0; f < 6; f++) {
        for (let v = f * 4; v < f * 4 + 4; v++) {
          if (f !== faceIdx) uvA.setXY(v, -1, -1);
        }
      }
    }
    this.geo(g, at, color, o);
    return this;
  }

  /** Cylinder (or cone/frustum) of height h centred at `at`, axis along Y. */
  cyl(rTop: number, rBottom: number, h: number, at: Vec3, color: Color, o: PropOpts & { seg?: number; open?: boolean } = {}) {
    this.geo(new THREE.CylinderGeometry(rTop, rBottom, h, o.seg ?? 16, 1, o.open ?? false), at, color, o);
    return this;
  }

  sphere(r: number, at: Vec3, color: Color, o: PropOpts & { seg?: number } = {}) {
    const s = o.seg ?? 16;
    this.geo(new THREE.SphereGeometry(r, s, Math.max(6, Math.round(s * 0.66))), at, color, o);
    return this;
  }

  /** Torus in the XY plane (rotate with `rot`). */
  torus(radius: number, tube: number, at: Vec3, color: Color, o: PropOpts & { seg?: number; arc?: number } = {}) {
    this.geo(new THREE.TorusGeometry(radius, tube, 8, o.seg ?? 24, o.arc ?? Math.PI * 2), at, color, o);
    return this;
  }

  /** Flat rectangle facing +Z, centred at `at`. Great for textured labels/posters (use `tex`). */
  plane(size: [number, number], at: Vec3, color: Color, o: PropOpts = {}) {
    this.geo(new THREE.PlaneGeometry(...size), at, color, o);
    return this;
  }

  /** Lathe: revolve a profile of [radius, y] points around Y (vases, bottles, lamps, columns). */
  lathe(profile: [number, number][], at: Vec3, color: Color, o: PropOpts & { seg?: number } = {}) {
    this.geo(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), o.seg ?? 16), at, color, o);
    return this;
  }

  /** Extrude a 2D shape (XY) by `depth` along +Z (frames, signs, brackets, arches). */
  extrude(shape: THREE.Shape, depth: number, at: Vec3, color: Color, o: PropOpts & { bevel?: number } = {}) {
    const b = o.bevel ?? 0;
    this.geo(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: b > 0, bevelSize: b, bevelThickness: b, bevelSegments: 1 }), at, color, o);
    return this;
  }

  /** A tube along a curve (cables, pipes, rails). */
  tube(points: Vec3[], radius: number, color: Color, o: PropOpts & { seg?: number } = {}) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
    this.geo(new THREE.TubeGeometry(curve, o.seg ?? Math.max(8, points.length * 6), radius, 6, false), [0, 0, 0], color, o);
    return this;
  }

  /** Any BufferGeometry, placed at `at` (+ rot/scale). The geometry is consumed (disposed). */
  geo(g: THREE.BufferGeometry, at: Vec3, color: Color, o: PropOpts = {}) {
    const local = new THREE.Matrix4().compose(
      tmpV.set(...at).clone(),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]))),
      new THREE.Vector3(...(o.scale ?? [1, 1, 1])),
    );
    const m = tmpM.copy(this.stack[this.stack.length - 1]).multiply(local);
    tmpN.getNormalMatrix(m);
    const P = g.getAttribute("position") as THREE.BufferAttribute;
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    const N = g.getAttribute("normal") as THREE.BufferAttribute;
    const U = g.getAttribute("uv") as THREE.BufferAttribute | undefined;
    const base = this.pos.length / 3;
    tmpC.set(color as any);
    if (typeof color !== "object") tmpC.convertSRGBToLinear();
    const rough = o.rough ?? 0.7, metal = o.metal ?? 0, glow = o.glow ?? 0, blink = o.blink ?? 0;
    const r = o.tex;
    for (let i = 0; i < P.count; i++) {
      tmpV.fromBufferAttribute(P, i).applyMatrix4(m);
      this.pos.push(tmpV.x, tmpV.y, tmpV.z);
      tmpV.fromBufferAttribute(N, i).applyMatrix3(tmpN).normalize();
      this.nrm.push(tmpV.x, tmpV.y, tmpV.z);
      let u = U ? U.getX(i) : 0, v = U ? U.getY(i) : 0;
      let k = 0;
      if (r && u >= 0) {
        // geometry UVs (v up) → atlas rect (canvas rows go down)
        u = r.u0 + u * (r.u1 - r.u0);
        v = r.v0 + (1 - v) * (r.v1 - r.v0);
        k = 1;
      } else {
        u = v = 0.5 / this.shared.atlas.width;
      }
      this.uvs.push(u, v);
      this.col.push(tmpC.r, tmpC.g, tmpC.b);
      this.mat.push(rough, metal, glow, blink);
      this.texMix.push(k);
    }
    const I = g.getIndex();
    if (I) for (let i = 0; i < I.count; i++) this.idx.push(base + I.getX(i));
    else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
    this.triangles += (I ? I.count : P.count) / 3;
    g.dispose();
    return this;
  }

  /** Bake everything added so far into one mesh. */
  /** `essential`: part of the room itself (walls, floors), so the quality governor never hides it. */
  build(name = "decor", opts: { essential?: boolean } = {}): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("dmat", new THREE.Float32BufferAttribute(this.mat, 4));
    g.setAttribute("dtex", new THREE.Float32BufferAttribute(this.texMix, 1));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    if (this.shared.dirty) {
      this.shared.tex.needsUpdate = true;
      this.shared.dirty = false;
    }
    const mesh = new THREE.Mesh(g, this.shared.material);
    // decor lives on its own camera layer (the quality governor can drop it on slow devices)
    if (!opts.essential) tagQuality(mesh, "decor");
    mesh.name = name;
    this.pos = [];
    this.nrm = [];
    this.uvs = [];
    this.col = [];
    this.mat = [];
    this.texMix = [];
    this.idx = [];
    return mesh;
  }
}

/** Handy: a rounded-rectangle Shape for extrude(). */
export function roundedRect(w: number, h: number, r: number) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Deterministic pseudo-random in [0,1) from an integer seed (stable decor between visits). */
export function rand(seed: number) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
