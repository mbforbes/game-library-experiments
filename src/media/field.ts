// MediaField: an arbitrary set of games placed in the world, rendered with one InstancedMesh per
// form factor (≈1 draw call per kind). Levels compute placements; the field handles art crops,
// spines, per-instance state (highlight / dim / glow / hidden) and fast picking.

import * as THREE from "three/webgpu";
import type { Game } from "../../shared/types";
import { mediaFor, platformOf, type MediaKind } from "../../shared/platforms";
import { TEMPLATES, geometryFor, coverRect, type Template } from "./templates";
import { texture, uv, vec2, uniform } from "three/tsl";
import type { ArtStore } from "../library/art";
import type { SpineAtlas } from "./spines";
import { makeHoloMaterial, makeMediaMaterial } from "./material";

export interface Placement {
  game: Game;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale?: number;
  /** force a form factor (e.g. render an arcade game as a different object) */
  kind?: MediaKind;
}

export interface MediaKit {
  art: ArtStore;
  spines: SpineAtlas;
  solid: THREE.MeshStandardNodeMaterial;
  holo: THREE.MeshStandardNodeMaterial;
}

export function makeMediaKit(art: ArtStore, spines: SpineAtlas): MediaKit {
  return { art, spines, solid: makeMediaMaterial(art.pages, spines.texture), holo: makeHoloMaterial(art.pages) };
}

interface Batch {
  kind: MediaKind;
  t: Template;
  mesh: THREE.InstancedMesh;
  games: Game[];
  buf: THREE.InstancedInterleavedBuffer;
  cover: THREE.InterleavedBufferAttribute;
  spine: THREE.InterleavedBufferAttribute;
  color: THREE.InterleavedBufferAttribute;
  glow: THREE.InterleavedBufferAttribute;
  state: THREE.InterleavedBufferAttribute;
  inv: THREE.Matrix4[];
  base: THREE.Matrix4[];
}

export interface StateTarget {
  highlight: number;
  dim: number;
}

const tmpM = new THREE.Matrix4();
const tmpRay = new THREE.Ray();
const tmpBox = new THREE.Box3();
const tmpV = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export function kindOf(g: Game, art: ArtStore): MediaKind {
  return mediaFor(platformOf(g.platform), art.year(g));
}

export function templateOf(g: Game, art: ArtStore): Template {
  return TEMPLATES[kindOf(g, art)];
}

/** Atlas crop so the art fills the template's label without stretching. */
export function coverCrop(g: Game, art: ArtStore, t: Template): { rect: [number, number, number, number]; page: number } {
  const ref = art.cover(g);
  let [u, v, w, h] = ref.rect;
  const la = t.labelAspect;
  if (ref.aspect > la) {
    const nw = (w * la) / ref.aspect;
    u += (w - nw) / 2;
    w = nw;
  } else {
    const nh = (h * ref.aspect) / la;
    v += (h - nh) * t.cropY;
    h = nh;
  }
  return { rect: [u, v, w, h], page: ref.page };
}

export class MediaField {
  readonly group = new THREE.Group();
  private batches: Batch[] = [];
  private where = new Map<string, { b: Batch; i: number }>();
  private targets = new Map<string, StateTarget>();
  private animating = new Set<string>();
  readonly holo: boolean;
  /** Games in placement order (shelf order) for prev/next browsing */
  readonly order: Game[];

