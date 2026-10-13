// Hero: one game pulled out for inspection. Same template geometry as the instanced version,
// but every face is hi-res and as real as we can make it:
//   front  hi-res box art, or the real cartridge photo (alpha cut-out) for carts
//   spine  the real spine scan, or a printed spine in the platform's retail design
//   back   the real back cover scan; otherwise a generated back in the platform's style
//          (header band, logo, screenshots, Cooper's review, ESRB box, publisher, barcode);
//          carts get their real back photo or a molded-plastic cartridge back

import * as THREE from "three/webgpu";
import { attribute, texture, uv, vec2, vec3, float, select, uniform, normalView, positionViewDirection, step } from "three/tsl";
import type { Game } from "../../shared/types";
import { platformOf, type Platform } from "../../shared/platforms";
import type { ArtStore } from "../library/art";
import { drawProceduralCover, wrap } from "../library/art";
import { geometryFor } from "./templates";
import { kindOf, templateOf, coverCrop, photoPad } from "./field";
import { drawSpine, fitText, GRADE_COLORS } from "./spines";
import { SPECIAL_SHELLS, barcode, editionOf, editionStyle, esrbBox, spineDesign, wordmark } from "./branding";
import { stickerCell, stickerLocal, stickerMaterial } from "./stickers";

export class Hero {
  readonly object = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly game: Game;
  private spineCanvas = document.createElement("canvas");
  private backCanvas = document.createElement("canvas");
  private disposables: THREE.Texture[] = [];
  private coverRect = uniform(new THREE.Vector4(0, 0, 1, 1));
  private photoPad = uniform(new THREE.Vector2(-1, -1));
  private glowU = uniform(0);
  private disposed = false;

