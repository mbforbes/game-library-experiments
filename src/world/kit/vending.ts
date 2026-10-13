// The Want-O-Matic: a vending machine stocked with Cooper's shopping list as holographic
// "not owned yet" games, sorted by his holistic score (best buy first), with price tags.
// Pages through all of them; the coils turn when you page.

import * as THREE from "three/webgpu";
import { texture, vec3 } from "three/tsl";
import type { Game } from "../../../shared/types";
import { MediaField, templateOf, type MediaKit, type Placement } from "../../media/field";
import { boxes, canvas, canvasTexture, neonMaterial, neonSign } from "./common";
import { DotMatrix } from "./displays";
import { platformOf } from "../../../shared/platforms";

const COLS = 4, ROWS = 5;

export class VendingMachine {
  readonly group = new THREE.Group();
  field: MediaField | null = null;
  page = 0;
  readonly perPage = COLS * ROWS;
  readonly display: DotMatrix;
  readonly buttons: { prev: THREE.Mesh; next: THREE.Mesh };
  private tagsTex: THREE.CanvasTexture;
  private tagsCanvas: HTMLCanvasElement;
  private coils: THREE.InstancedMesh;
  private coilSpin = 0;
  private slot = (c: number, r: number) => new THREE.Vector3(-0.42 + 0.08 + c * 0.17, 1.62 - r * 0.24, 0.12);
  onPage?: () => void;

