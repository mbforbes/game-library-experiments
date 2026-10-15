// MediaField: an arbitrary set of games placed in the world, rendered with one InstancedMesh per
// form factor (≈1 draw call per kind). Levels compute placements; the field handles art crops,
// spines, per-instance state (highlight / dim / glow / hidden) and fast picking.

import * as THREE from "three/webgpu";
import type { Game } from "../../shared/types";
import { mediaFor, platformOf, type MediaKind } from "../../shared/platforms";
import { TEMPLATES, geometryFor, coverRect, photoRect, type Template } from "./templates";
import { SPECIAL_SHELLS } from "./branding";
import { stickerCell, stickerLocal, stickerMaterial, NEW_CELL } from "./stickers";
import { texture, uv, vec2, uniform, step } from "three/tsl";
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
  return { art, spines, solid: makeMediaMaterial(art.pages, spines.texture, art.spinePages), holo: makeHoloMaterial(art.pages) };
}

interface Batch {
  kind: MediaKind;
  photo: boolean;
  t: Template;
  mesh: THREE.InstancedMesh;
  games: Game[];
  buf: THREE.InstancedInterleavedBuffer;
  cover: THREE.InterleavedBufferAttribute;
  spine: THREE.InterleavedBufferAttribute;
  color: THREE.InterleavedBufferAttribute;
  glow: THREE.InterleavedBufferAttribute;
  state: THREE.InterleavedBufferAttribute;
  extra: THREE.InterleavedBufferAttribute;
  inv: THREE.Matrix4[];
  base: THREE.Matrix4[];
}

interface Overlay {
  mesh: THREE.Mesh;
  photo: boolean;
  id: string;
}

/**
 * Two materials serve every overlay in the app (cover crop / photo contain-fit). The texture,
 * crop and fade come from each mesh's userData, set per object right before it's drawn, so a
 * new overlay costs nothing to build (node graphs are keyed per node instance: a fresh material
 * would mean a fresh ~15 ms node build each time).
 */
const overlayMats = new Map<boolean, THREE.MeshStandardNodeMaterial>();
function overlayMaterial(photo: boolean, initial: THREE.Texture) {
  let mat = overlayMats.get(photo);
  if (mat) return mat;
  mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 });
  const fade = uniform(0);
  let t: any = null;
  const crop = uniform(new THREE.Vector4(0, 0, 1, 1)).onObjectUpdate(({ object }: any) => {
    const u = object.userData;
    t.value = u.tex;
    fade.value = u.fade;
    return u.crop;
  });
  // photo mode: contain-fit; crop.xy = pad, crop.zw = 1 - 2*pad
  const pu = uv().sub(crop.xy).div(crop.zw);
  t = texture(initial, photo ? vec2(pu.x, pu.y.oneMinus()) : crop.xy.add(vec2(uv().x, uv().y.oneMinus()).mul(crop.zw)));
  mat.colorNode = t.rgb;
  mat.opacityNode = photo ? fade.mul(t.a).mul(step(0, pu.x).mul(step(pu.x, 1)).mul(step(0, pu.y)).mul(step(pu.y, 1))) : fade;
  overlayMats.set(photo, mat);
  return mat;
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

