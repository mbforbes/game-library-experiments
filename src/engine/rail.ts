// A Rail is the path the camera browses along: a polyline over a "surface" (a wall of shelves,
// a cylinder of books, ...) with an outward normal at each point. The camera state is
// (s = distance along rail, h = height, d = distance from the surface), which maps to a pose.
// This one model gives the same feel on phone (drag to pan, pinch to zoom) and desktop
// (drag / wheel / arrows), and every level just supplies its own rail(s).

import * as THREE from "three/webgpu";

export interface RailOptions {
  closed?: boolean;
  /** height range the camera may pan over (world y) */
  h: [number, number];
  /** distance-from-surface range */
  d: [number, number];
  /** default framing */
  h0?: number;
  d0?: number;
  /** extra height of the camera above the look target (looks slightly down when > 0) */
  lift?: number;
  /** smoothing radius for corners (m) */
  round?: number;
}

export class Rail {
  readonly points: THREE.Vector3[] = [];
  readonly normals: THREE.Vector3[] = [];
  readonly cum: number[] = [];
  readonly length: number;
  readonly opts: Required<RailOptions>;

  /**
   * @param pts surface points (y is the base height; usually 0)
   * @param normals unit normals pointing from the surface towards the viewer (horizontal)
   */
  constructor(pts: THREE.Vector3[], normals: THREE.Vector3[], opts: RailOptions) {
    this.opts = { closed: false, h0: (opts.h[0] + opts.h[1]) / 2, d0: (opts.d[0] + opts.d[1]) / 2, lift: 0, round: 0, ...opts };
    // Resample densely so lookups are cheap and corners can be smoothed
    const P = [...pts], N = [...normals];
    if (this.opts.closed && P[P.length - 1].distanceTo(P[0]) > 1e-6) {
      P.push(pts[0].clone());
      N.push(normals[0].clone());
    }
    const step = 0.05;
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1];
      const len = a.distanceTo(b);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        this.points.push(a.clone().lerp(b, t));
        this.normals.push(N[i].clone().lerp(N[i + 1], t).normalize());
      }
    }
    this.points.push(P[P.length - 1].clone());
    this.normals.push(N[N.length - 1].clone());
    // Smooth normals around corners (moving average over `round` metres)
    if (this.opts.round > 0) {
      const k = Math.round(this.opts.round / step);
      const src = this.normals.map((v) => v.clone());
      const M = src.length;
      for (let i = 0; i < M; i++) {
        const acc = new THREE.Vector3();
        for (let j = -k; j <= k; j++) {
          let idx = i + j;
          if (this.opts.closed) idx = (idx + M) % M;
          else idx = Math.max(0, Math.min(M - 1, idx));
          acc.add(src[idx]);
        }
        this.normals[i].copy(acc.normalize());
      }
    }
    let total = 0;
    this.cum.push(0);
    for (let i = 1; i < this.points.length; i++) {
      total += this.points[i].distanceTo(this.points[i - 1]);
      this.cum.push(total);
    }
    this.length = total;
  }

  wrap(s: number): number {
    if (!this.opts.closed) return Math.max(0, Math.min(this.length, s));
    return ((s % this.length) + this.length) % this.length;
  }

  /** Surface point + normal at arc length s */
  at(s: number, outP = new THREE.Vector3(), outN = new THREE.Vector3()) {
    s = this.wrap(s);
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const span = this.cum[hi] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / span;
    outP.copy(this.points[lo]).lerp(this.points[hi], t);
    outN.copy(this.normals[lo]).lerp(this.normals[hi], t).normalize();
    return { p: outP, n: outN };
  }

  /** Closest arc length to a world point (projected onto the rail). */
  project(world: THREE.Vector3): number {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const dx = this.points[i].x - world.x, dz = this.points[i].z - world.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return this.cum[best];
  }

  /** Signed shortest delta from a to b along the rail (accounts for wrap on closed rails). */
  delta(a: number, b: number): number {
    let d = b - a;
    if (this.opts.closed) {
      if (d > this.length / 2) d -= this.length;
      if (d < -this.length / 2) d += this.length;
    }
    return d;
  }
}

/** Helper: rail along a sequence of wall segments given as [x,z] corner points with the viewer on the left side. */
export function wallRail(corners: [number, number][], opts: RailOptions): Rail {
  // Each segment keeps its own normal; corners get duplicated points so the normal turns
  // there (and `round` smooths the turn).
  const pts: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  const segs = opts.closed ? corners.length : corners.length - 1;
  for (let i = 0; i < segs; i++) {
    const [ax, az] = corners[i];
    const [bx, bz] = corners[(i + 1) % corners.length];
    const dir = new THREE.Vector3(bx - ax, 0, bz - az).normalize();
    const nrm = new THREE.Vector3(dir.z, 0, -dir.x); // viewer is on the left of travel
    pts.push(new THREE.Vector3(ax, 0, az), new THREE.Vector3(bx, 0, bz));
    normals.push(nrm.clone(), nrm.clone());
  }
  return new Rail(pts, normals, opts);
}
