// Information displays that live in the world: a dot-matrix LED ticker, a split-flap board,
// and small "smart shelf" LED panels. All are canvas-backed and cheap to update.

import * as THREE from "three/webgpu";
import { texture, uv, vec2, vec3, float, uniform, fract, floor, smoothstep, length, mix, time, sin, mod } from "three/tsl";
import { canvas, canvasTexture, colorU, neonFx } from "./common";

// ---------------------------------------------------------------------------------------------
// Dot-matrix LED display: renders a text canvas through a grid of round LEDs. Scrolls when the
// text is wider than the panel.

export class DotMatrix {
  readonly mesh: THREE.Mesh;
  private c: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private scroll = uniform(0);
  private texW = uniform(1);
  private speed: number;
  private textPx = 0;
  readonly rows: number;
  readonly cols: number;

  constructor(opts: { width: number; height: number; rows?: number; color?: string; off?: string; speed?: number; font?: string }) {
    this.rows = opts.rows ?? 16;
    const pitch = opts.height / this.rows;
    this.cols = Math.round(opts.width / pitch);
    this.speed = opts.speed ?? 14; // dots per second
    [this.c, this.ctx] = canvas(2048, this.rows);
    this.tex = canvasTexture(this.c, { nearest: true, repeat: true });
    // per-display values are uniforms so every dot-matrix shares one compiled shader
    const on = colorU(opts.color ?? "#ffb000");
    const off = colorU(opts.off ?? "#2a1a08");
    const m = new THREE.MeshBasicNodeMaterial();
    const grid = uniform(new THREE.Vector2(this.cols, this.rows));
    const rowsU = uniform(this.rows);
    const cell = floor(uv().mul(grid));
    const local = fract(uv().mul(grid)).sub(0.5);
    // sample the text canvas: x in dots, scrolled, wrapped over the text width
    const sx = mod(cell.x.add(this.scroll), this.texW).add(0.5).div(2048);
    const sy = cell.y.add(0.5).div(rowsU); // canvas textures are flipY: v=0 is the bottom row
    const lit = texture(this.tex, vec2(sx, sy)).r;
    const dot = smoothstep(0.5, 0.32, length(local));
    const onC = mix(on, sin(time.mul(2).add(cell.x.mul(0.05)).add(vec3(0, 2.1, 4.2))).mul(0.5).add(0.5), neonFx.rainbow);
    const col = mix(off.mul(0.6), onC.mul(2.6), lit).mul(dot);
    m.colorNode = vec3(0.004);
    m.emissiveNode = col;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(opts.width, opts.height), m);
    this.font = opts.font ?? `"Silkscreen", "Press Start 2P", monospace`;
  }
  private font: string;

  /** Set the text (pipe-separated segments are joined with a dot separator). */
  setText(text: string) {
    const ctx = this.ctx;
    ctx.font = `${this.rows - 2}px ${this.font}`;
    // canvas stays 2048 wide; the shader wraps at the text width (plus a panel-width gap)
    const w = Math.min(2048, Math.ceil(ctx.measureText(text).width) + this.cols);
    this.textPx = w;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.c.width, this.rows);
    ctx.font = `${this.rows - 2}px ${this.font}`;
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 0, this.rows / 2 + 1);
    this.texW.value = w;
    this.tex.needsUpdate = true;
  }

  update(dt: number) {
    if (this.textPx > this.cols) this.scroll.value = (this.scroll.value + dt * this.speed) % this.textPx;
    else this.scroll.value = 0;
  }
}

/** Simple ticker variant: fixed width canvas sized for the text (recreated on setText). */
export function dotMatrixTicker(text: string, opts: ConstructorParameters<typeof DotMatrix>[0]) {
  const d = new DotMatrix(opts);
  d.setText(text);
  return d;
}

// ---------------------------------------------------------------------------------------------
// Split-flap board ("Solari"): rows of characters that flip through the alphabet to new text.

const FLAP_CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:-'&!?/+";

export class SplitFlap {
  readonly mesh: THREE.Mesh;
  private c: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private cur: string[][];
  private target: string[][];
  private colors: string[][];
  private delay: number[][];
  private acc = 0;
  private cw = 40;
  private ch = 60;
  dirty = true;