/** Contain-fit padding for a cartridge photo inside the template's front quad. */
export function photoPad(photoAspect: number, kind: MediaKind): [number, number] {
  const [x0, y0, x1, y1] = photoRect(kind);
  const fa = (x1 - x0) / (y1 - y0);
  return photoAspect > fa ? [0, (1 - fa / photoAspect) / 2] : [(1 - photoAspect / fa) / 2, 0];
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
    // batch per form factor (+ a separate batch for carts shown as real photos)
    const byKind = new Map<string, Placement[]>();
    for (const p of placements) {
      const k = p.kind ?? kindOf(p.game, kit.art);
      const photo = !!TEMPLATES[k].buildPhoto && !!kit.art.cartPhoto(p.game);
      const key = photo ? k + "+photo" : k;
      if (!byKind.has(key)) byKind.set(key, []);
      byKind.get(key)!.push(p);
    }
    for (const [key, ps] of byKind) this.batches.push(this.makeBatch(key.replace("+photo", "") as MediaKind, key.endsWith("+photo"), ps));
    if (!this.holo) this.makeStickers();
    this.warmOverlays();
  }

  private makeBatch(kind: MediaKind, photo: boolean, ps: Placement[]): Batch {
    const t = TEMPLATES[kind];
    const n = ps.length;
    const geo = geometryFor(kind, photo).clone();
    // All per-instance data lives in ONE interleaved buffer (WebGPU allows only 8 vertex buffers)
    const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(n * 24), 24, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    const cover = new THREE.InterleavedBufferAttribute(buf, 4, 0);
    const spine = new THREE.InterleavedBufferAttribute(buf, 4, 4);
    const color = new THREE.InterleavedBufferAttribute(buf, 4, 8);
    const glow = new THREE.InterleavedBufferAttribute(buf, 4, 12);
    const state = new THREE.InterleavedBufferAttribute(buf, 4, 16);
    const extra = new THREE.InterleavedBufferAttribute(buf, 4, 20);
    geo.setAttribute("iExtra", extra);
    geo.setAttribute("iCover", cover);
    geo.setAttribute("iSpine", spine);
    geo.setAttribute("iColor", color);
    geo.setAttribute("iGlow", glow);
    geo.setAttribute("iState", state);
    const mesh = new THREE.InstancedMesh(geo, this.holo ? this.kit.holo : this.kit.solid, n);
    mesh.name = `${this.group.name}:${kind}${photo ? "+photo" : ""}`;
    mesh.frustumCulled = false; // instances are spread around; bounding sphere is computed below
    const b: Batch = { kind, photo, t, mesh, games: [], buf, cover, spine, color, glow, state, extra, inv: [], base: [] };
    const c = new THREE.Color();
    ps.forEach((p, i) => {
      const g = p.game;
      b.games.push(g);
      const m = new THREE.Matrix4().compose(p.position, p.quaternion, new THREE.Vector3().setScalar(p.scale ?? 1));
      mesh.setMatrixAt(i, m);
      b.base.push(m);
      b.inv.push(m.clone().invert());
      // front: real cartridge photo (contain-fit, alpha) or cover art cropped to the label
      let page: number;
      let pad: [number, number] = [-1, -1];
      const ph = photo ? this.kit.art.cartPhoto(g) : null;
      if (ph) {
        cover.setXYZW(i, ...ph.rect);
        page = ph.page;
        pad = photoPad(ph.aspect, kind);
      } else {
        const crop = coverCrop(g, this.kit.art, t);
        cover.setXYZW(i, ...crop.rect);
        page = crop.page;
      }
      // spine: real scan if we have one, else the runtime-printed one
      const real = this.kit.spines.usesReal(g) ? this.kit.art.realSpine(g) : null;
      let spinePage = 0;
      if (real) {
        spine.setXYZW(i, ...real.rect);
        spinePage = real.page;
      } else {
        const sr = this.kit.spines.rects.get(g.id);
        if (sr) spine.setXYZW(i, ...sr);
      }
      const plat = platformOf(g.platform);
      const special = SPECIAL_SHELLS[g.artKey];
      c.set(special?.color ?? (kind === "bigbox" ? this.kit.art.color(g) : plat.shell)).convertSRGBToLinear();
      color.setXYZW(i, c.r, c.g, c.b, page);
      c.set(this.holo ? "#4fd8ff" : plat.neon).convertSRGBToLinear();
      glow.setXYZW(i, c.r, c.g, c.b, 0);
      state.setXYZW(i, special?.roughness ?? t.shellRoughness, 0, 0, t.spineGlow);
      extra.setXYZW(i, spinePage, pad[0], pad[1], special?.metalness ?? 0);
      this.where.set(g.id, { b, i });
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    this.group.add(mesh);
    return b;
  }

  // ---- Cooper's grade / now-playing stickers (decals) -----------------------------------------
  private stickers: THREE.InstancedMesh | null = null;
  private stickerIdx = new Map<string, { i: number; local: THREE.Matrix4 }>();
  private static stickerMat: THREE.MeshStandardNodeMaterial | null = null;

  private makeStickers() {
    const items: { id: string; m: THREE.Matrix4; local: THREE.Matrix4; cell: number }[] = [];
    for (const b of this.batches) {
      const local = stickerLocal(b.t, b.photo);
      if (!local) continue;
      b.games.forEach((g, i) => {
        const cell = stickerCell(g);
        // the NEW! starburst is bigger than a grade dot so it's easy to spot
        const loc = cell === NEW_CELL ? local.clone().multiply(new THREE.Matrix4().makeScale(1.55, 1.55, 1)) : local;
        if (cell >= 0) items.push({ id: g.id, m: b.base[i].clone().multiply(loc), local: loc, cell });
      });
    }
    if (!items.length) return;
    const geo = new THREE.PlaneGeometry(1, 1);
    const cells = new THREE.InstancedBufferAttribute(new Float32Array(items.map((x) => x.cell)), 1);
    geo.setAttribute("sCell", cells);
    MediaField.stickerMat ??= stickerMaterial();
    const mesh = new THREE.InstancedMesh(geo, MediaField.stickerMat, items.length);
    items.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      this.stickerIdx.set(it.id, { i, local: it.local });
    });
    mesh.computeBoundingSphere();
    mesh.name = `${this.group.name}:stickers`;
    this.stickers = mesh;
    this.group.add(mesh);
  }

  private syncSticker(id: string, m: THREE.Matrix4 | null) {
    const s = this.stickerIdx.get(id);
    if (!s || !this.stickers) return;
    this.stickers.setMatrixAt(s.i, m ? m.clone().multiply(s.local) : ZERO);
    this.stickers.instanceMatrix.needsUpdate = true;
    this.stickers.boundingSphere = null;
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
    // the culling sphere was computed for the old layout (e.g. everything at the origin before an
    // animated field — tubes, flocks — first moves): recompute it lazily
    w.b.mesh.boundingSphere = null;
    this.syncSticker(id, m);
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
    this.syncSticker(id, hidden ? null : w.b.base[w.i]);
  }

  /** Glow colour (sRGB hex) + intensity for edges / highlight rim. */
  /**
   * Mark the recently added games: a pulsing rim in this room's colour (glow intensity -1 is the
   * shader's "new" flag) and a NEW! sticker (stickers are rebuilt to pick up the change).
   */
  setNew(ids: Set<string>, hex: string) {
    let changed = false;
    for (const b of this.batches) {
      b.games.forEach((g, i) => {
        const isNew = ids.has(g.id);
        const was = b.glow.getW(i) < 0;
        if (isNew === was) return;
        changed = true;
        if (isNew) this.setGlow(g.id, hex, -1);
        else b.glow.setW(i, 0), (b.buf.needsUpdate = true);
      });
    }
    if (!changed || this.holo) return;
    this.makeNewTags(ids, hex);
    if (this.stickers) {
      this.stickers.removeFromParent();
      this.stickers.geometry.dispose();
      this.stickers = null;
    }
    this.stickerIdx.clear();
    this.makeStickers();
    for (const id of this.hidden) this.syncSticker(id, null);
  }

  // ---- NEW! tags: a small glowing tag floating over each recently added game ------------------
  private newTags: THREE.Group | null = null;
  private static tagMats = new Map<string, THREE.SpriteNodeMaterial>();

  private static tagMaterial(hex: string) {
    let m = MediaField.tagMats.get(hex);
    if (m) return m;
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 72;
    const x = c.getContext("2d")!;
    x.fillStyle = hex;
    x.beginPath();
    x.roundRect(4, 4, 152, 52, 14);
    x.fill();
    x.beginPath();
    x.moveTo(68, 54);
    x.lineTo(80, 70);
    x.lineTo(92, 54);
    x.fill();
    x.fillStyle = "#16101e";
    x.font = `800 38px "Oswald", sans-serif`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText("NEW!", 80, 31);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const tex = texture(t);
    m.colorNode = tex.rgb;
    m.opacityNode = tex.a;
    // (a little emissive so it reads in dark rooms and catches a touch of bloom)
    (m as any).emissiveNode = tex.rgb.mul(0.6);
    MediaField.tagMats.set(hex, m);
    return m;
  }

  private makeNewTags(ids: Set<string>, hex: string) {
    if (this.newTags) {
      this.newTags.removeFromParent();
      this.newTags = null;
    }
    const g = new THREE.Group();
    g.name = `${this.group.name}:new-tags`;
    const mat = MediaField.tagMaterial(hex);
    for (const b of this.batches) {
      const [, h] = b.t.size;
      b.games.forEach((game, i) => {
        if (!ids.has(game.id)) return;
        const sp = new THREE.Sprite(mat);
        const p = new THREE.Vector3(0, h + 0.035, 0).applyMatrix4(b.base[i]);
        sp.position.copy(p);
        sp.scale.set(0.07, 0.0315, 1);
        sp.userData = { y: p.y, phase: i * 0.7 };
        sp.renderOrder = 6;
        g.add(sp);
      });
    }
    if (!g.children.length) return;
    this.newTags = g;
    this.group.add(g);
  }

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
    if (this.newTags) {
      const t = performance.now() / 1000;
      for (const sp of this.newTags.children) sp.position.y = sp.userData.y + Math.sin(t * 2.2 + sp.userData.phase) * 0.006;
    }
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
  // Overlays are pooled: materials are reused (new materials cost a node build each, and a
  // shader compile the first time), and one of each kind is pre-made so it gets precompiled.
  private overlays = new Map<string, Overlay>();
  private pool: Overlay[] = [];
  private detailT = 0;
  private hidden = new Set<string>();
  private static unitPlane = new THREE.PlaneGeometry(1, 1);

  private makeOverlay(photo: boolean): Overlay {
    const mesh = new THREE.Mesh(MediaField.unitPlane, overlayMaterial(photo, this.kit.art.pages[0]));
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.userData = { tex: this.kit.art.pages[0], crop: new THREE.Vector4(0, 0, 1, 1), fade: 0 };
    this.group.add(mesh);
    return { mesh, photo, id: "" };
  }

  private warmOverlays() {
    if (this.holo) return;
    const kinds = new Set(this.batches.map((b) => b.photo));
    for (const photo of kinds) this.pool.push(this.makeOverlay(photo));
  }

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
      const rect = b.photo ? photoRect(b.kind) : coverRect(b.kind);
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
        o.mesh.visible = false;
        o.id = "";
        this.overlays.delete(id);
        this.pool.push(o);
      }
    }
    for (const c of cands.slice(0, maxN)) {
      if (this.overlays.has(c.id)) continue;
      const g = c.b.games[c.i];
      const photo = c.b.photo;
      const rect = (photo ? photoRect(c.b.kind) : coverRect(c.b.kind))!;
      const pi = this.pool.findIndex((o) => o.photo === photo);
      const o = pi >= 0 ? this.pool.splice(pi, 1)[0] : this.makeOverlay(photo);
      o.id = c.id;
      const ud = o.mesh.userData;
      ud.fade = 0;
      o.mesh.visible = false;
      const w = rect[2] - rect[0], h = rect[3] - rect[1];
      o.mesh.matrix.multiplyMatrices(c.b.base[c.i], new THREE.Matrix4().makeTranslation((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2, rect[4])).multiply(new THREE.Matrix4().makeScale(w, h, 1));
      this.overlays.set(c.id, o);
      const la = c.b.t.labelAspect, cy = c.b.t.cropY;
      const mine = () => o.id === c.id && this.overlays.get(c.id) === o;
      (photo ? this.kit.art.tex(this.kit.art.entry(g)?.k) : this.kit.art.hiRes(g)).then((tex) => {
        if (!tex || !mine()) return;
        const img = tex.image as { width: number; height: number };
        const a = img.width / img.height;
        if (photo) {
          const [px, py] = photoPad(a, c.b.kind);
          ud.crop.set(px, py, 1 - 2 * px, 1 - 2 * py);
        } else if (a > la) ud.crop.set((1 - la / a) / 2, 0, la / a, 1);
        else ud.crop.set(0, (1 - a / la) * cy, 1, a / la);
        ud.tex = tex;
        o.mesh.visible = true;
        const t0 = performance.now();
        const step = () => {
          if (!mine()) return;
          ud.fade = Math.min(1, (performance.now() - t0) / 250);
          if (ud.fade < 1) requestAnimationFrame(step);
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
    this.overlays.clear();
    this.pool = [];
    for (const b of this.batches) {
      b.mesh.geometry.dispose();
      b.mesh.dispose();
    }
    this.group.removeFromParent();
  }
}
