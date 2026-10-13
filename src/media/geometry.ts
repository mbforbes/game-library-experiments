// Tiny procedural geometry builder: quads, chamfered boxes and extruded profiles, each
// vertex tagged with a `part` id so one shader can paint shell / cover / spine / glow regions.

import * as THREE from "three/webgpu";

export const PART = { shell: 0, cover: 1, spine: 2, back: 3, glow: 5, dark: 6, metal: 7 } as const;

type V3 = [number, number, number];

export class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  part: number[] = [];

  /** Quad from 4 corners (counter-clockwise seen from the front), uv 0..1 over the quad. */
  quad(a: V3, b: V3, c: V3, d: V3, part: number, uv: [number, number, number, number] = [0, 0, 1, 1]) {
    const n = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).cross(new THREE.Vector3(d[0] - a[0], d[1] - a[1], d[2] - a[2])).normalize();
    const [u0, v0, u1, v1] = uv;
    const verts: [V3, number, number][] = [
      [a, u0, v0],
      [b, u1, v0],
      [c, u1, v1],
      [a, u0, v0],
      [c, u1, v1],
      [d, u0, v1],
    ];
    for (const [p, u, v] of verts) {
      this.pos.push(...p);
      this.nrm.push(n.x, n.y, n.z);
      this.uv.push(u, v);
      this.part.push(part);
    }
  }

  tri(a: V3, b: V3, c: V3, part: number) {
    const n = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).cross(new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2])).normalize();
    for (const p of [a, b, c]) {
      this.pos.push(...p);
      this.nrm.push(n.x, n.y, n.z);
      this.uv.push(0, 0);
      this.part.push(part);
    }
  }

  /**
   * Axis-aligned box centred at (cx,cy,cz) with size (w,h,d) and a chamfer of c on every edge.
   * faces: part per face (+x,-x,+y,-y,+z,-z); null = skip. Chamfer strips + corners use `edgePart`.
   */
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number, faces: (number | null)[], c = 0, edgePart: number = PART.shell) {
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    const [px, nx, py, ny, pz, nz] = faces;
    // main faces, inset by the chamfer
    if (pz !== null) this.quad([x0 + c, y0 + c, z1], [x1 - c, y0 + c, z1], [x1 - c, y1 - c, z1], [x0 + c, y1 - c, z1], pz);
    if (nz !== null) this.quad([x1 - c, y0 + c, z0], [x0 + c, y0 + c, z0], [x0 + c, y1 - c, z0], [x1 - c, y1 - c, z0], nz);
    if (px !== null) this.quad([x1, y0 + c, z1 - c], [x1, y0 + c, z0 + c], [x1, y1 - c, z0 + c], [x1, y1 - c, z1 - c], px);
    if (nx !== null) this.quad([x0, y0 + c, z0 + c], [x0, y0 + c, z1 - c], [x0, y1 - c, z1 - c], [x0, y1 - c, z0 + c], nx);
    if (py !== null) this.quad([x0 + c, y1, z1 - c], [x1 - c, y1, z1 - c], [x1 - c, y1, z0 + c], [x0 + c, y1, z0 + c], py);
    if (ny !== null) this.quad([x0 + c, y0, z0 + c], [x1 - c, y0, z0 + c], [x1 - c, y0, z1 - c], [x0 + c, y0, z1 - c], ny);
    if (c <= 0) return;
    const e = edgePart;
    // 12 chamfer strips
    // edges parallel to X
    this.quad([x0 + c, y1 - c, z1], [x1 - c, y1 - c, z1], [x1 - c, y1, z1 - c], [x0 + c, y1, z1 - c], e); // top-front
    this.quad([x1 - c, y1 - c, z0], [x0 + c, y1 - c, z0], [x0 + c, y1, z0 + c], [x1 - c, y1, z0 + c], e); // top-back
    this.quad([x0 + c, y0, z1 - c], [x1 - c, y0, z1 - c], [x1 - c, y0 + c, z1], [x0 + c, y0 + c, z1], e); // bottom-front
    this.quad([x1 - c, y0, z0 + c], [x0 + c, y0, z0 + c], [x0 + c, y0 + c, z0], [x1 - c, y0 + c, z0], e); // bottom-back
    // edges parallel to Y
    this.quad([x1 - c, y0 + c, z1], [x1, y0 + c, z1 - c], [x1, y1 - c, z1 - c], [x1 - c, y1 - c, z1], e); // front-right
    this.quad([x0, y0 + c, z1 - c], [x0 + c, y0 + c, z1], [x0 + c, y1 - c, z1], [x0, y1 - c, z1 - c], e); // front-left
    this.quad([x1, y0 + c, z0 + c], [x1 - c, y0 + c, z0], [x1 - c, y1 - c, z0], [x1, y1 - c, z0 + c], e); // back-right
    this.quad([x0 + c, y0 + c, z0], [x0, y0 + c, z0 + c], [x0, y1 - c, z0 + c], [x0 + c, y1 - c, z0], e); // back-left
    // edges parallel to Z
    this.quad([x1, y1 - c, z1 - c], [x1, y1 - c, z0 + c], [x1 - c, y1, z0 + c], [x1 - c, y1, z1 - c], e); // top-right
    this.quad([x0 + c, y1, z1 - c], [x0 + c, y1, z0 + c], [x0, y1 - c, z0 + c], [x0, y1 - c, z1 - c], e); // top-left
    this.quad([x1 - c, y0, z1 - c], [x1 - c, y0, z0 + c], [x1, y0 + c, z0 + c], [x1, y0 + c, z1 - c], e); // bottom-right
    this.quad([x0, y0 + c, z1 - c], [x0, y0 + c, z0 + c], [x0 + c, y0, z0 + c], [x0 + c, y0, z1 - c], e); // bottom-left
    // 8 corner triangles
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const X = sx > 0 ? x1 : x0, Y = sy > 0 ? y1 : y0, Z = sz > 0 ? z1 : z0;
      const a: V3 = [X - sx * c, Y, Z - sz * c];
      const b: V3 = [X, Y - sy * c, Z - sz * c];
      const d: V3 = [X - sx * c, Y - sy * c, Z];
      // winding so the normal points outward
      if (sx * sy * sz > 0) this.tri(a, d, b, e);
      else this.tri(a, b, d, e);
    }
  }

  /**
   * Extrude a 2D outline (in the XY plane, counter-clockwise) between z0 and z1.
   * Front cap (z1) and back cap (z0) use the given parts; sides use `sidePart`.
   */
  extrude(outline: [number, number][], z0: number, z1: number, front: number, back: number, sidePart: number = PART.shell) {
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    const tris = THREE.ShapeUtils.triangulateShape(shape.getPoints(), []);
    const pts = shape.getPoints();
    for (const [a, b, c] of tris) {
      const A = pts[a], B = pts[b], C = pts[c];
      this.tri([A.x, A.y, z1], [B.x, B.y, z1], [C.x, C.y, z1], front);
      this.tri([A.x, A.y, z0], [C.x, C.y, z0], [B.x, B.y, z0], back);
    }
    for (let i = 0; i < outline.length; i++) {
      const [ax, ay] = outline[i], [bx, by] = outline[(i + 1) % outline.length];
      this.quad([ax, ay, z1], [ax, ay, z0], [bx, by, z0], [bx, by, z1], sidePart);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("part", new THREE.Float32BufferAttribute(this.part, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** Rounded-rectangle outline helper (counter-clockwise), with per-corner radii [bl, br, tr, tl]. */
export function roundedRect(x0: number, y0: number, x1: number, y1: number, r: [number, number, number, number], seg = 4): [number, number][] {
  const out: [number, number][] = [];
  const [bl, br, tr, tl] = r;
  const arc = (cx: number, cy: number, rad: number, startDeg: number) => {
    if (rad <= 0) return;
    for (let i = 0; i <= seg; i++) {
      const a = THREE.MathUtils.degToRad(startDeg + (90 * i) / seg);
      out.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
    }
  };
  if (bl > 0) arc(x0 + bl, y0 + bl, bl, 180);
  else out.push([x0, y0]);
  if (br > 0) arc(x1 - br, y0 + br, br, 270);
  else out.push([x1, y0]);
  if (tr > 0) arc(x1 - tr, y1 - tr, tr, 0);
  else out.push([x1, y1]);
  if (tl > 0) arc(x0 + tl, y1 - tl, tl, 90);
  else out.push([x0, y1]);
  return out;
}
