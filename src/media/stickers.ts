// Cooper's stickers: little glossy vinyl dots with his grade (A+…F) or an amber "now playing"
// marker. They're real decals (instanced quads), so they sit on scanned and printed spines
// alike — and on the front corner of cartridges, which have no spine.

import * as THREE from "three/webgpu";
import { attribute, texture, uv, vec2, float } from "three/tsl";
import type { Game } from "../../shared/types";
import { GRADE_COLORS } from "./spines";
import type { Template } from "./templates";

const CELLS = ["A+", "A", "B", "C", "D", "F", "PLAY", "NEW"];
export const NEW_CELL = CELLS.indexOf("NEW");

/** Games added to the sheet recently (set by the app from /api/seen): they get a NEW! sticker. */
let newIds: Set<string> = new Set();
export function setNewIds(ids: Set<string>) {
  newIds = ids;
}
const S = 96;

let atlas: THREE.CanvasTexture | null = null;
export function stickerAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const c = document.createElement("canvas");
  c.width = S * CELLS.length;
  c.height = S;
  const ctx = c.getContext("2d")!;
  CELLS.forEach((k, i) => {
    const cx = i * S + S / 2, cy = S / 2, r = S * 0.46;
    if (k === "NEW") {
      // a starburst: hot yellow with a magenta outline and "NEW!"
      ctx.beginPath();
      for (let p = 0; p < 28; p++) {
        const a = (p / 28) * Math.PI * 2 - Math.PI / 2;
        const rr = p % 2 ? r * 0.74 : r;
        ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fillStyle = "#ffe14a";
      ctx.fill();
      ctx.lineWidth = S * 0.05;
      ctx.strokeStyle = "#ff2e88";
      ctx.stroke();
      ctx.fillStyle = "#e0105e";
      ctx.font = `800 ${S * 0.3}px "Oswald", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("NEW!", cx, cy + S * 0.02);
      return;
    }
    ctx.fillStyle = k === "PLAY" ? "#ffb000" : GRADE_COLORS[k];
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = S * 0.04;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.86, Math.PI * 1.1, Math.PI * 1.6);
    ctx.stroke();
    ctx.fillStyle = "#151515";
    if (k === "PLAY") {
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.3, cy - r * 0.42);
      ctx.lineTo(cx + r * 0.45, cy);
      ctx.lineTo(cx - r * 0.3, cy + r * 0.42);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.font = `700 ${k.length > 1 ? S * 0.46 : S * 0.6}px "Oswald", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(k, cx, cy + S * 0.03);
    }
  });
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 8;
  return atlas;
}

export function stickerCell(g: Game): number {
  if (newIds.has(g.id)) return NEW_CELL;
  if (g.status === "playing") return CELLS.indexOf("PLAY");
  if (g.status === "completed" && g.grade) return CELLS.indexOf(g.grade);
  return -1;
}

/** Sticker transform in an item's local space (spine foot for cases, front corner for carts). */
export function stickerLocal(t: Template, photo: boolean): THREE.Matrix4 | null {
  const [w, h, d] = t.size;
  if (t.kind === "cabinet") return null;
  if (t.spine) {
    const size = Math.min(d * 0.78, 0.0115);
    return new THREE.Matrix4().compose(new THREE.Vector3(-w / 2 - 0.0007, h * 0.15, 0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2), new THREE.Vector3(size, size, 1));
  }
  const size = Math.min(w * 0.16, 0.014);
  return new THREE.Matrix4().compose(new THREE.Vector3(w / 2 - size * 0.8, size * 0.75, d / 2 + (photo ? 0.0016 : 0.0009)), new THREE.Quaternion(), new THREE.Vector3(size, size, 1));
}

export function stickerMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.22, metalness: 0, alphaTest: 0.5 });
  const cell = attribute("sCell", "float");
  const s = texture(stickerAtlas(), vec2(uv().x.add(cell).div(CELLS.length), uv().y));
  m.colorNode = s.rgb;
  m.opacityNode = s.a;
  m.emissiveNode = s.rgb.mul(float(0.12));
  return m;
}
