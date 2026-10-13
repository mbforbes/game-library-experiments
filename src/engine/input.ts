// Unified pointer / touch / wheel / keyboard input. Emits high-level gestures:
// pan, pinch-zoom, scroll, tap, hover, key. Consumers decide what they mean.

export interface InputHandlers {
  pan?(dx: number, dy: number, dt: number): void;
  panEnd?(): void;
  zoom?(factor: number): void;
  scroll?(dx: number, dy: number): void;
  tap?(x: number, y: number, e: PointerEvent): void;
  hover?(x: number, y: number): void;
  key?(e: KeyboardEvent): void;
}

export class Input {
  handlers: InputHandlers = {};
  private pointers = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  private lastMove = performance.now();
  private pinchDist = 0;
  private moved = false;
  /** Set while the pointer is over UI chrome, so the canvas ignores it */
  enabled = true;

  constructor(private el: HTMLElement) {
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", this.down);
    window.addEventListener("pointermove", this.move);
    window.addEventListener("pointerup", this.up);
    window.addEventListener("pointercancel", this.up);
    el.addEventListener("wheel", this.wheel, { passive: false });
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      this.handlers.key?.(e);
    });
    // Safari pinch gestures (prevent page zoom)
    el.addEventListener("gesturestart", (e) => e.preventDefault());
  }

  private down = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.el.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
    if (this.pointers.size === 1) this.moved = false;
    if (this.pointers.size === 2) this.pinchDist = this.spread();
    this.lastMove = performance.now();
  };

  private move = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === "mouse" && e.target === this.el) this.handlers.hover?.(e.clientX, e.clientY);
      return;
    }
    const now = performance.now();
    const dt = Math.max(1, now - this.lastMove) / 1000;
    this.lastMove = now;
    if (this.pointers.size === 1) {
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (Math.hypot(p.x - p.x0, p.y - p.y0) > 6) this.moved = true;
      if (this.moved) this.handlers.pan?.(dx, dy, dt);
    } else if (this.pointers.size === 2) {
      const before = this.centroid();
      p.x = e.clientX;
      p.y = e.clientY;
      const after = this.centroid();
      const d = this.spread();
      if (this.pinchDist > 0 && d > 0) this.handlers.zoom?.(this.pinchDist / d);
      this.pinchDist = d;
      this.handlers.pan?.(after.x - before.x, after.y - before.y, dt);
      this.moved = true;
    }
  };

  private up = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      if (!this.moved && performance.now() - p.t0 < 600) this.handlers.tap?.(e.clientX, e.clientY, e);
      else this.handlers.panEnd?.();
    }
    if (this.pointers.size === 1) {
      // continue panning with the remaining finger without a jump
      const [rest] = this.pointers.values();
      rest.x0 = rest.x;
      rest.y0 = rest.y;
    }
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.enabled) return;
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey) {
      // trackpad pinch
      this.handlers.zoom?.(Math.exp(e.deltaY * scale * 0.01));
    } else {
      this.handlers.scroll?.(e.deltaX * scale, e.deltaY * scale);
    }
  };

  private spread() {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
  private centroid() {
    const ps = [...this.pointers.values()];
    return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
  }
}
