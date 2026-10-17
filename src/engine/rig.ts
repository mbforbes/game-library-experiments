// Camera rig: browses a Rail with (s, h, d) state, smooth damping and inertia.
// Also supports one-off "free" poses (intros, stations off the rail) that hand back to the rail
// as soon as the user pans.

import * as THREE from "three/webgpu";
import type { Rail } from "./rail";

export interface RailState {
  s: number;
  h: number;
  d: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpP = new THREE.Vector3(), tmpN = new THREE.Vector3(), tmpV = new THREE.Vector3();

export class CameraRig {
  rail: Rail | null = null;
  state: RailState = { s: 0, h: 1.4, d: 2 };
  goal: RailState = { s: 0, h: 1.4, d: 2 };
  vel = { s: 0, h: 0 };
  dragging = false;
  /** Small parallax offsets (radians) driven by hover / idle drift */
  look = { yaw: 0, pitch: 0, yawGoal: 0, pitchGoal: 0 };
  /** Free pose (overrides the rail while weight > 0) */
  private free = { pos: new THREE.Vector3(), target: new THREE.Vector3(), weight: 0, goalWeight: 0 };
  private flight: { from: RailState; to: RailState; t: number; dur: number } | null = null;
  /** Current output pose */
  readonly pos = new THREE.Vector3();
  readonly target = new THREE.Vector3();
  /** Idle seconds (for attract-mode drift) */
  idle = 0;
  /**
   * Free-standing props the camera keeps out of (capsules a→b of radius r; a sphere when a = b):
   * when one comes between the camera and what it's looking at, the camera moves in front of it.
   */
  obstacles: { a: THREE.Vector3; b: THREE.Vector3; r: number }[] = [];
  /** smoothed share of the target→camera distance that's clear of obstacles */
  private clear = 1;
  onMove?: () => void;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  setRail(rail: Rail, at?: Partial<RailState>) {
    this.rail = rail;
    const o = rail.opts;
    this.goal = { s: at?.s ?? 0, h: at?.h ?? o.h0, d: at?.d ?? o.d0 };
    this.state = { ...this.goal };
    this.vel = { s: 0, h: 0 };
    this.flight = null;
  }

  /** world units per CSS pixel at the current distance */
  private wpp(): number {
    const h = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    return (h * Math.max(0.4, this.state.d)) / Math.max(320, window.innerHeight);
  }

  /** +1 when increasing s moves the view to screen-right */
  private screenSign(): number {
    if (!this.rail) return 1;
    const { n } = this.rail.at(this.state.s, tmpP, tmpN);
    const { p: p2 } = this.rail.at(this.state.s + 0.1, tmpV, new THREE.Vector3());
    const t = p2.sub(tmpP);
    const right = n.clone().negate().cross(UP);
    return t.dot(right) >= 0 ? 1 : -1;
  }

  pan(dxPx: number, dyPx: number, dt = 1 / 60) {
    if (!this.rail) return;
    this.release(false);
    const k = this.wpp();
    const ds = -dxPx * k * this.screenSign();
    const dh = dyPx * k;
    this.goal.s += ds;
    this.goal.h += dh;
    this.clamp();
    // velocity estimate for inertia (smoothed)
    const a = 0.35;
    this.vel.s = this.vel.s * (1 - a) + (ds / Math.max(dt, 1 / 240)) * a;
    this.vel.h = this.vel.h * (1 - a) + (dh / Math.max(dt, 1 / 240)) * a;
    this.dragging = true;
    this.poke();
  }

  endPan() {
    this.dragging = false;
  }

  /** Scroll along the rail (wheel / keys); positive = towards screen-right */
  scroll(px: number) {
    if (!this.rail) return;
    this.release(false);
    this.goal.s += px * this.wpp() * this.screenSign();
    this.clamp();
    this.poke();
  }

  zoom(factor: number) {
    if (!this.rail) return;
    this.release(false);
    this.goal.d *= factor;
    this.clamp();
    this.poke();
  }