  constructor(private kit: MediaKit, readonly games: Game[], private scene: THREE.Object3D) {
    const g = this.group;
    const W = 1.0, H = 1.95, D = 0.8;
    const body = new THREE.MeshStandardNodeMaterial({ color: 0x1a1030, roughness: 0.35, metalness: 0.3 });
    g.add(
      new THREE.Mesh(
        boxes([
          [0, H / 2, -D / 2, W, H, 0.04], // back
          [-W / 2 + 0.02, H / 2, 0, 0.04, H, D], // sides
          [W / 2 - 0.02, H / 2, 0, 0.04, H, D],
          [0, H - 0.03, 0, W, 0.06, D], // top
          [0, 0.2, 0, W, 0.4, D], // base
          [0.31, H / 2 + 0.2, D / 2 - 0.03, 0.34, H - 0.4, 0.06], // control panel column
          [-0.11, 0.44, D / 2 - 0.05, 0.7, 0.08, 0.1], // pickup tray lip
        ]),
        body,
      ),
    );
    // interior glow + shelves
    const interior = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 1.36), new THREE.MeshStandardNodeMaterial({ color: 0x0c0818, roughness: 0.9, emissive: 0x150a2a }));
    interior.position.set(-0.11, 1.1, -D / 2 + 0.05);
    g.add(interior);
    const shelfParts: [number, number, number, number, number, number][] = [];
    for (let r = 0; r < ROWS; r++) shelfParts.push([-0.11, this.slot(0, r).y - 0.02, 0, 0.72, 0.012, D - 0.12]);
    g.add(new THREE.Mesh(boxes(shelfParts), new THREE.MeshStandardNodeMaterial({ color: 0x2a2440, roughness: 0.3, metalness: 0.7 })));
    // coils (one helix, instanced per slot)
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 120; i++) {
      const a = (i / 120) * Math.PI * 2 * 5;
      pts.push(new THREE.Vector3(Math.cos(a) * 0.042, Math.sin(a) * 0.042, -0.32 + (i / 120) * 0.4));
    }
    const coilGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 200, 0.0025, 5, false);
    this.coils = new THREE.InstancedMesh(coilGeo, new THREE.MeshStandardNodeMaterial({ color: 0xc0c4d0, metalness: 0.9, roughness: 0.25 }), COLS * ROWS);
    g.add(this.coils);
    // glass
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 1.4), new THREE.MeshStandardNodeMaterial({ color: 0x223344, roughness: 0.04, metalness: 0.0, transparent: true, opacity: 0.12, depthWrite: false }));
    glass.position.set(-0.11, 1.12, D / 2 - 0.01);
    glass.renderOrder = 3;
    g.add(glass);
    // neon frame around the glass
    const frame = new THREE.Mesh(
      boxes([
        [-0.11, 1.83, D / 2, 0.74, 0.012, 0.012],
        [-0.11, 0.41, D / 2, 0.74, 0.012, 0.012],
        [-0.48, 1.12, D / 2, 0.012, 1.42, 0.012],
        [0.26, 1.12, D / 2, 0.012, 1.42, 0.012],
      ]),
      neonMaterial("#4fd8ff", 4),
    );
    g.add(frame);
    // price tags for the page (one canvas)
    [this.tagsCanvas] = canvas(512, 640);
    this.tagsTex = canvasTexture(this.tagsCanvas);
    const tm = new THREE.MeshBasicNodeMaterial({ transparent: true });
    const ts = texture(this.tagsTex);
    tm.colorNode = vec3(0);
    tm.emissiveNode = ts.rgb.mul(1.2);
    tm.opacityNode = ts.a;
    const tags = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.85 * 1.0), tm);
    tags.scale.set(1, 1.2 * 1.36 / 0.85 / 1.2, 1);
    tags.position.set(-0.11, 1.13, D / 2 - 0.035);
    g.add(tags);
    // header sign
    const sign = neonSign("WANT-O-MATIC", { font: `"Monoton", "Tilt Neon", sans-serif`, height: 0.2, color: "#ff3d9a", flicker: 0.01 });
    sign.position.set(0, H + 0.14, 0.05);
    g.add(sign);
    // side panel: display + buttons + coin slot
    this.display = new DotMatrix({ width: 0.28, height: 0.07, rows: 12, color: "#4fd8ff", off: "#06222a", speed: 16 });
    this.display.mesh.position.set(0.31, 1.62, D / 2 + 0.002);
    g.add(this.display.mesh);
    const btnGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.012, 20).rotateX(Math.PI / 2);
    this.buttons = { prev: new THREE.Mesh(btnGeo, neonMaterial("#ff3d9a", 1.6)), next: new THREE.Mesh(btnGeo, neonMaterial("#3dffa8", 1.6)) };
    this.buttons.prev.position.set(0.25, 1.45, D / 2 + 0.01);
    this.buttons.next.position.set(0.37, 1.45, D / 2 + 0.01);
    g.add(this.buttons.prev, this.buttons.next);
    const arrows = neonSign("◀       ▶", { font: `sans-serif`, height: 0.035, color: "#ffffff", intensity: 1.2 });
    arrows.position.set(0.31, 1.395, D / 2 + 0.02);
    g.add(arrows);
    const coin = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.05, 0.01), neonMaterial("#ffd23f", 1.2));
    coin.position.set(0.31, 1.25, D / 2 + 0.01);
    g.add(coin);
    this.setPage(0);
  }

  get pages() {
    return Math.max(1, Math.ceil(this.games.length / this.perPage));
  }

  pageOf(game: Game) {
    const i = this.games.findIndex((g) => g.id === game.id);
    return i < 0 ? -1 : Math.floor(i / this.perPage);
  }

  setPage(p: number) {
    this.page = ((p % this.pages) + this.pages) % this.pages;
    const list = this.games.slice(this.page * this.perPage, (this.page + 1) * this.perPage);
    this.field?.dispose();
    const placements: Placement[] = [];
    const m = new THREE.Matrix4();
    list.forEach((g, i) => {
      const c = i % COLS, r = Math.floor(i / COLS);
      const t = templateOf(g, this.kit.art);
      const [w, h] = t.size;
      const s = Math.min(0.15 / w, 0.2 / h, 1.4);
      const p = this.slot(c, r).clone().add(new THREE.Vector3(0, -0.012, 0.02));
      placements.push({ game: g, position: p, quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.08), scale: s });
    });
    this.field = new MediaField(this.kit, placements, { holo: true, name: "wishlist" });
    this.group.add(this.field.group);
    // coils
    for (let i = 0; i < COLS * ROWS; i++) {
      const c = i % COLS, r = Math.floor(i / COLS);
      const p = this.slot(c, r);
      m.makeTranslation(p.x, p.y + 0.035, p.z - 0.05);
      this.coils.setMatrixAt(i, m);
    }
    this.coils.instanceMatrix.needsUpdate = true;
    this.coilSpin = 1;
    this.drawTags(list);
    const top = this.games[0];
    const loose = this.games.reduce((s, g) => s + (g.looseValue ?? 0), 0);
    this.display.setText(`PAGE ${this.page + 1}/${this.pages}  ·  ${this.games.length} WANTED  ·  $${loose.toLocaleString()} LOOSE  ·  BEST BUY: ${top ? top.title.toUpperCase() : "-"}  ·  `);
    this.onPage?.();
  }

  private drawTags(list: Game[]) {
    const ctx = this.tagsCanvas.getContext("2d")!;
    const W = this.tagsCanvas.width, H = this.tagsCanvas.height;
    ctx.clearRect(0, 0, W, H);
    const cw = W / COLS, rh = H / ROWS;
    list.forEach((g, i) => {
      const c = i % COLS, r = Math.floor(i / COLS);
      const x = c * cw + 6, y = r * rh + rh - 30;
      ctx.fillStyle = "#0b0b10";
      ctx.fillRect(x, y, cw - 12, 24);
      ctx.fillStyle = platformOf(g.platform).neon;
      ctx.fillRect(x, y, 4, 24);
      ctx.font = `14px "Silkscreen", monospace`;
      ctx.fillStyle = "#ffd23f";
      ctx.textBaseline = "middle";
      ctx.fillText(g.looseValue ? `$${g.looseValue}` : "$??", x + 10, y + 12);
      ctx.fillStyle = "#9aa3b5";
      ctx.font = `11px "Silkscreen", monospace`;
      ctx.fillText(platformOf(g.platform).short.slice(0, 7), x + 58, y + 12, cw - 70);
    });
    this.tagsTex.needsUpdate = true;
  }

  update(dt: number) {
    this.display.update(dt);
    if (this.coilSpin > 0) {
      this.coilSpin = Math.max(0, this.coilSpin - dt);
      const m = new THREE.Matrix4();
      for (let i = 0; i < COLS * ROWS; i++) {
        const c = i % COLS, r = Math.floor(i / COLS);
        const p = this.slot(c, r);
        m.makeRotationZ((1 - this.coilSpin) * Math.PI * 2).setPosition(p.x, p.y + 0.035, p.z - 0.05);
        this.coils.setMatrixAt(i, m);
      }
      this.coils.instanceMatrix.needsUpdate = true;
    }
    this.field?.update(dt);
  }

  void() {
    void this.scene;
  }
}
