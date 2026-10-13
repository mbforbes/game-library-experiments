// Furniture: bookcases with LED-lit shelves, the cartridge display wall, a couch, a rug,
// a coffee table. Simple merged geometry so each piece is one or two draw calls.

import * as THREE from "three/webgpu";
import { boxes, neonMaterial } from "./common";
import { bookcaseShelves, type Shelf } from "../shelving";

const UP = new THREE.Vector3(0, 1, 0);

export interface Bookcase {
  group: THREE.Group;
  shelves: Shelf[];
  top: number;
}

/**
 * A bookcase standing against a wall. `center` is the floor point at the middle of its front face.
 * rows: clear heights of each row, bottom to top.
 */
export function bookcase(o: { center: THREE.Vector3; normal: THREE.Vector3; width: number; rows: number[]; depth?: number; base?: number; color?: number; led?: string }): Bookcase {
  const depth = o.depth ?? 0.3;
  const base = o.base ?? 0.12;
  const th = 0.022;
  const side = 0.025;
  const g = new THREE.Group();
  // build in local space: front faces +Z, x across, origin = floor centre of the front face
  const W = o.width;
  const H = base + o.rows.reduce((a, b) => a + b + th, 0) + 0.03;
  const parts: [number, number, number, number, number, number][] = [
    [-W / 2 + side / 2, H / 2, -depth / 2, side, H, depth],
    [W / 2 - side / 2, H / 2, -depth / 2, side, H, depth],
    [0, H - 0.015, -depth / 2, W, 0.03, depth],
    [0, base / 2, -depth / 2 + 0.01, W - side * 2, base, depth - 0.02],
    [0, H / 2, -depth + 0.006, W, H, 0.012],
  ];
  let y = base;
  const ledYs: number[] = [];
  for (const h of o.rows) {
    y += h;
    if (y < H - 0.04) {
      parts.push([0, y + th / 2, -depth / 2, W - side * 2, th, depth]);
      ledYs.push(y);
    }
    y += th;
  }
  const mat = new THREE.MeshStandardNodeMaterial({ color: o.color ?? 0x15131c, roughness: 0.42, metalness: 0.15 });
  const body = new THREE.Mesh(boxes(parts), mat);
  g.add(body);
  // LED strips under each shelf's front edge (light the row below)
  if (o.led) {
    const strips: [number, number, number, number, number, number][] = ledYs.map((ly) => [0, ly - 0.004, -0.02, W - side * 2 - 0.01, 0.006, 0.008]);
    strips.push([0, H - 0.035, -0.02, W - side * 2 - 0.01, 0.006, 0.008]);
    const led = new THREE.Mesh(boxes(strips), neonMaterial(o.led, 2.4));
    g.add(led);
  }
  // orient + place
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), o.normal.clone().normalize());
  g.quaternion.copy(q);
  g.position.copy(o.center);
  // shelf surfaces: front edge flush with the bookcase's front face
  const shelves = bookcaseShelves({ center: o.center, normal: o.normal, width: W, rows: o.rows, base: base, depth, thickness: th, side });
  return { group: g, shelves, top: H };
}

export function couch(color = 0x3a1f4a) {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness: 0.85 });
  g.add(
    new THREE.Mesh(
      boxes([
        [0, 0.22, 0, 2.1, 0.24, 0.9],
        [0, 0.55, -0.36, 2.1, 0.55, 0.2],
        [-1.0, 0.38, 0, 0.18, 0.45, 0.9],
        [1.0, 0.38, 0, 0.18, 0.45, 0.9],
        [-0.48, 0.38, 0.03, 0.9, 0.1, 0.78],
        [0.48, 0.38, 0.03, 0.9, 0.1, 0.78],
      ]),
      m,
    ),
  );
  const legs = new THREE.Mesh(
    boxes([
      [-0.95, 0.05, -0.38, 0.05, 0.1, 0.05],
      [0.95, 0.05, -0.38, 0.05, 0.1, 0.05],
      [-0.95, 0.05, 0.38, 0.05, 0.1, 0.05],
      [0.95, 0.05, 0.38, 0.05, 0.1, 0.05],
    ]),
    new THREE.MeshStandardNodeMaterial({ color: 0x111111, metalness: 0.5, roughness: 0.3 }),
  );
  g.add(legs);
  return g;
}

export function rug(w: number, d: number) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = Math.round((512 * d) / w);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#1a0d26";
  ctx.fillRect(0, 0, c.width, c.height);
  // retro geometric pattern
  const s = 32;
  for (let y = 0; y < c.height; y += s)
    for (let x = 0; x < c.width; x += s) {
      const k = ((x / s) ^ (y / s)) % 4;
      ctx.fillStyle = ["#2b1240", "#1f0f33", "#3b1650", "#140a20"][k];
      ctx.beginPath();
      ctx.moveTo(x, y + s);
      ctx.lineTo(x + s / 2, y);
      ctx.lineTo(x + s, y + s);
      ctx.fill();
    }
  ctx.strokeStyle = "#ff3d9a";
  ctx.lineWidth = 6;
  ctx.strokeRect(14, 14, c.width - 28, c.height - 28);
  ctx.strokeStyle = "#4fd8ff";
  ctx.lineWidth = 3;
  ctx.strokeRect(26, 26, c.width - 52, c.height - 52);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardNodeMaterial({ map: t, roughness: 0.95 }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.004;
  return m;
}

export function roundTable(radius = 0.5, height = 0.42) {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.04, 48), new THREE.MeshStandardNodeMaterial({ color: 0x0f1016, roughness: 0.15, metalness: 0.3 }));
  top.position.y = height;
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.18, height, 24), new THREE.MeshStandardNodeMaterial({ color: 0x0a0a0e, roughness: 0.4, metalness: 0.6 }));
  leg.position.y = height / 2;
  const trim = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.006, 8, 96), neonMaterial("#ff3d9a", 3));
  trim.rotation.x = Math.PI / 2;
  trim.position.y = height - 0.02;
  g.add(top, leg, trim);
  return g;
}

export { UP };