  goTo(to: Partial<RailState>, dur = 1.2) {
    if (!this.rail) return;
    const target = { s: to.s ?? this.goal.s, h: to.h ?? this.goal.h, d: to.d ?? this.goal.d };
    // travel the short way round on closed rails
    target.s = this.state.s + this.rail.delta(this.state.s, this.rail.wrap(target.s));
    this.flight = { from: { ...this.state }, to: target, t: 0, dur };
    this.vel = { s: 0, h: 0 };
    this.free.goalWeight = 0;
    this.poke();
  }

  /** Fly to an arbitrary pose (off-rail); `snap` puts the camera there at once. Panning returns to the rail. */
  goFree(pos: THREE.Vector3, target: THREE.Vector3, snap = false) {
    this.free.pos.copy(pos);
    this.free.target.copy(target);
    this.free.goalWeight = 1;
    if (snap) this.free.weight = 1;
    this.flight = null;
    this.poke();
  }

  /** The camera is at rest: no flight, drag, glide or blend still under way. */
  get settled() {
    if (this.flight || this.dragging || Math.abs(this.vel.s) > 0.01 || Math.abs(this.vel.h) > 0.01) return false;
    if (Math.abs(this.free.weight - this.free.goalWeight) > 0.01) return false;
    const r = this.rail;
    const ds = r ? Math.abs(r.delta(this.state.s, this.goal.s)) : 0;
    return ds < 0.005 && Math.abs(this.goal.h - this.state.h) < 0.005 && Math.abs(this.goal.d - this.state.d) < 0.005;
  }

  get isFree() {
    return this.free.goalWeight > 0;
  }

  /** Snap the rail state to where a free pose is looking (so leaving a free pose doesn't jump). */
  private release(snap: boolean) {
    if (this.free.goalWeight > 0) {
      this.free.goalWeight = 0;
      if (snap && this.rail) {
        this.goal.s = this.rail.project(this.free.target);
      }
    }
    this.flight = null;
  }

  private poke() {
    this.idle = 0;
    this.onMove?.();
  }

  private clamp() {
    if (!this.rail) return;
    const o = this.rail.opts;
    if (!o.closed) this.goal.s = Math.max(0, Math.min(this.rail.length, this.goal.s));
    this.goal.h = Math.max(o.h[0], Math.min(o.h[1], this.goal.h));
    this.goal.d = Math.max(o.d[0], Math.min(o.d[1], this.goal.d));
  }

  update(dt: number) {
    this.idle += dt;
    if (!this.rail) return;
    // flight (eased)
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.t < 0.5 ? 4 * f.t * f.t * f.t : 1 - Math.pow(-2 * f.t + 2, 3) / 2;
      this.goal.s = f.from.s + (f.to.s - f.from.s) * e;
      this.goal.h = f.from.h + (f.to.h - f.from.h) * e;
      this.goal.d = f.from.d + (f.to.d - f.from.d) * e;
      if (f.t >= 1) this.flight = null;
    } else if (!this.dragging) {
      // inertia
      const decay = Math.exp(-dt * 4.5);
      if (Math.abs(this.vel.s) > 1e-3 || Math.abs(this.vel.h) > 1e-3) {
        this.goal.s += this.vel.s * dt;
        this.goal.h += this.vel.h * dt;
        this.vel.s *= decay;
        this.vel.h *= decay;
        this.clamp();
      }
    }
    // damp state towards goal
    const k = 1 - Math.exp(-dt * (this.flight ? 30 : 12));
    this.state.s += this.rail.delta(this.state.s, this.goal.s) * k;
    if (this.rail.opts.closed) {
      this.state.s = this.rail.wrap(this.state.s);
      this.goal.s = this.state.s + this.rail.delta(this.state.s, this.goal.s);
    }
    this.state.h += (this.goal.h - this.state.h) * k;
    this.state.d += (this.goal.d - this.state.d) * k;

