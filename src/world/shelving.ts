// Shelf packing: turns an ordered list of games into placements on a set of shelves.
// Supports spine-out runs (cases), face-out displays (carts / featured games), flat stacks,
// and section breaks between platforms. Reused by any level that has shelves.

import * as THREE from "three/webgpu";
import type { Game } from "../../shared/types";
import type { ArtStore } from "../library/art";
import { templateOf, type Placement } from "../media/field";

export interface Shelf {
  /** left end of the shelf surface, at its front edge (world) */
  origin: THREE.Vector3;
  /** unit vector along the shelf (left -> right as seen by the viewer) */
  dir: THREE.Vector3;
  /** unit vector pointing out of the shelf towards the viewer */
  normal: THREE.Vector3;
  width: number;
  depth: number;
  /** clear height above the surface */
  height: number;
}

export type Mode = "spine" | "face" | "stack";

export interface PackOptions {
  /** how each game is displayed */
  mode?: (g: Game, indexInSection: number, section: Game[]) => Mode;
  /** section key (default: platform); a new section inserts sectionGap */
  section?: (g: Game) => string;
  sectionGap?: number;
  /** start each section on a fresh shelf when the current shelf has less than this fraction left */
  newShelfBelow?: number;
  gap?: number;
  /** distance from the shelf front edge to the item's front */
  inset?: number;
  /** face-out lean angle (radians, leaning back) */
  lean?: number;
}

export interface SectionInfo {
  key: string;
  shelf: number;
  start: THREE.Vector3;
  end: THREE.Vector3;
  games: Game[];
}

export interface PackResult {
  placements: Placement[];
  sections: SectionInfo[];
  overflow: Game[];
  /** fraction of shelf length used */
  fill: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Quaternion that turns an item so its spine (-X local) faces `normal`. */
export function spineOut(normal: THREE.Vector3): THREE.Quaternion {
  const x = normal.clone().negate();
  const z = x.clone().cross(UP);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, UP, z));
}

/** Quaternion that turns an item so its front cover (+Z local) faces `normal`, optionally leaning back. */
export function faceOut(normal: THREE.Vector3, lean = 0): THREE.Quaternion {
  const x = UP.clone().cross(normal);
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, UP, normal.clone()));
  if (lean) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -lean));
  return q;
}

