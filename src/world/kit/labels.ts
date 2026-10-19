// Many small canvas labels drawn as one mesh: each label is painted into a cell of a shared
// texture and placed as an instance. (A mesh per label was a draw per label, and on phones a
// frame's cost is mostly its number of draws.)

import * as THREE from "three/webgpu";
import { attribute, texture, uv, vec2, vec3 } from "three/tsl";
import { canvas, canvasTexture } from "./common";

type Paint = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

export class LabelSheet {
  private items: { paint: Paint; m: THREE.Matrix4 }[] = [];

  /**
   * `px`: each label's canvas size; `size`: its size in the world (m). `glow` scales the painted
   * colours, which show as emission (unlit).
   */
  constructor(private px: [number, number], private size: [number, number], private glow = 1.2) {}

  add(paint: Paint, position: THREE.Vector3, quaternion: THREE.Quaternion) {
    this.items.push({ paint, m: new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1)) });
  }

  /** One instanced mesh holding every label added (null if none were). */
  build(): THREE.InstancedMesh | null {
    const n = this.items.length;
    if (!n) return null;
    const [w, h] = this.px;
    // cells with a gutter (each label's own background spreads into it), so smaller mip levels
    // don't pick up the neighbouring label
    const G = 6, cw = w + G * 2, ch = h + G * 2;
    const cols = Math.max(1, Math.min(n, Math.floor(2048 / cw)));
    const rows = Math.ceil(n / cols);
    const [c, ctx] = canvas(cols * cw, rows * ch);
    const rect = new Float32Array(n * 4);
    this.items.forEach((it, i) => {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      ctx.save();
      // paint scaled up over the gutter first (its background), then exactly into the cell
      ctx.translate(x, y);
      ctx.scale(cw / w, ch / h);
      it.paint(ctx, w, h);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + G, y + G, w, h);
      ctx.clip();
      ctx.translate(x + G, y + G);
      it.paint(ctx, w, h);
      ctx.restore();
      // (texture v runs bottom-up)
      rect.set([(x + G) / c.width, 1 - (y + G + h) / c.height, w / c.width, h / c.height], i * 4);
    });
    const tex = canvasTexture(c);
    const geo = new THREE.PlaneGeometry(this.size[0], this.size[1]);
    geo.setAttribute("iRect", new THREE.InstancedBufferAttribute(rect, 4));
    const r = attribute("iRect", "vec4");
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = vec3(0);
    m.emissiveNode = texture(tex, r.xy.add(uv().mul(vec2(r.z, r.w)))).rgb.mul(this.glow);
    const mesh = new THREE.InstancedMesh(geo, m, n);
    this.items.forEach((it, i) => mesh.setMatrixAt(i, it.m));
    mesh.computeBoundingSphere();
    mesh.name = "labels";
    this.items = [];
    return mesh;
  }
}
