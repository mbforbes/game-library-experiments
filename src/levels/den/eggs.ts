// Easter eggs for the Neon Den:
//  • Konami code (↑↑↓↓←→←→BA, or tap the holo-table 5× fast): rainbow neon, +30 LIVES, a Vic Viper flies through
//  • The impossible window: tap it to switch the world outside (neon city → outrun sunset → deep space)
//  • Lightning over the city every so often
//  • A pixel cat patrols the tops of the bookcases (tap it)
//  • Neon signs occasionally buzz and flicker (built into the sign materials)

import * as THREE from "three/webgpu";
import { texture, vec3, float, uniform } from "three/tsl";
import type { LevelCtx } from "../types";
import type { Hologram } from "../../world/kit/hologram";
import type { CrtScreen } from "../../world/kit/screens";
import { neonFx, neonMaterial, canvas, canvasTexture } from "../../world/kit/common";
import { outsideFx } from "../../world/kit/outside";

const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
const WORLDS = ["Neon City", "Outrun Sunset", "Deep Space"];

export class DenEggs {
  private keys: string[] = [];
  private taps: number[] = [];
  private rainbowT = 0;
  private nextLightning = 12;
  private lightningT = -1;
  private cat: Cat;
  private ship: VicViper;
  private modeTarget = 0;

  constructor(private ctx: LevelCtx, private o: { holo: Hologram; tv: CrtScreen; outside: { group: THREE.Group }; flashTarget: { flash: any }; catPath: { y: number; z: number; x0: number; x1: number } }) {
    this.cat = new Cat(o.catPath);
    ctx.scene.add(this.cat.mesh);
    ctx.pickable(this.cat.mesh, () => {
      this.cat.meow();
      ctx.toast("🐈 mrrp.");
    });
    this.ship = new VicViper();
    ctx.scene.add(this.ship.group);
    outsideFx.mode.value = 0;
  }

  key(e: KeyboardEvent): boolean {
    this.keys.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    this.keys = this.keys.slice(-KONAMI.length);
    if (this.keys.join(",") === KONAMI.join(",")) {
      this.keys = [];
      this.konami();
      return true;
    }
    return false;
  }

  tapTable() {
    const now = performance.now();
    this.taps = this.taps.filter((t) => now - t < 2500);
    this.taps.push(now);
    if (this.taps.length >= 5) {
      this.taps = [];
      this.konami();
    }
  }

  konami() {
    this.rainbowT = 16;
    this.ctx.toast("↑↑↓↓←→←→BA  ·  +30 LIVES", 4000);
    this.ship.launch();
    this.o.tv.burst(0.8);
  }

  cycleWindow() {
    this.modeTarget = (this.modeTarget + 1) % WORLDS.length;
    this.lightningT = 0; // flash covers the switch
    setTimeout(() => (outsideFx.mode.value = this.modeTarget), 120);
    this.ctx.toast(`🪟 ${WORLDS[this.modeTarget]}`);
  }

  update(dt: number, t: number) {
    // rainbow neon
    if (this.rainbowT > 0) this.rainbowT -= dt;
    const target = this.rainbowT > 0 ? 1 : 0;
    neonFx.rainbow.value += (target - neonFx.rainbow.value) * Math.min(1, dt * 2);
    // lightning (city mode only)
    this.nextLightning -= dt;
    if (this.nextLightning <= 0 && this.modeTarget === 0) {
      this.nextLightning = 25 + Math.random() * 40;
      this.lightningT = 0;
    }
    if (this.lightningT >= 0) {
      this.lightningT += dt;
      const k = this.lightningT;
      const f = k < 0.08 ? 1 : k < 0.16 ? 0.2 : k < 0.24 ? 0.8 : Math.max(0, 1 - (k - 0.24) * 3);
      outsideFx.lightning.value = f;
      this.o.flashTarget.flash.value = f * 0.06;
      if (k > 0.7) {
        this.lightningT = -1;
        outsideFx.lightning.value = 0;
        this.o.flashTarget.flash.value = 0;
      }
    }
    this.cat.update(dt, t);
    this.ship.update(dt);
  }