  constructor(private kit: MediaKit, placements: Placement[], opts: { holo?: boolean; name?: string } = {}) {
    this.holo = !!opts.holo;
    this.order = placements.map((p) => p.game);
    this.group.name = opts.name ?? "media";
    const byKind = new Map<MediaKind, Placement[]>();
    for (const p of placements) {
      const k = p.kind ?? kindOf(p.game, kit.art);
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k)!.push(p);
    }
    for (const [kind, ps] of byKind) this.batches.push(this.makeBatch(kind, ps));
  }

  private makeBatch(kind: MediaKind, ps: Placement[]): Batch {
    const t = TEMPLATES[kind];
    const n = ps.length;
    const geo = geometryFor(kind).clone();
    // All per-instance data lives in ONE interleaved buffer (WebGPU allows only 8 vertex buffers)
    const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(n * 20), 20, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    const cover = new THREE.InterleavedBufferAttribute(buf, 4, 0);
    const spine = new THREE.InterleavedBufferAttribute(buf, 4, 4);
    const color = new THREE.InterleavedBufferAttribute(buf, 4, 8);
    const glow = new THREE.InterleavedBufferAttribute(buf, 4, 12);
    const state = new THREE.InterleavedBufferAttribute(buf, 4, 16);
    geo.setAttribute("iCover", cover);
    geo.setAttribute("iSpine", spine);
    geo.setAttribute("iColor", color);
    geo.setAttribute("iGlow", glow);
    geo.setAttribute("iState", state);
    const mesh = new THREE.InstancedMesh(geo, this.holo ? this.kit.holo : this.kit.solid, n);
    mesh.name = `${this.group.name}:${kind}`;
    mesh.frustumCulled = false; // instances are spread around; bounding sphere is computed below
    const b: Batch = { kind, t, mesh, games: [], buf, cover, spine, color, glow, state, inv: [], base: [] };
    const c = new THREE.Color();
    ps.forEach((p, i) => {
      const g = p.game;
      b.games.push(g);
      const m = new THREE.Matrix4().compose(p.position, p.quaternion, new THREE.Vector3().setScalar(p.scale ?? 1));
      mesh.setMatrixAt(i, m);
      b.base.push(m);
      b.inv.push(m.clone().invert());
      const crop = coverCrop(g, this.kit.art, t);
      cover.setXYZW(i, ...crop.rect);
      const sr = this.kit.spines.rects.get(g.id);
      if (sr) spine.setXYZW(i, ...sr);
      const plat = platformOf(g.platform);
      c.set(kind === "bigbox" ? this.kit.art.color(g) : plat.shell).convertSRGBToLinear();
      color.setXYZW(i, c.r, c.g, c.b, crop.page);
      c.set(this.holo ? "#4fd8ff" : plat.neon).convertSRGBToLinear();
      glow.setXYZW(i, c.r, c.g, c.b, kind === "slab" ? 1 : 0);
      state.setXYZW(i, t.shellRoughness, 0, 0, t.spineGlow);
      this.where.set(g.id, { b, i });
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    this.group.add(mesh);
    return b;
  }

  get games(): Game[] {
    return this.batches.flatMap((b) => b.games);
  }

  has(id: string) {
    return this.where.has(id);
  }

  /** World matrix of a game's instance (includes the field's group transform). */
  matrixOf(id: string, out = new THREE.Matrix4()): THREE.Matrix4 | null {
    const w = this.where.get(id);
    if (!w) return null;
    this.group.updateWorldMatrix(true, false);
    return out.multiplyMatrices(this.group.matrixWorld, w.b.base[w.i]);
  }

  /** Centre of a game's instance in world space */
  centerOf(id: string, out = new THREE.Vector3()): THREE.Vector3 | null {
    const w = this.where.get(id);
    if (!w || !this.matrixOf(id, tmpM)) return null;
    const [, h] = w.b.t.size;
    return out.set(0, h / 2, 0).applyMatrix4(tmpM);
  }

  /** Move an instance (e.g. animations, re-layout). */
  setMatrix(id: string, m: THREE.Matrix4) {
    const w = this.where.get(id);
    if (!w) return;
    w.b.base[w.i].copy(m);
    w.b.inv[w.i].copy(m).invert();
    w.b.mesh.setMatrixAt(w.i, m);
    w.b.mesh.instanceMatrix.needsUpdate = true;
  }

  hide(id: string, hidden: boolean) {
    const w = this.where.get(id);
    if (!w) return;
    if (hidden) this.hidden.add(id);
    else this.hidden.delete(id);
    const o = this.overlays.get(id);
    if (o) o.mesh.visible = !hidden;
    w.b.mesh.setMatrixAt(w.i, hidden ? ZERO : w.b.base[w.i]);
    w.b.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Glow colour (sRGB hex) + intensity for edges / highlight rim. */
  setGlow(id: string, hex: string, intensity: number) {
    const w = this.where.get(id);
    if (!w) return;
    const c = new THREE.Color(hex).convertSRGBToLinear();
    w.b.glow.setXYZW(w.i, c.r, c.g, c.b, intensity);
    w.b.buf.needsUpdate = true;
  }

  /** Animate highlight/dim towards targets. */
  setState(id: string, s: Partial<StateTarget>) {
    const cur = this.targets.get(id) ?? { highlight: 0, dim: 0 };
    this.targets.set(id, { ...cur, ...s });
    this.animating.add(id);
  }

  /** Apply a predicate as a filter: matches stay lit, the rest dim. */
  applyFilter(match: (g: Game) => boolean, active: boolean) {
    for (const b of this.batches) for (const g of b.games) this.setState(g.id, { dim: active && !match(g) ? 1 : 0, highlight: active && match(g) ? 0.35 : 0 });
  }

  update(dt: number) {
    if (!this.animating.size) return;
    const k = 1 - Math.exp(-dt * 8);
    const dirty = new Set<Batch>();
    for (const id of this.animating) {
      const w = this.where.get(id)!;
      const t = this.targets.get(id)!;
      const s = w.b.state;
      const h = s.getY(w.i) + (t.highlight - s.getY(w.i)) * k;
      const d = s.getZ(w.i) + (t.dim - s.getZ(w.i)) * k;
      s.setY(w.i, h);
      s.setZ(w.i, d);
      dirty.add(w.b);
      if (Math.abs(h - t.highlight) < 0.005 && Math.abs(d - t.dim) < 0.005) {
        s.setY(w.i, t.highlight);
        s.setZ(w.i, t.dim);
        this.animating.delete(id);
      }
    }
    for (const b of dirty) b.buf.needsUpdate = true;
  }

  // ---- hi-res detail overlays for nearby covers -------------------------------------------
  private overlays = new Map<string, { mesh: THREE.Mesh; mat: THREE.MeshStandardNodeMaterial }>();
  private detailT = 0;
  private hidden = new Set<string>();

  /** Lay sharp hi-res covers over the nearest face-out instances (call every frame). */
  detail(camera: THREE.Camera, dt: number, maxN = 20, maxDist = 1.5) {
    this.detailT -= dt;
    if (this.detailT > 0 || this.holo) return;
    this.detailT = 0.25;
    this.group.updateWorldMatrix(true, false);
    const cam = camera.position;
    const cands: { id: string; d: number; b: Batch; i: number }[] = [];
    const fwd = new THREE.Vector3();
    const ctr = new THREE.Vector3();
    const mw = new THREE.Matrix4();
    for (const b of this.batches) {
      const rect = coverRect(b.kind);
      if (!rect) continue;
      for (let i = 0; i < b.games.length; i++) {
        const g = b.games[i];
        if (this.hidden.has(g.id) || b.state.getZ(i) > 0.5) continue;
        mw.multiplyMatrices(this.group.matrixWorld, b.base[i]);
        ctr.set((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2, rect[4]).applyMatrix4(mw);
        const d = ctr.distanceTo(cam);
        if (d > maxDist) continue;
        fwd.set(0, 0, 1).transformDirection(mw);
        if (fwd.dot(ctr.clone().sub(cam).negate().normalize()) < 0.35) continue; // cover not facing us
        cands.push({ id: g.id, d, b, i });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    const keep = new Set(cands.slice(0, maxN).map((c) => c.id));
    for (const [id, o] of this.overlays) {
      if (!keep.has(id)) {
        o.mesh.removeFromParent();
        o.mat.dispose();
        this.overlays.delete(id);
      }
    }
    for (const c of cands.slice(0, maxN)) {
      if (this.overlays.has(c.id)) continue;
      const g = c.b.games[c.i];
      const rect = coverRect(c.b.kind)!;
      const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 });
      const crop = uniform(new THREE.Vector4(0, 0, 1, 1));
      const fade = uniform(0);
      const t = texture(this.kit.art.pages[0], crop.xy.add(vec2(uv().x, uv().y.oneMinus()).mul(crop.zw)));
      mat.colorNode = t.rgb;
      mat.opacityNode = fade;
      const w = rect[2] - rect[0], h = rect[3] - rect[1];
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.multiplyMatrices(c.b.base[c.i], new THREE.Matrix4().makeTranslation((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2, rect[4]));
      mesh.visible = false;
      this.group.add(mesh);
      this.overlays.set(c.id, { mesh, mat });
      const la = c.b.t.labelAspect, cy = c.b.t.cropY;
      this.kit.art.hiRes(g).then((tex) => {
        if (!tex || !this.overlays.has(c.id)) return;
        const img = tex.image as { width: number; height: number };
        const a = img.width / img.height;
        if (a > la) crop.value.set((1 - la / a) / 2, 0, la / a, 1);
        else crop.value.set(0, (1 - a / la) * cy, 1, a / la);
        t.value = tex;
        mesh.visible = true;
        const t0 = performance.now();
        const step = () => {
          fade.value = Math.min(1, (performance.now() - t0) / 250);
          if (fade.value < 1 && this.overlays.has(c.id)) requestAnimationFrame(step);
        };
        step();
      });
    }
  }

  /** Ray pick against oriented boxes of every instance. */
  raycast(ray: THREE.Ray): { game: Game; distance: number; point: THREE.Vector3 } | null {
    this.group.updateWorldMatrix(true, false);
    const groupInv = tmpM.copy(this.group.matrixWorld).invert();
    const local = ray.clone().applyMatrix4(groupInv);
    let best: { game: Game; distance: number; point: THREE.Vector3 } | null = null;
    for (const b of this.batches) {
      const [w, h, d] = b.t.size;
      tmpBox.min.set(-w / 2, 0, -d / 2);
      tmpBox.max.set(w / 2, h, d / 2);
      for (let i = 0; i < b.games.length; i++) {
        tmpRay.copy(local).applyMatrix4(b.inv[i]);
        const hit = tmpRay.intersectBox(tmpBox, tmpV);
        if (!hit) continue;
        const world = hit.clone().applyMatrix4(b.base[i]).applyMatrix4(this.group.matrixWorld);
        const dist = world.distanceTo(ray.origin);
        if (!best || dist < best.distance) best = { game: b.games[i], distance: dist, point: world };
      }
    }
    return best;
  }

  dispose() {
    for (const o of this.overlays.values()) o.mat.dispose();
    this.overlays.clear();
    for (const b of this.batches) {
      b.mesh.geometry.dispose();
      b.mesh.dispose();
    }
    this.group.removeFromParent();
  }
}