  constructor(game: Game, private art: ArtStore) {
    this.game = game;
    const t = templateOf(game, art);
    const kind = kindOf(game, art);
    const p = platformOf(game.platform);
    const e = art.entry(game);
    const isCart = !t.spine && kind !== "cabinet";
    const photo = !!t.buildPhoto && !!e?.k;

    // ---- front: atlas first (instant), hi-res when loaded
    let frontTex: THREE.Texture;
    const ph = photo ? art.cartPhoto(game) : null;
    if (ph) {
      frontTex = art.pages[ph.page];
      this.coverRect.value.set(...ph.rect);
      this.photoPad.value.set(...photoPad(ph.aspect, kind));
    } else if (photo) {
      frontTex = art.pages[0];
      this.photoPad.value.set(0, 0);
      this.coverRect.value.set(0, 0, 0, 0);
    } else {
      const crop = coverCrop(game, art, t);
      frontTex = art.pages[crop.page];
      this.coverRect.value.set(...crop.rect);
    }

    // ---- spine: real scan or printed
    const [sw, sh] = t.spine ?? [0.02, 0.2];
    const horiz = sw > sh;
    const H = 1024;
    this.spineCanvas.height = horiz ? Math.round(H * (sh / sw)) : H;
    this.spineCanvas.width = horiz ? H : Math.max(16, Math.round(H * (sw / sh)));
    drawSpine(this.spineCanvas.getContext("2d")!, 0, 0, this.spineCanvas.width, this.spineCanvas.height, game, art, horiz);
    const spineCanvasTex = this.canvasTex(this.spineCanvas);

    // ---- back: real scan, or generated in the platform's style
    const [w, h] = t.size;
    const bw = 900;
    this.backCanvas.width = bw;
    this.backCanvas.height = Math.round((bw * h) / w);
    const bctx = this.backCanvas.getContext("2d")!;
    const backCanvasTex = this.canvasTex(this.backCanvas);
    const redraw = () => (backCanvasTex.needsUpdate = true);
    if (isCart) drawCartBack(bctx, this.backCanvas.width, this.backCanvas.height, game, p);
    else drawBack(bctx, this.backCanvas.width, this.backCanvas.height, game, art, redraw);

    // Drawn after the inspect dimmer (transparent pass, high renderOrder), never hidden by shelves.
    const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.5 });
    const part = attribute("part", "float");
    const between = (a: number, b: number) => part.greaterThan(a).and(part.lessThan(b));
    const u = uv();
    // photo mode: contain-fit with alpha (pad >= 0); otherwise crop rect over the label
    const isPhoto = this.photoPad.x.greaterThanEqual(0);
    const pp = u.sub(this.photoPad).div(vec2(1, 1).sub(this.photoPad.mul(2)));
    const inside = step(0, pp.x).mul(step(pp.x, 1)).mul(step(0, pp.y)).mul(step(pp.y, 1));
    const pq = pp.clamp(0.001, 0.999);
    const frontUV = select(isPhoto, this.coverRect.xy.add(vec2(pq.x, pq.y.oneMinus()).mul(this.coverRect.zw)), this.coverRect.xy.add(vec2(u.x, u.y.oneMinus()).mul(this.coverRect.zw)));
    const front = texture(frontTex, frontUV);
    const spineNode = texture(spineCanvasTex, vec2(u.x, u.y.oneMinus()));
    const backNode = texture(backCanvasTex, vec2(u.x, u.y.oneMinus()));
    const special = SPECIAL_SHELLS[game.artKey];
    const shellHex = special?.color ?? (kind === "bigbox" ? art.color(game) : p.shell);
    const shell = vec3(...new THREE.Color(shellHex).convertSRGBToLinear().toArray());
    const neon = vec3(...new THREE.Color(p.neon).convertSRGBToLinear().toArray());
    let col: any = shell;
    const hasBackArt = t.spine !== null || kind === "bigbox" || isCart;
    col = select(between(2.5, 3.5), hasBackArt ? backNode.rgb : shell.mul(0.6), col);
    col = select(between(0.5, 1.5), front.rgb, col);
    col = select(between(1.5, 2.5), spineNode.rgb, col);
    col = select(between(5.5, 6.5), vec3(0.015), col);
    col = select(between(4.5, 5.5), vec3(0.012, 0.014, 0.018), col);
    mat.colorNode = col;
    mat.opacityNode = select(between(0.5, 1.5).and(isPhoto), front.a.mul(inside), float(1));
    mat.roughnessNode = select(between(0.5, 1.5), float(0.25), select(between(4.5, 5.5), float(0.08), float(special?.roughness ?? t.shellRoughness)));
    mat.metalnessNode = select(part.lessThan(0.5), float(special?.metalness ?? 0), float(0));
    const rim = float(1).sub(normalView.dot(positionViewDirection).abs()).pow(2.5);
    let glow: any = neon.mul(select(between(4.5, 5.5), float(1.6), float(0)));
    glow = glow.add(select(between(1.5, 2.5), spineNode.rgb.mul(t.spineGlow), vec3(0)));
    glow = glow.add(neon.mul(rim.mul(this.glowU)));
    // a little self-light so the box reads clearly wherever it floats in the (dark) room
    glow = glow.add(col.mul(0.22));
    mat.emissiveNode = glow;

    this.mesh = new THREE.Mesh(geometryFor(kind, photo), mat);
    // centre the mesh on the group's origin so it rotates about its middle
    this.mesh.position.y = -t.size[1] / 2;
    this.object.add(this.mesh);
    // Cooper's sticker
    const cell = stickerCell(game);
    const local = stickerLocal(t, photo);
    if (cell >= 0 && local) {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.setAttribute("sCell", new THREE.Float32BufferAttribute([cell, cell, cell, cell], 1));
      const sm = stickerMaterial();
      sm.transparent = true;
      sm.depthTest = false;
      sm.depthWrite = false;
      const sticker = new THREE.Mesh(geo, sm);
      sticker.applyMatrix4(local);
      sticker.renderOrder = 1000;
      this.mesh.add(sticker);
    }

    // ---- upgrade to hi-res / real scans as they arrive
    if (photo) {
      art.tex(e!.k).then((tex) => {
        if (!tex || this.disposed) return;
        const img = tex.image as { width: number; height: number };
        front.value = tex;
        this.coverRect.value.set(0, 0, 1, 1);
        this.photoPad.value.set(...photoPad(img.width / img.height, kind));
      });
    } else {
      art.hiRes(game).then((tex) => {
        if (!tex || this.disposed) return;
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
        front.value = tex;
        this.coverRect.value.set(cu, cv, cw, ch);
      });
    }
    if (e?.spc && !editionOf(game)) art.tex(e.spc).then((tex) => !this.disposed && tex && (spineNode.value = tex));
    const realBack = isCart ? e?.kb : e?.b;
    if (realBack) art.tex(realBack).then((tex) => !this.disposed && tex && (backNode.value = tex));
  }

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
    this.object.traverse((o) => ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose());
    for (const t of this.disposables) t.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Generated back cover in the platform's retail style (used when there's no real scan).

