// Screens that show gameplay: a CRT shader (curvature, scanlines, shadow mask, static) that
// cycles through real screenshots, plus the props that hold them (CRT TV, arcade cabinet).

import * as THREE from "three/webgpu";
import { texture, uv, vec2, vec3, float, uniform, sin, time, fract, hash, floor, mix, smoothstep, length, max, abs, step, dot } from "three/tsl";
import type { Game } from "../../../shared/types";
import type { ArtStore } from "../../library/art";
import { boxes, canvas, canvasTexture, lin, neonMaterial } from "./common";

const BLANK = (() => {
  const [c, ctx] = canvas(4, 4);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 4, 4);
  return canvasTexture(c);
})();

export class CrtScreen {
  readonly mesh: THREE.Mesh;
  private texNode: any;
  private staticAmt = uniform(1);
  private aspect = uniform(4 / 3);
  private imgAspect = uniform(4 / 3);
  private bright = uniform(1);
  private playlist: { game: Game; path: string; pixel: boolean }[] = [];
  private idx = -1;
  private timer = 0;
  private switching = 0;
  current: Game | null = null;
  interval = 6;
  onChange?: (g: Game | null) => void;

  constructor(private art: ArtStore, width: number, height: number, opts: { curve?: number; tint?: string } = {}) {
    const m = new THREE.MeshBasicNodeMaterial();
    const curve = float(opts.curve ?? 0.12);
    this.aspect.value = width / height;
    // barrel distortion
    const c = uv().sub(0.5);
    const r2 = dot(c, c);
    const uvc = c.mul(float(1).add(r2.mul(curve))).add(0.5);
    // fit image (contain) inside the screen
    const ar = this.imgAspect.div(this.aspect);
    const fit = vec2(max(float(1), float(1).div(ar)), max(float(1), ar));
    const img = uvc.sub(0.5).mul(fit).add(0.5);
    this.texNode = texture(BLANK, vec2(img.x, img.y.oneMinus()));
    const inside = step(0, img.x).mul(step(img.x, 1)).mul(step(0, img.y)).mul(step(img.y, 1));
    const edge = step(0, uvc.x).mul(step(uvc.x, 1)).mul(step(0, uvc.y)).mul(step(uvc.y, 1));
    let col: any = this.texNode.rgb.mul(inside);
    // scanlines + RGB shadow mask
    const lines = sin(uvc.y.mul(height * 1400)).mul(0.5).add(0.5).pow(1.6).mul(0.35).add(0.65);
    const px = floor(uvc.x.mul(width * 1100));
    const mask = vec3(
      step(fract(px.div(3)), 0.33).mul(0.25).add(0.85),
      step(0.33, fract(px.div(3))).mul(step(fract(px.div(3)), 0.66)).mul(0.25).add(0.85),
      step(0.66, fract(px.div(3))).mul(0.25).add(0.85),
    );
    col = col.mul(lines).mul(mask);
    // static noise
    const n = hash(floor(uvc.mul(vec2(width * 600, height * 600))).add(floor(time.mul(30)).mul(17.13)));
    const roll = smoothstep(0.0, 0.05, abs(fract(uvc.y.sub(time.mul(0.7))).sub(0.5))).mul(0.15).add(0.85);
    col = mix(col, vec3(n).mul(0.9), this.staticAmt).mul(roll);
    // vignette at the tube edge + slight flicker
    const vig = smoothstep(0.75, 0.35, length(c.mul(vec2(1, 1)))).mul(0.6).add(0.4);
    const flick = sin(time.mul(60)).mul(0.015).add(1);
    const tint = lin(opts.tint ?? "#ffffff");
    col = col.mul(vig).mul(flick).mul(edge).mul(vec3(tint.r, tint.g, tint.b)).mul(this.bright);
    m.colorNode = vec3(0);
    m.emissiveNode = col.mul(1.25);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), m);
  }

  setPlaylist(games: Game[], opts: { titleScreens?: boolean } = {}) {
    this.playlist = [];
    for (const g of games) {
      const e = this.art.entry(g);
      if (!e) continue;
      const paths = [...(e.s ?? [])];
      if (opts.titleScreens && e.t) paths.unshift(e.t);
      for (const p of paths.slice(0, 2)) this.playlist.push({ game: g, path: p, pixel: !!e.px });
    }
    // shuffle so screens next to each other differ
    for (let i = this.playlist.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.playlist[i], this.playlist[j]] = [this.playlist[j], this.playlist[i]];
    }
    this.idx = -1;
    this.timer = this.interval;
  }

  /** Show something specific right now (e.g. the inspected game). */
  async show(game: Game) {
    const e = this.art.entry(game);
    const path = e?.s?.[0] ?? e?.t;
    if (!path) return;
    await this.load({ game, path, pixel: !!e?.px });
    this.timer = -this.interval; // hold longer
  }

  burst(seconds = 0.4) {
    this.switching = seconds;
  }

  private async load(item: { game: Game; path: string; pixel: boolean }) {
    this.switching = 0.35;
    const tex = await this.art.snap(item.path, item.pixel);
    if (!tex) return;
    this.texNode.value = tex;
    const img = tex.image as { width: number; height: number };
    this.imgAspect.value = img.width / img.height;
    this.current = item.game;
    this.onChange?.(item.game);
  }

  update(dt: number) {
    this.timer += dt;
    if (this.playlist.length && this.timer >= this.interval) {
      this.timer = 0;
      this.idx = (this.idx + 1) % this.playlist.length;
      this.load(this.playlist[this.idx]);
    }
    this.switching = Math.max(0, this.switching - dt);
    const target = this.switching > 0 ? 1 : 0.035;
    this.staticAmt.value += (target - this.staticAmt.value) * Math.min(1, dt * 18);
  }
}