/** Item lying flat (cover up), spine facing the viewer. */
export function flat(normal: THREE.Vector3): THREE.Quaternion {
  // start from spine-out, then tip it over so the cover faces up
  const q = spineOut(normal);
  return new THREE.Quaternion().setFromAxisAngle(normal, 0).multiply(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
}

export function packShelves(games: Game[], shelves: Shelf[], art: ArtStore, opts: PackOptions = {}): PackResult {
  const sectionOf = opts.section ?? ((g: Game) => g.platform);
  const modeOf = opts.mode ?? (() => "spine" as Mode);
  const gap = opts.gap ?? 0.0012;
  const sectionGap = opts.sectionGap ?? 0.05;
  const inset = opts.inset ?? 0.012;
  const lean = opts.lean ?? 0.12;
  const newShelfBelow = opts.newShelfBelow ?? 0.15;

  const placements: Placement[] = [];
  const sections: SectionInfo[] = [];
  const overflow: Game[] = [];
  let si = 0;
  let cursor = 0;
  let used = 0;

  // group into sections preserving order
  const groups: { key: string; games: Game[] }[] = [];
  for (const g of games) {
    const k = sectionOf(g);
    if (!groups.length || groups[groups.length - 1].key !== k) groups.push({ key: k, games: [] });
    groups[groups.length - 1].games.push(g);
  }

  const shelfAt = () => shelves[si];
  const advance = () => {
    si++;
    cursor = 0;
  };

  for (const grp of groups) {
    if (si >= shelves.length) {
      overflow.push(...grp.games);
      continue;
    }
    if (cursor > 0) {
      const left = shelfAt().width - cursor;
      if (left < shelfAt().width * newShelfBelow) advance();
      else cursor += sectionGap;
    }
    if (si >= shelves.length) {
      overflow.push(...grp.games);
      continue;
    }
    let sec: SectionInfo = { key: grp.key, shelf: si, start: posOn(shelfAt(), cursor), end: posOn(shelfAt(), cursor), games: [] };
    sections.push(sec);

    // stacks: consecutive "stack" items are collected and laid flat together
    let stack: Game[] = [];
    const flushStack = () => {
      if (!stack.length) return;
      // Lying flat with the spine facing out: the box's height runs along the shelf, its width into it.
      const ts = stack.map((g) => templateOf(g, art));
      const footprint = Math.max(...ts.map((t) => t.size[1])) + gap * 4;
      const sh = shelfAt();
      if (cursor + footprint > sh.width) {
        advance();
        if (si >= shelves.length) {
          overflow.push(...stack);
          stack = [];
          return;
        }
        sec = { key: grp.key, shelf: si, start: posOn(shelfAt(), cursor), end: posOn(shelfAt(), cursor), games: [] };
        sections.push(sec);
      }
      const s = shelfAt();
      let y = 0;
      const q = flatSpineOut(s.normal);
      stack.forEach((g, k) => {
        const [w, h, d] = ts[k].size;
        const jitter = (k % 2 ? 0.004 : -0.003) + (k % 3) * 0.001;
        const center = s.origin
          .clone()
          .addScaledVector(s.dir, cursor + footprint / 2 + jitter)
          .addScaledVector(s.normal, -(inset + w / 2))
          .addScaledVector(UP, y + d / 2);
        // placement origin is the item's bottom-centre: centre minus the rotated (0, h/2, 0)
        const p = center.sub(new THREE.Vector3(0, h / 2, 0).applyQuaternion(q));
        placements.push({ game: g, position: p, quaternion: q });
        sec.games.push(g);
        y += d + 0.0008;
      });
      cursor += footprint + gap;
      used += footprint;
      sec.end = posOn(s, cursor);
      stack = [];
    };

    grp.games.forEach((g, i) => {
      const mode = modeOf(g, i, grp.games);
      if (mode === "stack") {
        stack.push(g);
        return;
      }
      flushStack();
      if (si >= shelves.length) {
        overflow.push(g);
        return;
      }
      const t = templateOf(g, art);
      const [w, h, d] = t.size;
      const along = (mode === "face" ? w + 0.012 : d) + gap;
      if (cursor + along > shelfAt().width) {
        advance();
        if (si >= shelves.length) {
          overflow.push(g);
          return;
        }
        sec = { key: grp.key, shelf: si, start: posOn(shelfAt(), cursor), end: posOn(shelfAt(), cursor), games: [] };
        sections.push(sec);
      }
      const s = shelfAt();
      if (h > s.height + 0.001) {
        // too tall for this shelf: lay it on its back at the front instead
      }
      let p: THREE.Vector3, q: THREE.Quaternion;
      if (mode === "face") {
        const leanBack = Math.sin(lean) * h;
        p = s.origin.clone().addScaledVector(s.dir, cursor + along / 2).addScaledVector(s.normal, -(inset + d / 2 + leanBack * 0.5));
        q = faceOut(s.normal, lean);
      } else {
        p = s.origin.clone().addScaledVector(s.dir, cursor + d / 2 + gap / 2).addScaledVector(s.normal, -(inset + w / 2));
        q = spineOut(s.normal);
      }
      placements.push({ game: g, position: p, quaternion: q });
      sec.games.push(g);
      cursor += along;
      used += along;
      sec.end = posOn(s, cursor);
    });
    flushStack();
  }
  const total = shelves.reduce((a, s) => a + s.width, 0);
  return { placements, sections, overflow, fill: used / Math.max(1e-6, total) };
}

function posOn(s: Shelf, along: number) {
  return s.origin.clone().addScaledVector(s.dir, along);
}

/** Lying flat: cover facing up, spine facing the viewer. */
function flatSpineOut(normal: THREE.Vector3): THREE.Quaternion {
  // local -X (spine) -> normal, local +Z (cover) -> up, local +Y (top) -> into the shelf (-normal)... choose:
  const x = normal.clone().negate();
  const z = UP.clone();
  const y = z.clone().cross(x); // right-handed
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Shelves of a bookcase: rows from the top down. */
export function bookcaseShelves(o: { center: THREE.Vector3; normal: THREE.Vector3; width: number; rows: number[]; base: number; depth: number; thickness?: number; side?: number }): Shelf[] {
  const dir = UP.clone().cross(o.normal); // viewer's right
  const th = o.thickness ?? 0.022;
  const side = o.side ?? 0.025;
  const shelves: Shelf[] = [];
  let y = o.base;
  const ys: { y: number; h: number }[] = [];
  for (const h of o.rows) {
    ys.push({ y, h });
    y += h + th;
  }
  // top shelf first (reading order)
  for (const { y, h } of ys.reverse()) {
    const origin = o.center
      .clone()
      .addScaledVector(dir, -o.width / 2 + side)
      .addScaledVector(UP, y);
    shelves.push({ origin, dir: dir.clone(), normal: o.normal.clone(), width: o.width - side * 2, depth: o.depth, height: h });
  }
  return shelves;
}

/** Total length a list of games needs on shelves, for sizing bookcases from data. */
export function runLength(games: Game[], art: ArtStore, mode: (g: Game) => Mode, gap = 0.0012): number {
  let L = 0;
  for (const g of games) {
    const [w, , d] = templateOf(g, art).size;
    L += (mode(g) === "face" ? w + 0.012 : d) + gap;
  }
  return L;
}
