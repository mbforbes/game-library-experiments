// Hologram projector: a cloud of voxels sampled from a game's gameplay screenshot (or cover),
// pushed out in depth by brightness, tinted cyan, scan-lined and slowly turning. Pixel-art
// screenshots look great as voxels. All work happens in the vertex shader from instanceIndex.

import * as THREE from "three/webgpu";
import {
  texture, instanceIndex, vec2, vec3, vec4, float, uniform, time, sin, fract, floor, hash, mix, positionLocal, max, smoothstep,
  positionWorld, normalView, positionViewDirection, abs, cos,
} from "three/tsl";
import type { Game } from "../../../shared/types";
import type { ArtStore } from "../../library/art";
import { canvas, canvasTexture, lin, neonMaterial } from "./common";

export class Hologram {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private texNode: any;
  private aspect = uniform(1);
  private appear = uniform(0); // 0..1 materialize
  private spin = uniform(0);
  private appearTarget = 0;
  private cols: number;
  private rows: number;
  game: Game | null = null;
  private loadToken = 0;
  private titleTex: THREE.CanvasTexture;
  private titleCanvas: HTMLCanvasElement;
  private title: THREE.Mesh;

  constructor(private art: ArtStore, opts: { size?: number; res?: number; color?: string } = {}) {
    const size = opts.size ?? 0.7;
    const res = opts.res ?? 56;
    this.cols = res;
    this.rows = res;
    const tint = lin(opts.color ?? "#4fd8ff");
    const n = this.cols * this.rows;
    const vox = (size / res) * 0.82;
    const geo = new THREE.BoxGeometry(vox, vox, vox);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const [c0] = canvas(4, 4);
    this.texNode = texture(canvasTexture(c0));

    const i = float(instanceIndex);
    const cx = i.mod(this.cols);
    const cy = floor(i.div(this.cols));
    const u = cx.add(0.5).div(this.cols);
    const v = cy.add(0.5).div(this.rows);
    // fit the image aspect into the square grid
    const ar = this.aspect;
    const sx = max(float(1), ar), sy = max(float(1), float(1).div(ar));
    const uu = u.sub(0.5).mul(sx).add(0.5);
    const vv = v.sub(0.5).mul(sy).add(0.5);
    const inside = uu.greaterThanEqual(0).and(uu.lessThanEqual(1)).and(vv.greaterThanEqual(0)).and(vv.lessThanEqual(1));
    const s = this.texNode.sample(vec2(uu, vv.oneMinus())).level(0);
    const lum = s.r.mul(0.3).add(s.g.mul(0.55)).add(s.b.mul(0.15));
    const rnd = hash(i.mul(1.37));
    // materialize: voxels rise into place with a per-voxel delay
    const t = this.appear.mul(1.6).sub(rnd.mul(0.6)).clamp(0, 1);
    const ease = t.mul(t).mul(float(3).sub(t.mul(2)));
    const x = u.sub(0.5).mul(size);
    const y = v.mul(size);
    const z = lum.sub(0.35).mul(size * 0.22);
    const drift = sin(time.mul(1.3).add(rnd.mul(30))).mul(0.004);
    const offset = vec3(x, y.add(float(1).sub(ease).mul(-0.25)).add(drift), z);
    // spin around Y
    const a = this.spin;
    const rx = offset.x.mul(cos(a)).add(offset.z.mul(sin(a)));
    const rz = offset.z.mul(cos(a)).sub(offset.x.mul(sin(a)));
    const visible = inside.select(float(1), float(0)).mul(lum.greaterThan(0.06).select(float(1), float(0.0))).mul(ease);
    m.positionNode = positionLocal.mul(visible.mul(0.9).add(0.1).mul(visible.greaterThan(0).select(float(1), float(0)))).add(vec3(rx, offset.y, rz));
    // colour: the image itself, washed with cyan, scanlines in world y
    const scan = sin(positionWorld.y.mul(220).sub(time.mul(5))).mul(0.5).add(0.5);
    const flick = hash(floor(time.mul(20))).mul(0.15).add(0.85);
    const col = mix(s.rgb, vec3(tint.r, tint.g, tint.b).mul(lum.add(0.2)), 0.45).mul(scan.mul(0.5).add(0.6)).mul(flick).mul(visible);
    m.colorNode = vec3(0);
    m.emissiveNode = col.mul(1.6);
    m.opacityNode = visible.mul(0.9);
    this.mesh = new THREE.InstancedMesh(geo, m, n);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    // projector base: emitter disc + light cone
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.32, size * 0.36, 0.03, 40), new THREE.MeshStandardNodeMaterial({ color: 0x0d0f14, roughness: 0.3, metalness: 0.6 }));
    disc.position.y = -0.02;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(size * 0.3, 0.006, 8, 64), neonMaterial(opts.color ?? "#4fd8ff", 5));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.001;
    const coneMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const fade = smoothstep(float(size * 1.1), float(0), positionLocal.y.add(size * 0.55));
    const rim = float(1).sub(abs(normalView.dot(positionViewDirection))).pow(2);
    coneMat.colorNode = vec3(0);
    coneMat.emissiveNode = vec3(tint.r, tint.g, tint.b).mul(fade.mul(rim).mul(0.35));
    coneMat.opacityNode = fade.mul(0.5);
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.55, size * 0.28, size * 1.1, 40, 1, true), coneMat);
    cone.position.y = size * 0.55;
    this.group.add(disc, ring, cone);

    // title strip under the image
    [this.titleCanvas] = canvas(1024, 96);
    this.titleTex = canvasTexture(this.titleCanvas);
    const tm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const ts = texture(this.titleTex);
    tm.colorNode = vec3(0);
    tm.emissiveNode = ts.rgb.mul(vec3(tint.r, tint.g, tint.b)).mul(2.2).mul(this.appear);
    tm.opacityNode = ts.a.mul(this.appear);
    this.title = new THREE.Mesh(new THREE.PlaneGeometry(size * 1.1, size * 0.1), tm);
    this.title.position.y = size + 0.08;
    this.group.add(this.title);
  }

  async show(game: Game | null) {
    const token = ++this.loadToken;
    if (!game) {
      this.appearTarget = 0;
      return;
    }
    const e = this.art.entry(game);
    // prefer a gameplay screenshot (pixel art voxelizes beautifully), then the cover
    const path = e?.px ? (e.s?.[0] ?? e.t) : (e?.c ?? e?.s?.[0]);
    const tex = path ? await (path === e?.c ? this.art.hiRes(game) : this.art.snap(path, !!e?.px)) : null;
    if (token !== this.loadToken) return;
    if (!tex) {
      this.appearTarget = 0;
      return;
    }
    // quick dematerialize -> swap -> materialize
    this.appearTarget = 0;
    await new Promise((r) => setTimeout(r, this.appear.value > 0.05 ? 350 : 0));
    if (token !== this.loadToken) return;
    this.texNode.value = tex;
    const img = tex.image as { width: number; height: number };
    this.aspect.value = img.width / img.height;
    this.game = game;
    this.drawTitle(game.title);
    this.appearTarget = 1;
  }

  private drawTitle(t: string) {
    const ctx = this.titleCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, 1024, 96);
    ctx.font = `40px "Press Start 2P", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(t.toUpperCase(), 512, 50, 1000);
    this.titleTex.needsUpdate = true;
  }

  update(dt: number) {
    const k = this.appearTarget > this.appear.value ? 1.1 : 3;
    this.appear.value += Math.sign(this.appearTarget - this.appear.value) * Math.min(Math.abs(this.appearTarget - this.appear.value), dt * k);
    this.spin.value = Math.sin(performance.now() / 4000) * 0.6;
    this.title.rotation.y = 0;
  }
}

export { vec4, fract };