// ---------------------------------------------------------------------------------------------
// Props

/** A chunky 90s CRT television on a stand. Returns group + screen. Front faces +Z, origin at floor. */
export function crtTv(art: ArtStore, size = 0.62) {
  const g = new THREE.Group();
  const w = size, h = size * 0.82, d = size * 0.85;
  const bodyMat = new THREE.MeshStandardNodeMaterial({ color: 0x2a2a30, roughness: 0.55 });
  const standMat = new THREE.MeshStandardNodeMaterial({ color: 0x15151a, roughness: 0.4, metalness: 0.2 });
  const standH = 0.55;
  const stand = new THREE.Mesh(
    boxes([
      [0, standH - 0.02, 0, w * 1.6, 0.04, d * 0.9],
      [0, 0.02, 0, w * 1.6, 0.04, d * 0.9],
      [-w * 0.78, standH / 2, 0, 0.03, standH, d * 0.9],
      [w * 0.78, standH / 2, 0, 0.03, standH, d * 0.9],
      [0, standH * 0.5, -d * 0.43, w * 1.6, standH, 0.02],
    ]),
    standMat,
  );
  g.add(stand);
  const body = new THREE.Mesh(
    boxes([
      [0, standH + h / 2, -d * 0.1, w, h, d * 0.8],
      [0, standH + h / 2, -d * 0.55, w * 0.75, h * 0.75, d * 0.3],
    ]),
    bodyMat,
  );
  g.add(body);
  // bezel
  const bezel = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, h * 0.96, 0.02), new THREE.MeshStandardNodeMaterial({ color: 0x18181c, roughness: 0.35 }));
  bezel.position.set(0, standH + h / 2, d * 0.3);
  g.add(bezel);
  const screen = new CrtScreen(art, w * 0.8, h * 0.7, { curve: 0.18 });
  screen.mesh.position.set(-w * 0.04, standH + h * 0.52, d * 0.3 + 0.0115);
  g.add(screen.mesh);
  // power LED + knobs
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 8), neonMaterial("#ff2a2a", 6));
  led.position.set(w * 0.42, standH + h * 0.12, d * 0.315);
  g.add(led);
  // a console under the TV
  const cons = new THREE.Mesh(boxes([[0, standH * 0.55, 0, 0.26, 0.07, 0.2]]), new THREE.MeshStandardNodeMaterial({ color: 0x9a9aa0, roughness: 0.5 }));
  g.add(cons);
  const consLed = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.006, 0.004), neonMaterial("#ff3030", 5));
  consLed.position.set(-0.1, standH * 0.55, 0.101);
  g.add(consLed);
  return { group: g, screen, height: standH + h };
}