    // rail pose
    const { p, n } = this.rail.at(this.state.s, tmpP, tmpN);
    const o = this.rail.opts;
    const lift = o.lift * (this.state.d / o.d0);
    const railPos = new THREE.Vector3().copy(p).addScaledVector(n, this.state.d).addScaledVector(UP, this.state.h + lift);
    const railTarget = new THREE.Vector3().copy(p).addScaledVector(UP, this.state.h);

    // free pose blend
    const fk = 1 - Math.exp(-dt * 3);
    this.free.weight += (this.free.goalWeight - this.free.weight) * fk;
    const w = this.free.weight;
    const ease = w * w * (3 - 2 * w);
    this.pos.copy(railPos).lerp(this.free.pos, ease);
    this.target.copy(railTarget).lerp(this.free.target, ease);
    if (this.obstacles.length) {
      // pull in quickly when something's in the way, ease back out slowly
      const want = this.clearShare();
      this.clear += (want - this.clear) * (1 - Math.exp(-dt * (want < this.clear ? 16 : 3)));
      if (this.clear < 0.999) this.pos.lerpVectors(this.target, this.pos, this.clear);
    }

    // parallax look offsets + a slow, barely-there breathing sway
    const lk = 1 - Math.exp(-dt * 4);
    const now = performance.now() / 1000;
    const sway = this.dragging || this.flight ? 0 : 1;
    this.look.yaw += (this.look.yawGoal + Math.sin(now * 0.37) * 0.0045 * sway - this.look.yaw) * lk;
    this.look.pitch += (this.look.pitchGoal + Math.sin(now * 0.29 + 1.3) * 0.003 * sway - this.look.pitch) * lk;
    const fwd = tmpV.copy(this.target).sub(this.pos);
    const dist = fwd.length();
    fwd.normalize();
    const right = fwd.clone().cross(UP).normalize();
    const lookAt = this.target.clone().addScaledVector(right, Math.tan(this.look.yaw) * dist).addScaledVector(UP, Math.tan(this.look.pitch) * dist);

    this.camera.position.copy(this.pos);
    this.camera.lookAt(lookAt);
  }

  /** How much of the way from the target back to the camera is clear of obstacles (0..1). */
  private clearShare() {
    const len = this.pos.distanceTo(this.target);
    if (len < 1e-3) return 1;
    // (looking at a prop itself from close up: that one doesn't count)
    const obs = this.obstacles.filter((o) => distToSegment(this.target, o.a, o.b) > o.r);
    const hit = (k: number) => obs.some((o) => distToSegment(tmpP.lerpVectors(this.target, this.pos, k), o.a, o.b) <= o.r);
    const N = 40;
    for (let i = 1; i <= N; i++) {
      if (!hit(i / N)) continue;
      // the first blocked step: narrow down where the way in starts
      let lo = (i - 1) / N, hi = i / N;
      for (let j = 0; j < 6; j++) {
        const mid = (lo + hi) / 2;
        if (hit(mid)) hi = mid;
        else lo = mid;
      }
      return Math.max(Math.min(1, 0.12 / len), lo - 0.12 / len);
    }
    return 1;
  }

  /** Rail state that frames a world point (e.g. a game on a shelf) at distance d. */
  frame(world: THREE.Vector3, d?: number): RailState | null {
    if (!this.rail) return null;
    const s = this.rail.project(world);
    return { s, h: world.y, d: d ?? this.rail.opts.d[0] + 0.25 };
  }
}

const segTmp = new THREE.Vector3();
function distToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const ab = segTmp.subVectors(b, a);
  const l2 = ab.lengthSq();
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / l2)) : 0;
  const x = a.x + ab.x * t - p.x, y = a.y + ab.y * t - p.y, z = a.z + ab.z * t - p.z;
  return Math.sqrt(x * x + y * y + z * z);
}