const loadImage = (src: string) =>
  new Promise<HTMLImageElement | null>((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = src;
  });

export function drawBack(ctx: CanvasRenderingContext2D, W: number, H: number, g: Game, art: ArtStore, onUpdate?: () => void) {
  const p = platformOf(g.platform);
  const d = spineDesign(p);
  const pad = W * 0.06;
  const e = art.entry(g);
  // background: dark wash of the cover's colour
  ctx.fillStyle = "#0e0e14";
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, art.color(g) + "dd");
  grad.addColorStop(0.55, "#0e0e14");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // platform header band
  const hb = H * 0.06;
  ctx.fillStyle = d.band;
  ctx.fillRect(0, 0, W, hb);
  wordmark(ctx, p, pad, hb * 0.12, W * 0.5, hb * 0.76, d.bandFg);
  const ed = editionOf(g);
  if (ed) {
    const es = editionStyle(ed, p);
    ctx.fillStyle = es.bg;
    ctx.fillRect(W * 0.6, 0, W * 0.4, hb);
    ctx.fillStyle = es.fg;
    fitText(ctx, es.text, W * 0.8, hb / 2, W * 0.36, hb * 0.6, `"Barlow Condensed", sans-serif`, "center", 700);
  }
  // title (replaced by the clear logo when it loads)
  let y = hb + H * 0.03;
  const titleH = H * 0.13;
  ctx.fillStyle = "#fff";
  ctx.font = `600 ${Math.round(W * 0.07)}px "Oswald", sans-serif`;
  ctx.textBaseline = "alphabetic";
  const lines = wrap(ctx, g.title.toUpperCase().split(" "), W - pad * 2).slice(0, 2);
  lines.forEach((l, i) => ctx.fillText(l, pad, y + W * 0.07 * (i + 1)));
  const logoY = y;
  y += titleH;
  // screenshots strip
  const shotsY = y;
  const shotW = (W - pad * 2 - W * 0.04) / 3, shotH = shotW * 0.75;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = "#ffffff18";
    ctx.fillRect(pad + i * (shotW + W * 0.02), shotsY, shotW, shotH);
  }
  y += shotH + H * 0.03;
  // Cooper's review (or a status line) + grade badge
  const text = g.review ?? (g.status === "wishlist" ? "On the hunt for a copy." : g.status === "playing" ? "Currently in progress." : "Waiting patiently in the backlog.");
  const bottomBlock = H * 0.12;
  ctx.fillStyle = "#8b93a7";
  ctx.font = `600 ${Math.round(W * 0.026)}px "Inter", sans-serif`;
  ctx.fillText(g.review ? "COOPER'S REVIEW" : (g.status === "completed" ? "BEATEN" : g.status.toUpperCase()), pad, y + W * 0.026);
  if (g.grade) {
    const r = W * 0.045;
    ctx.fillStyle = GRADE_COLORS[g.grade];
    ctx.beginPath();
    ctx.arc(W - pad - r, y + r * 0.4, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#111";
    fitText(ctx, g.grade, W - pad - r, y + r * 0.4, r * 1.5, r * 1.1, `"Oswald", sans-serif`, "center", 700);
  }
  y += W * 0.045;
  ctx.fillStyle = "#e9ecf2";
  let size = Math.round(W * 0.03);
  const maxH = H - y - bottomBlock - pad * 0.5;
  let body: string[] = [];
  for (; size > 10; size--) {
    ctx.font = `400 ${size}px "Inter", sans-serif`;
    body = wrap(ctx, text.split(/\s+/), W - pad * 2);
    if (body.length * size * 1.36 <= maxH) break;
  }
  ctx.textBaseline = "alphabetic";
  for (const l of body) {
    y += size * 1.36;
    if (y > H - bottomBlock) break;
    ctx.fillText(l, pad, y);
  }
  // footer: ESRB, publisher, barcode, legal line
  const fy = H - bottomBlock + pad * 0.2;
  ctx.fillStyle = "#ffffff10";
  ctx.fillRect(0, fy - pad * 0.3, W, H - fy + pad * 0.3);
  let fx = pad;
  if (art.esrb(g)) fx += esrbBox(ctx, art.esrb(g)!, fx, fy, bottomBlock * 0.72) + pad * 0.5;
  ctx.fillStyle = "#c9d1e0";
  ctx.font = `600 ${Math.round(W * 0.03)}px "Barlow Condensed", sans-serif`;
  ctx.fillText((art.publisher(g) ?? g.developer ?? "").toUpperCase(), fx, fy + bottomBlock * 0.3, W * 0.4);
  ctx.font = `400 ${Math.round(W * 0.018)}px "Inter", sans-serif`;
  ctx.fillStyle = "#8b93a7";
  ctx.fillText(`FOR USE WITH THE ${p.name.toUpperCase()} SYSTEM`, fx, fy + bottomBlock * 0.55, W * 0.45);
  const yr = art.year(g);
  if (yr) ctx.fillText(`© ${yr} ${(g.developer || "").toUpperCase()}`, fx, fy + bottomBlock * 0.72, W * 0.45);
  barcode(ctx, g.title, W - pad - W * 0.24, fy, W * 0.24, bottomBlock * 0.7);

  // async: clear logo + screenshots
  if (e?.l)
    loadImage("/art/" + e.l).then((img) => {
      if (!img) return;
      ctx.fillStyle = "#0e0e14";
      const g2 = ctx.createLinearGradient(0, 0, 0, H);
      g2.addColorStop(0, art.color(g) + "dd");
      g2.addColorStop(0.55, "#0e0e14");
      ctx.fillStyle = g2;
      ctx.fillRect(0, logoY, W, titleH);
      const s = Math.min((W - pad * 2) / img.width, (titleH * 0.9) / img.height);
      ctx.drawImage(img, pad, logoY + (titleH - img.height * s) / 2, img.width * s, img.height * s);
      onUpdate?.();
    });
  (e?.s ?? []).slice(0, 3).forEach((sPath, i) =>
    loadImage("/art/" + sPath).then((img) => {
      if (!img) return;
      const x = pad + i * (shotW + W * 0.02);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, shotsY, shotW, shotH);
      ctx.clip();
      const sc = Math.max(shotW / img.width, shotH / img.height);
      ctx.imageSmoothingEnabled = !e?.px;
      ctx.drawImage(img, x + (shotW - img.width * sc) / 2, shotsY + (shotH - img.height * sc) / 2, img.width * sc, img.height * sc);
      ctx.restore();
      ctx.strokeStyle = "#ffffffcc";
      ctx.lineWidth = W * 0.004;
      ctx.strokeRect(x, shotsY, shotW, shotH);
      onUpdate?.();
    }),
  );
}

