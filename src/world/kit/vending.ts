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
// Front layout (local x): side wall | glass GX0..GX1 | control column PX0..PX1 | side wall. Nothing
// on the control column may cross into the glass (the neon frame runs along the boundary).
const GX0 = -0.46, GX1 = 0.18, GW = GX1 - GX0, GCX = (GX0 + GX1) / 2;
const COLW = GW / COLS;
const PX0 = GX1, PX1 = 0.46, PCX = (PX0 + PX1) / 2, PW = PX1 - PX0;
/** top of shelf r (games stand on it) */
const shelfTop = (r: number) => 1.606 - r * 0.24;
// price tags: one canvas row per shelf at 1.25 mm per pixel both ways (512 px = the glass width)
const ROW_PX = 192, TAG_TOP = 156, TAG_H = 28;

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
  // the glass window spans x GX0..GX1 (the control column sits to its right); one column of slots per COLW
  private slot = (c: number, r: number) => new THREE.Vector3(GX0 + COLW * (c + 0.5), 1.62 - r * 0.24, 0.12);
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
          [PCX, H / 2 + 0.2, D / 2 - 0.03, PW, H - 0.4, 0.06], // control panel column (right of the glass)
          [GCX, 0.44, D / 2 - 0.05, GW, 0.08, 0.1], // pickup tray lip
          [GCX, 1.86, D / 2 - 0.03, GW, 0.06, 0.06], // header strip above the glass (closes the gap under the top)
          [0, H + 0.13, D / 2 - 0.1, W - 0.06, 0.26, 0.03], // topper board the neon sign is mounted on
          [-0.3, H + 0.01, D / 2 - 0.1, 0.06, 0.02, 0.12], // its feet
          [0.3, H + 0.01, D / 2 - 0.1, 0.06, 0.02, 0.12],
        ]),
        body,
      ),
    );
    // interior glow + shelves
    const interior = new THREE.Mesh(new THREE.PlaneGeometry(GW, 1.36), new THREE.MeshStandardNodeMaterial({ color: 0x0c0818, roughness: 0.9, emissive: 0x150a2a }));
    interior.position.set(GCX, 1.1, -D / 2 + 0.05);
    g.add(interior);
    const shelfParts: [number, number, number, number, number, number][] = [];
    for (let r = 0; r < ROWS; r++) {
      shelfParts.push([GCX, shelfTop(r) - 0.006, -0.01, GW, 0.012, D - 0.14]);
      // price channel along the shelf front (the tags sit in it)
      shelfParts.push([GCX, shelfTop(r) - 0.02, D / 2 - 0.074, GW, 0.04, 0.012]);
    }
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
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(GW, 1.4), new THREE.MeshStandardNodeMaterial({ color: 0x223344, roughness: 0.04, metalness: 0.0, transparent: true, opacity: 0.12, depthWrite: false }));
    glass.position.set(GCX, 1.12, D / 2 - 0.01);
    glass.renderOrder = 3;
    g.add(glass);
    // neon frame around the glass (set into the side wall, header, tray lip and the column's edge)
    const frame = new THREE.Mesh(
      boxes([
        [GCX, 1.83, D / 2, GW + 0.012, 0.012, 0.012],
        [GCX, 0.41, D / 2, GW + 0.012, 0.012, 0.012],
        [GX0, 1.12, D / 2, 0.012, 1.432, 0.012],
        [GX1, 1.12, D / 2, 0.012, 1.432, 0.012],
      ]),
      neonMaterial("#4fd8ff", 4),
    );
    g.add(frame);
    // price tags for the page (one canvas)
    [this.tagsCanvas] = canvas(512, ROW_PX * ROWS);
    this.tagsTex = canvasTexture(this.tagsCanvas);
    const tm = new THREE.MeshBasicNodeMaterial({ transparent: true });
    const ts = texture(this.tagsTex);
    tm.colorNode = vec3(0);
    tm.emissiveNode = ts.rgb.mul(1.2);
    tm.opacityNode = ts.a;
    // One canvas row per shelf (0.24 m): each row's tag band lands on that shelf's price channel (just
    // in front of it), and each canvas column on its slot column.
    const tags = new THREE.Mesh(new THREE.PlaneGeometry(GW, ROWS * 0.24), tm);
    tags.position.set(GCX, shelfTop(0) - 0.003 + (TAG_TOP / ROW_PX) * 0.24 - (ROWS * 0.24) / 2, D / 2 - 0.066);
    g.add(tags);
    // header sign, mounted on the topper board
    const sign = neonSign("WANT-O-MATIC", { font: `"Monoton", "Tilt Neon", sans-serif`, height: 0.2, color: "#ff3d9a", flicker: 0.01 });
    sign.position.set(0, H + 0.13, D / 2 - 0.1 + 0.0165);
    g.add(sign);
    // control column: display + buttons + coin slot, all inside PX0..PX1 (clear of the glass frame)
    this.display = new DotMatrix({ width: PW - 0.06, height: 0.07, rows: 12, color: "#4fd8ff", off: "#06222a", speed: 16 });
    this.display.mesh.position.set(PCX, 1.62, D / 2 + 0.002);
    g.add(this.display.mesh);
    const btnGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.012, 20).rotateX(Math.PI / 2);
    this.buttons = { prev: new THREE.Mesh(btnGeo, neonMaterial("#ff3d9a", 1.6)), next: new THREE.Mesh(btnGeo, neonMaterial("#3dffa8", 1.6)) };
    // set into the panel face (D/2): 2 mm in, 1 cm proud
    this.buttons.prev.position.set(PCX - 0.06, 1.45, D / 2 + 0.004);
    this.buttons.next.position.set(PCX + 0.06, 1.45, D / 2 + 0.004);
    g.add(this.buttons.prev, this.buttons.next);
    // printed on the panel under the buttons
    const arrows = neonSign("◀       ▶", { font: `sans-serif`, height: 0.035, color: "#ffffff", intensity: 1.2 });
    arrows.position.set(PCX, 1.395, D / 2 + 0.001);
    g.add(arrows);
    const coin = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.05, 0.01), neonMaterial("#ffd23f", 1.2));
    coin.position.set(PCX, 1.25, D / 2 + 0.003);
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
      const s = Math.min((COLW - 0.015) / w, 0.2 / h, 1.4);
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
      const x = c * cw + 6, y = r * rh + TAG_TOP;
      ctx.fillStyle = "#0b0b10";
      ctx.fillRect(x, y, cw - 12, TAG_H);
      ctx.fillStyle = platformOf(g.platform).neon;
      ctx.fillRect(x, y, 4, TAG_H);
      ctx.font = `15px "Silkscreen", monospace`;
      ctx.fillStyle = "#ffd23f";
      ctx.textBaseline = "middle";
      ctx.fillText(g.looseValue ? `$${g.looseValue}` : "$??", x + 10, y + TAG_H / 2, 44);
      ctx.fillStyle = "#9aa3b5";
      ctx.font = `11px "Silkscreen", monospace`;
      ctx.fillText(platformOf(g.platform).short.slice(0, 7), x + 58, y + TAG_H / 2, cw - 70);
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
