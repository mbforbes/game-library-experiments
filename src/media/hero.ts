// Hero: one game pulled out for inspection. Same template geometry as the instanced version,
// but with a hi-res cover, a hi-res spine and a generated back cover (Cooper's review, grade,
// hours, dates) — so you can turn the box over and read it.

import * as THREE from "three/webgpu";
import { attribute, texture, uv, vec2, vec3, float, select, uniform, normalView, positionViewDirection } from "three/tsl";
import type { Game } from "../../shared/types";
import { platformOf } from "../../shared/platforms";
import type { ArtStore } from "../library/art";
import { drawProceduralCover, wrap } from "../library/art";
import { geometryFor } from "./templates";
import { kindOf, templateOf, coverCrop } from "./field";
import { drawSpine, fitText, GRADE_COLORS } from "./spines";

export class Hero {
  readonly object = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly game: Game;
  private coverTex: THREE.Texture;
  private spineCanvas = document.createElement("canvas");
  private backCanvas = document.createElement("canvas");
  private disposables: THREE.Texture[] = [];
  private coverRect = uniform(new THREE.Vector4(0, 0, 1, 1));
  private glowU = uniform(0);

  constructor(game: Game, private art: ArtStore) {
    this.game = game;
    const t = templateOf(game, art);
    const p = platformOf(game.platform);
    // initial cover = atlas (instant), swapped to hi-res when loaded
    const crop = coverCrop(game, art, t);
    this.coverTex = art.pages[crop.page];
    this.coverRect.value.set(...crop.rect);

    // spine
    const [sw, sh] = t.spine ?? [0.02, 0.2];
    const horiz = sw > sh;
    const H = 1024;
    this.spineCanvas.height = horiz ? Math.round(H * (sh / sw)) : H;
    this.spineCanvas.width = horiz ? H : Math.max(16, Math.round(H * (sw / sh)));
    drawSpine(this.spineCanvas.getContext("2d")!, 0, 0, this.spineCanvas.width, this.spineCanvas.height, game, art, horiz);
    const spineTex = this.canvasTex(this.spineCanvas);

    // back cover
    const [w, h] = t.size;
    const bw = 768;
    this.backCanvas.width = bw;
    this.backCanvas.height = Math.round((bw * h) / w);
    drawBack(this.backCanvas.getContext("2d")!, this.backCanvas.width, this.backCanvas.height, game, art);
    const backTex = this.canvasTex(this.backCanvas);

    // Drawn after the inspect dimmer (transparent pass, high renderOrder), never hidden by shelves.
    const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    const part = attribute("part", "float");
    const between = (a: number, b: number) => part.greaterThan(a).and(part.lessThan(b));
    const u = uv();
    const coverTexNode = texture(this.coverTex, this.coverRect.xy.add(vec2(u.x, u.y.oneMinus()).mul(this.coverRect.zw)));
    (this as any)._coverNode = coverTexNode;
    const spine = texture(spineTex, vec2(u.x, u.y.oneMinus()));
    const back = texture(backTex, vec2(u.x, u.y.oneMinus()));
    const shellHex = kindOf(game, art) === "bigbox" ? art.color(game) : p.shell;
    const shell = vec3(...new THREE.Color(shellHex).convertSRGBToLinear().toArray());
    const neon = vec3(...new THREE.Color(p.neon).convertSRGBToLinear().toArray());
    let col: any = shell;
    const hasBackArt = t.spine !== null || kindOf(game, art) === "bigbox";
    col = select(between(2.5, 3.5), hasBackArt ? back.rgb : shell.mul(0.6), col);
    col = select(between(0.5, 1.5), coverTexNode.rgb, col);
    col = select(between(1.5, 2.5), spine.rgb, col);
    col = select(between(5.5, 6.5), vec3(0.015), col);
    col = select(between(4.5, 5.5), vec3(0.012, 0.014, 0.018), col);
    mat.colorNode = col;
    mat.roughnessNode = select(between(0.5, 1.5), float(0.25), select(between(4.5, 5.5), float(0.08), float(t.shellRoughness)));
    mat.metalnessNode = float(0);
    const rim = float(1).sub(normalView.dot(positionViewDirection).abs()).pow(2.5);
    let glow: any = neon.mul(select(between(4.5, 5.5), float(1.6), float(0)));
    glow = glow.add(select(between(1.5, 2.5), spine.rgb.mul(t.spineGlow), vec3(0)));
    glow = glow.add(neon.mul(rim.mul(this.glowU)));
    // a little self-light so the box reads clearly wherever it floats in the (dark) room
    glow = glow.add(col.mul(0.22));
    mat.emissiveNode = glow;

    this.mesh = new THREE.Mesh(geometryFor(kindOf(game, art)), mat);
    // centre the mesh on the group's origin so it rotates about its middle
    this.mesh.position.y = -t.size[1] / 2;
    this.object.add(this.mesh);

    art.hiRes(game).then((tex) => {
      if (!tex || this.disposed) return;
      // hi-res texture holds just this cover: crop to the label aspect
      const img = tex.image as { width: number; height: number };
      const aspect = img.width / img.height;
      const la = t.labelAspect;
      let [cu, cv, cw, ch] = [0, 0, 1, 1];
      if (aspect > la) {
        cw = la / aspect;
        cu = (1 - cw) / 2;
      } else {
        ch = aspect / la;
        cv = (1 - ch) * t.cropY;
      }
      coverTexNode.value = tex;
      this.coverRect.value.set(cu, cv, cw, ch);
    });
  }

  private disposed = false;

  set glow(v: number) {
    this.glowU.value = v;
  }