/** Full-size arcade cabinet; front faces +Z, origin at the floor. */
export function arcadeCabinet(art: ArtStore, opts: { color: string; neon: string; title: string }) {
  const g = new THREE.Group();
  const W = 0.68, D = 0.8, H = 1.85;
  // side profile (z, y), front at +z
  const prof: [number, number][] = [
    [-D / 2, 0],
    [D / 2 - 0.1, 0],
    [D / 2 - 0.1, 0.86],
    [D / 2 + 0.05, 0.95],
    [D / 2 - 0.02, 1.02],
    [D / 2 - 0.16, 1.5],
    [D / 2 - 0.05, 1.56],
    [D / 2 - 0.05, H],
    [-D / 2 + 0.1, H],
    [-D / 2, 1.5],
  ];
  const shape = new THREE.Shape(prof.map(([z, y]) => new THREE.Vector2(z, y)));
  const sideGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.025, bevelEnabled: false });
  const sideMat = new THREE.MeshStandardNodeMaterial({ color: lin(opts.color), roughness: 0.45 });
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(sideGeo, sideMat);
    side.rotation.y = -Math.PI / 2;
    side.position.x = sx * (W / 2) + (sx > 0 ? 0.025 : 0);
    g.add(side);
  }
  // body between the sides
  const bodyMat = new THREE.MeshStandardNodeMaterial({ color: 0x0c0c10, roughness: 0.6 });
  const inner = W - 0.05;
  g.add(
    new THREE.Mesh(
      boxes([
        [0, 0.43, D / 2 - 0.11, inner, 0.86, 0.02], // kick panel
        [0, 0.97, D / 2 - 0.02, inner, 0.03, 0.2], // control panel
        [0, H - 0.01, 0, inner, 0.02, D - 0.2], // top
        [0, H / 2, -D / 2 + 0.01, inner, H, 0.02], // back
      ]),
      bodyMat,
    ),
  );
  // joystick + buttons
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.06), new THREE.MeshStandardNodeMaterial({ color: 0x111111 }));
  stick.position.set(-0.12, 1.03, D / 2 - 0.01);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 12), neonMaterial("#ff2040", 1.2));
  ball.position.set(-0.12, 1.065, D / 2 - 0.01);
  g.add(stick, ball);
  ["#ffd23f", "#3ddc84", "#38b6ff"].forEach((c, i) => {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.012, 16), neonMaterial(c, 1.5));
    b.position.set(0.04 + i * 0.05, 0.99, D / 2 - 0.01 - (i % 2) * 0.03);
    g.add(b);
  });
  // screen (tilted back, matching the profile)
  const screen = new CrtScreen(art, 0.5, 0.4, { curve: 0.14 });
  const s0 = new THREE.Vector3(0, 1.02, D / 2 - 0.02), s1 = new THREE.Vector3(0, 1.5, D / 2 - 0.16);
  screen.mesh.position.copy(s0.clone().lerp(s1, 0.5)).add(new THREE.Vector3(0, 0, 0.01));
  screen.mesh.rotation.x = -Math.atan2(s0.z - s1.z, s1.y - s0.y);
  g.add(screen.mesh);
  // marquee
  const [mc, mctx] = canvas(512, 128);
  const grad = mctx.createLinearGradient(0, 0, 512, 0);
  grad.addColorStop(0, "#000");
  grad.addColorStop(0.5, "#120818");
  grad.addColorStop(1, "#000");
  mctx.fillStyle = grad;
  mctx.fillRect(0, 0, 512, 128);
  mctx.font = `44px "Press Start 2P", monospace`;
  mctx.textAlign = "center";
  mctx.textBaseline = "middle";
  mctx.shadowColor = opts.neon;
  mctx.shadowBlur = 18;
  mctx.fillStyle = opts.neon;
  const title = opts.title.toUpperCase();
  const size = Math.min(44, Math.floor(460 / Math.max(1, title.length) / 0.95));
  mctx.font = `${size}px "Press Start 2P", monospace`;
  mctx.fillText(title, 256, 66);
  mctx.shadowBlur = 0;
  mctx.fillStyle = "#fff";
  mctx.globalAlpha = 0.7;
  mctx.fillText(title, 256, 66);
  const mt = canvasTexture(mc);
  const mm = new THREE.MeshBasicNodeMaterial();
  mm.colorNode = vec3(0);
  mm.emissiveNode = texture(mt).rgb.mul(2.2);
  const marquee = new THREE.Mesh(new THREE.PlaneGeometry(inner, 0.2), mm);
  marquee.position.set(0, 1.7, D / 2 - 0.04);
  g.add(marquee);
  return { group: g, screen, marquee };
}