/** The back of a cartridge: molded plastic with a warning/label sticker. */
export function drawCartBack(ctx: CanvasRenderingContext2D, W: number, H: number, g: Game, p: Platform) {
  const special = SPECIAL_SHELLS[g.artKey];
  const shell = special?.color ?? p.shell;
  ctx.fillStyle = shell;
  ctx.fillRect(0, 0, W, H);
  // subtle molded ribs
  ctx.strokeStyle = "rgba(0,0,0,0.08)";
  ctx.lineWidth = W * 0.006;
  for (let i = 1; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(W * 0.08, H * (0.06 + i * 0.03));
    ctx.lineTo(W * 0.92, H * (0.06 + i * 0.03));
    ctx.stroke();
  }
  // sticker
  const sx = W * 0.14, sy = H * 0.3, sw = W * 0.72, sh = H * 0.5;
  ctx.fillStyle = "#e9e6dc";
  ctx.fillRect(sx, sy, sw, sh);
  ctx.fillStyle = "#1a1a1a";
  ctx.textBaseline = "alphabetic";
  const brand = p.family === "sega" ? "SEGA" : p.family === "nec" ? "NEC" : "Nintendo";
  ctx.font = `700 ${Math.round(sh * 0.13)}px "Oswald", sans-serif`;
  ctx.fillText(brand, sx + sw * 0.06, sy + sh * 0.2);
  ctx.font = `400 ${Math.round(sh * 0.052)}px "Inter", sans-serif`;
  const lines = [
    "IMPORTANT: KEEP THIS GAME PAK OUT OF DIRECT SUNLIGHT.",
    "DO NOT TOUCH THE CONNECTORS. DO NOT GET THEM WET.",
    "TURN THE POWER OFF BEFORE INSERTING OR REMOVING.",
    `${p.short}-${g.title.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()}-USA`,
    "MADE IN JAPAN",
  ];
  lines.forEach((l, i) => ctx.fillText(l, sx + sw * 0.06, sy + sh * (0.36 + i * 0.12), sw * 0.88));
  // connector notch area
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(W * 0.2, H * 0.9, W * 0.6, H * 0.06);
}

export { drawProceduralCover };