  private canvasTex(c: HTMLCanvasElement) {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    t.anisotropy = 8;
    this.disposables.push(t);
    return t;
  }

  /** Size of the item (w, h, d) */
  get size() {
    return templateOf(this.game, this.art).size;
  }

  dispose() {
    this.disposed = true;
    this.object.removeFromParent();
    (this.mesh.material as THREE.Material).dispose();
    for (const t of this.disposables) t.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Back cover: a little "back of the box" made from the sheet data.

export function drawBack(ctx: CanvasRenderingContext2D, W: number, H: number, g: Game, art: ArtStore) {
  const p = platformOf(g.platform);
  const pad = W * 0.07;
  ctx.fillStyle = "#0d0d12";
  ctx.fillRect(0, 0, W, H);
  // colour wash from the art
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, art.color(g) + "cc");
  grad.addColorStop(0.5, "#0d0d12");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // platform band
  ctx.fillStyle = p.band;
  ctx.fillRect(0, 0, W, H * 0.055);
  ctx.fillStyle = p.bandText;
  fitText(ctx, p.name.toUpperCase(), pad, H * 0.028, W - pad * 2, H * 0.032, `"Barlow Condensed", sans-serif`, "left", 700);

  let y = H * 0.1;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  const titleSize = Math.round(W * 0.075);
  ctx.font = `600 ${titleSize}px "Oswald", sans-serif`;
  for (const line of wrap(ctx, g.title.toUpperCase().split(" "), W - pad * 2).slice(0, 3)) {
    ctx.fillText(line, pad, y + titleSize);
    y += titleSize * 1.15;
  }
  y += H * 0.012;
  ctx.font = `400 ${Math.round(W * 0.036)}px "Inter", sans-serif`;
  ctx.fillStyle = "#c9d1e0";
  const year = art.year(g);
  ctx.fillText([g.developer, year, g.genre].filter(Boolean).join("  ·  "), pad, y + W * 0.04);
  y += W * 0.08;

  // status block
  const box = (label: string, value: string, x: number, w: number, color = "#fff") => {
    ctx.fillStyle = "#ffffff14";
    ctx.fillRect(x, y, w, W * 0.15);
    ctx.fillStyle = "#8b93a7";
    ctx.font = `500 ${Math.round(W * 0.026)}px "Inter", sans-serif`;
    ctx.fillText(label.toUpperCase(), x + W * 0.02, y + W * 0.042);
    ctx.fillStyle = color;
    ctx.font = `600 ${Math.round(W * 0.06)}px "Oswald", sans-serif`;
    ctx.fillText(value, x + W * 0.02, y + W * 0.12);
  };
  const third = (W - pad * 2 - W * 0.04) / 3;
  if (g.status === "completed") {
    box("Grade", g.grade ?? "—", pad, third, g.grade ? GRADE_COLORS[g.grade] : "#fff");
    box("Beaten", g.completedOn ? fmtDate(g.completedOn) : "—", pad + third + W * 0.02, third);
    box("Copy", g.ownPhysical ? (g.value ? `$${g.value}` : "Physical") : "Digital", pad + (third + W * 0.02) * 2, third);
  } else if (g.status === "wishlist") {
    box("Loose", g.looseValue ? `$${g.looseValue}` : "—", pad, third, "#4fd8ff");
    box("CIB", g.cibValue ? `$${g.cibValue}` : "—", pad + third + W * 0.02, third);
    box("Rarity", g.rarity ? String(g.rarity) : "—", pad + (third + W * 0.02) * 2, third);
  } else {
    box("Status", g.status === "playing" ? "Playing" : "Backlog", pad, third, g.status === "playing" ? "#ffb000" : "#fff");
    box("Priority", g.priority ? `P${g.priority}` : "—", pad + third + W * 0.02, third);
    box("Length", g.hours ? `${g.hours}h` : "—", pad + (third + W * 0.02) * 2, third);
  }
  y += W * 0.2;

  // review / blurb
  const text = g.review ?? (g.status === "wishlist" ? "On the hunt for a copy." : g.status === "playing" ? "Currently in progress." : "Waiting patiently in the backlog.");
  ctx.fillStyle = "#e9ecf2";
  let size = Math.round(W * 0.034);
  const maxH = H - y - pad * 1.4;
  let lines: string[] = [];
  for (; size > 10; size--) {
    ctx.font = `400 ${size}px "Inter", sans-serif`;
    lines = wrap(ctx, text.split(/\s+/), W - pad * 2);
    if (lines.length * size * 1.38 <= maxH) break;
  }
  if (g.review) {
    ctx.fillStyle = "#8b93a7";
    ctx.font = `500 ${Math.round(W * 0.026)}px "Inter", sans-serif`;
    ctx.fillText("COOPER'S REVIEW", pad, y);
    y += W * 0.035;
    ctx.fillStyle = "#e9ecf2";
    ctx.font = `400 ${size}px "Inter", sans-serif`;
  }
  for (const l of lines) {
    if (y > H - pad) break;
    y += size * 1.38;
    ctx.fillText(l, pad, y);
  }
  // barcode-ish footer
  ctx.fillStyle = "#ffffff";
  const bx = W - pad - W * 0.22, by = H - pad * 0.9 - W * 0.06;
  for (let i = 0; i < 40; i++) {
    const bw = (Math.sin(i * 12.9898 + g.title.length) * 43758.5453) % 1 > 0.5 ? 2 : 1;
    ctx.fillRect(bx + i * (W * 0.0055), by, bw * (W * 0.002), W * 0.05);
  }
}

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${d} '${String(y).slice(2)}`;
};

export { drawProceduralCover };