  dispose() {
    neonFx.rainbow.value = 0;
    outsideFx.mode.value = 0;
    this.o.flashTarget.flash.value = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Pixel cat: a sprite drawn in code, walking the tops of the bookcases, sometimes sitting.

const CAT_FRAMES = [
  // 16x10 pixel art, '#' body, 'o' eye, '.' empty. Two walk frames + sit.
  ["....##......##..", "....###....###..", "....##########..", "...###o####o##..", "...############.", "#..###########..", ".#.############.", "..##############", "..##.##....##.##", "..#...#....#...#"],
  ["....##......##..", "....###....###..", "....##########..", "...###o####o##..", "...############.", "..#############.", ".#.############.", "#.##############", "...##.#....#.##.", "...#..#.....#..."],
  ["..##......##....", "..###....###....", "..##########....", ".###o####o##....", ".############...", ".###########....", "..##########....", "..##########..#.", "..###########.#.", "..####..#####.#."],
];

class Cat {
  mesh: THREE.Mesh;
  private tex: THREE.CanvasTexture;
  private c: HTMLCanvasElement;
  private x: number;
  private dir = 1;
  private state: "hidden" | "walk" | "sit" = "hidden";
  private timer = 20;
  private frameT = 0;
  private frame = 0;
  private hop = 0;
  private alpha = uniform(0);

  constructor(private path: { y: number; z: number; x0: number; x1: number }) {
    [this.c] = canvas(16, 10);
    this.tex = canvasTexture(this.c, { nearest: true });
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, alphaTest: 0.5 });
    const s = texture(this.tex);
    m.colorNode = s.rgb.mul(0.9);
    m.emissiveNode = vec3(0.02);
    m.opacityNode = s.a.mul(this.alpha);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.2), m);
    this.x = path.x0;
    this.mesh.visible = false;
    this.draw(0);
  }

  private draw(f: number) {
    const ctx = this.c.getContext("2d")!;
    ctx.clearRect(0, 0, 16, 10);
    CAT_FRAMES[f].forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch === ".") return;
        ctx.fillStyle = ch === "o" ? "#7dff9a" : "#1b1b22";
        ctx.fillRect(this.dir > 0 ? x : 15 - x, y, 1, 1);
      }),
    );
    // rim light so it reads against the dark wall
    this.tex.needsUpdate = true;
  }

  meow() {
    this.hop = 0.35;
    this.state = "sit";
    this.timer = 3;
  }

  update(dt: number, t: number) {
    this.timer -= dt;
    if (this.state === "hidden") {
      this.alpha.value = 0;
      if (this.timer <= 0) {
        this.state = "walk";
        this.dir = Math.random() < 0.5 ? 1 : -1;
        this.x = this.dir > 0 ? this.path.x0 : this.path.x1;
        this.mesh.visible = true;
        this.timer = 4 + Math.random() * 4;
      }
      return;
    }
    this.alpha.value = Math.min(1, this.alpha.value + dt * 2);
    if (this.state === "walk") {
      this.x += this.dir * dt * 0.28;
      this.frameT += dt;
      if (this.frameT > 0.18) {
        this.frameT = 0;
        this.frame = 1 - this.frame;
        this.draw(this.frame);
      }
      if (this.timer <= 0) {
        this.state = "sit";
        this.timer = 3 + Math.random() * 4;
        this.draw(2);
      }
      if (this.x > this.path.x1 + 0.3 || this.x < this.path.x0 - 0.3) {
        this.state = "hidden";
        this.mesh.visible = false;
        this.timer = 60 + Math.random() * 90;
      }
    } else if (this.state === "sit" && this.timer <= 0) {
      this.state = "walk";
      this.timer = 5 + Math.random() * 5;
    }
    this.hop = Math.max(0, this.hop - dt);
    const bob = this.state === "walk" ? Math.abs(Math.sin(t * 9)) * 0.008 : 0;
    this.mesh.position.set(this.x, this.path.y + 0.1 + bob + Math.sin((this.hop / 0.35) * Math.PI) * 0.08, this.path.z + 0.12);
  }
}

// ---------------------------------------------------------------------------------------------
// Vic Viper (Gradius) flyby: a little glowing ship that loops through the room leaving a trail.

class VicViper {
  group = new THREE.Group();
  private t = -1;
  private trail: THREE.Mesh[] = [];
  private curve = new THREE.CatmullRomCurve3(
    [
      [-5, 2.2, 2.5],
      [-2, 2.4, -1.5],
      [1.5, 1.6, -2.2],
      [3.2, 1.2, 0],
      [1, 1.8, 2],
      [-2, 1.4, 1.2],
      [-1, 2.2, -1],
      [2, 2.6, -1.5],
      [5.5, 2.5, -2.5],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  );

  constructor() {
    const body = new THREE.Mesh(this.shipGeo(), new THREE.MeshStandardNodeMaterial({ color: 0xdfe6ff, roughness: 0.35, metalness: 0.5 }));
    const engine = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), neonMaterial("#4fd8ff", 12));
    engine.position.set(0, 0, -0.16);
    this.group.add(body, engine);
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.012 * (1 - i / 16), 6, 6), neonMaterial(i % 2 ? "#ff3d9a" : "#4fd8ff", 6 * (1 - i / 14)));
      s.visible = false;
      this.trail.push(s);
      this.group.add(s);
    }
    this.group.visible = false;
  }

  private shipGeo() {
    const s = new THREE.Shape();
    s.moveTo(0, 0.2);
    s.lineTo(0.05, 0.02);
    s.lineTo(0.16, -0.08);
    s.lineTo(0.05, -0.06);
    s.lineTo(0.03, -0.14);
    s.lineTo(-0.03, -0.14);
    s.lineTo(-0.05, -0.06);
    s.lineTo(-0.16, -0.08);
    s.lineTo(-0.05, 0.02);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    return g;
  }

  launch() {
    this.t = 0;
    this.group.visible = true;
  }

  update(dt: number) {
    if (this.t < 0) return;
    this.t += dt / 7;
    if (this.t >= 1) {
      this.t = -1;
      this.group.visible = false;
      return;
    }
    const ship = this.group.children[0];
    const p = this.curve.getPointAt(this.t);
    const ahead = this.curve.getPointAt(Math.min(1, this.t + 0.01));
    ship.position.copy(p);
    ship.lookAt(ahead);
    this.group.children[1].position.copy(p).addScaledVector(ahead.clone().sub(p).normalize(), -0.15);
    this.trail.forEach((s, i) => {
      const tt = this.t - i * 0.006;
      s.visible = tt > 0;
      if (tt > 0) s.position.copy(this.curve.getPointAt(tt));
    });
  }
}

export { float };