  constructor(readonly cols: number, readonly rows: number, width: number) {
    [this.c, this.ctx] = canvas(cols * this.cw, rows * this.ch);
    this.tex = canvasTexture(this.c);
    this.cur = Array.from({ length: rows }, () => Array(cols).fill(" "));
    this.target = this.cur.map((r) => [...r]);
    this.colors = this.cur.map((r) => r.map(() => "#f2f2f2"));
    this.delay = this.cur.map((r) => r.map(() => 0));
    const height = (width * rows * this.ch) / (cols * this.cw);
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.5 });
    const s = texture(this.tex);
    m.colorNode = s.rgb;
    m.emissiveNode = s.rgb.mul(0.55);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), m);
  }

  /** Set a row of text (upper-cased, padded/truncated) with an optional colour. */
  setRow(r: number, text: string, color = "#f2f2f2") {
    const t = text.toUpperCase().replace(/[^A-Z0-9 .:\-'&!?/+]/g, " ").padEnd(this.cols).slice(0, this.cols);
    for (let i = 0; i < this.cols; i++) {
      if (this.target[r][i] !== t[i]) this.delay[r][i] = Math.random() * 0.4 + i * 0.015;
      this.target[r][i] = t[i];
      this.colors[r][i] = color;
    }
  }

  update(dt: number) {
    this.acc += dt;
    if (this.acc < 1 / 30) return;
    const step = this.acc;
    this.acc = 0;
    let changed = false;
    for (let r = 0; r < this.rows; r++)
      for (let i = 0; i < this.cols; i++) {
        if (this.cur[r][i] === this.target[r][i]) continue;
        if (this.delay[r][i] > 0) {
          this.delay[r][i] -= step;
          continue;
        }
        const k = FLAP_CHARS.indexOf(this.cur[r][i]);
        this.cur[r][i] = FLAP_CHARS[(k + 1) % FLAP_CHARS.length];
        changed = true;
      }
    if (changed || this.dirty) this.draw();
  }

  private draw() {
    const { ctx, cw, ch } = this;
    ctx.fillStyle = "#0b0b0d";
    ctx.fillRect(0, 0, this.c.width, this.c.height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${ch * 0.72}px "Oswald", "Barlow Condensed", sans-serif`;
    for (let r = 0; r < this.rows; r++)
      for (let i = 0; i < this.cols; i++) {
        const x = i * cw, y = r * ch;
        ctx.fillStyle = "#1b1c20";
        ctx.fillRect(x + 2, y + 3, cw - 4, ch - 6);
        ctx.fillStyle = "#24252b";
        ctx.fillRect(x + 2, y + 3, cw - 4, (ch - 6) / 2);
        const flipping = this.cur[r][i] !== this.target[r][i];
        ctx.fillStyle = flipping ? "#9aa0ad" : this.colors[r][i];
        ctx.fillText(this.cur[r][i], x + cw / 2, y + ch / 2 + 2);
        ctx.fillStyle = "#000";
        ctx.fillRect(x + 2, y + ch / 2 - 1, cw - 4, 2);
      }
    this.tex.needsUpdate = true;
    this.dirty = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Small LED "smart shelf" panel: a few lines of text + a progress bar. Static; redraw on demand.

export function ledPanel(lines: { text: string; color?: string; size?: number }[], opts: { width: number; height: number; bar?: { value: number; color: string }; accent?: string }) {
  const W = 512, H = Math.round((512 * opts.height) / opts.width);
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = "#050608";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = opts.accent ?? "#333";
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, W - 4, H - 4);
  let y = H * 0.12;
  for (const l of lines) {
    const size = (l.size ?? 0.22) * H;
    ctx.font = `${size}px "Silkscreen", "Press Start 2P", monospace`;
    ctx.fillStyle = l.color ?? "#e8e8e8";
    ctx.shadowColor = l.color ?? "#e8e8e8";
    ctx.shadowBlur = 8;
    ctx.textBaseline = "top";
    ctx.fillText(l.text, W * 0.05, y, W * 0.9);
    y += size * 1.25;
  }
  ctx.shadowBlur = 0;
  if (opts.bar) {
    const bx = W * 0.05, bw = W * 0.9, bh = H * 0.12, by = H - bh - H * 0.1;
    const segs = 20;
    for (let i = 0; i < segs; i++) {
      const on = i / segs < opts.bar.value;
      ctx.fillStyle = on ? opts.bar.color : "#1a1c22";
      ctx.fillRect(bx + (i * bw) / segs + 1, by, bw / segs - 3, bh);
    }
  }
  const tex = canvasTexture(c);
  const m = new THREE.MeshBasicNodeMaterial();
  const s = texture(tex);
  m.colorNode = vec3(0);
  m.emissiveNode = s.rgb.mul(1.6);
  return new THREE.Mesh(new THREE.PlaneGeometry(opts.width, opts.height), m);
}
