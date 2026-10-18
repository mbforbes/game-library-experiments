// A tiny always-there FPS meter (top left): frames per second plus a strip chart of recent frame
// times (green = on time for 60 fps, amber = a dropped frame, red = a stall). Drawing is a few
// dozen canvas rects a few times a second, so it costs next to nothing.

const LS = "the-backlog-fps";

export class FpsMeter {
  readonly el = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private hist: number[] = [];
  private last = 0;
  private w: number;
  private h: number;
  private dpr = Math.min(2, window.devicePixelRatio || 1);
  /** small label under the number (e.g. the current quality step) */
  note = "";
  private _on: boolean;
  private compact: boolean;
  /** the frame time the cadence aims for (colours are relative to it) */
  private target = 1000 / 60;

  constructor(compact: boolean) {
    this.compact = compact;
    this.w = compact ? 92 : 120;
    this.h = compact ? 34 : 42;
    this.el.className = "fps";
    this.el.width = this.w * this.dpr;
    this.el.height = this.h * this.dpr;
    this.el.style.width = `${this.w}px`;
    this.el.style.height = `${this.h}px`;
    this.ctx = this.el.getContext("2d")!;
    let on = true;
    try {
      on = localStorage.getItem(LS) !== "off";
    } catch {}
    this._on = on;
    this.el.style.display = on ? "block" : "none";
  }

  get on() {
    return this._on;
  }

  set on(v: boolean) {
    this._on = v;
    this.el.style.display = v ? "block" : "none";
    try {
      localStorage.setItem(LS, v ? "on" : "off");
    } catch {}
  }

  setTarget(ms: number) {
    this.target = ms;
  }

  /** dt in ms of one rendered frame */
  push(dt: number) {
    this.hist.push(dt);
    if (this.hist.length > 90) this.hist.shift();
    const now = performance.now();
    if (!this._on || now - this.last < 200) return;
    this.last = now;
    this.draw();
  }

  private draw() {
    const c = this.ctx, d = this.dpr, W = this.w * d, H = this.h * d;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(8,9,14,0.72)";
    c.beginPath();
    c.roundRect(0, 0, W, H, 7 * d);
    c.fill();
    const recent = this.hist.slice(-30);
    const avg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
    const fps = avg > 0 ? Math.round(1000 / avg) : 0;
    const aim = 1000 / this.target;
    c.fillStyle = fps >= aim * 0.92 ? "#7ee2a8" : fps >= aim * 0.7 ? "#ffc861" : "#ff6b6b";
    c.font = `600 ${13 * d}px ui-monospace, Menlo, monospace`;
    c.textBaseline = "top";
    c.fillText(`${fps} fps`, 6 * d, 5 * d);
    if (this.note && !this.compact) {
      c.fillStyle = "#8b93a3";
      c.font = `${9 * d}px ui-monospace, Menlo, monospace`;
      c.textAlign = "right";
      c.fillText(this.note, W - 5 * d, 7 * d);
      c.textAlign = "left";
    }
    // strip chart: each bar a frame, height = frame time (33 ms = full height); green = on time
    // for the cadence, amber = missed a refresh, red = a stall
    const top = 22 * d, ch = H - top - 4 * d;
    const n = this.hist.length;
    const bw = (W - 10 * d) / 90;
    for (let i = 0; i < n; i++) {
      const v = this.hist[i];
      const hgt = Math.min(ch, (v / 33.3) * ch);
      c.fillStyle = v <= this.target * 1.15 ? "#4fbf86" : v <= Math.max(34, this.target * 2.1) ? "#e0a93a" : "#e05252";
      c.fillRect(5 * d + (90 - n + i) * bw, top + ch - hgt, Math.max(1, bw - 0.5 * d), hgt);
    }
    c.fillStyle = "rgba(255,255,255,0.18)";
    c.fillRect(5 * d, top + ch / 2, W - 10 * d, d * 0.6);
  }
}
