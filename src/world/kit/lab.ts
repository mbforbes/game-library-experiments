// Props for a clinical test-chamber world: white panel walls, a cell grid for games, live
// portals (render-to-texture with screen-space lookup), chamber signage, the Archivist (a
// deadpan AI core), pneumatic tubes, a weighted cube.

import * as THREE from "three/webgpu";
import {
  positionWorld, vec2, vec3, float, fract, floor, step, smoothstep, mix, hash, texture, screenUV, uv, time, sin, cos, length, atan, abs,
  attribute, normalView, positionViewDirection, uniform, positionLocal, instanceIndex,
} from "three/tsl";
import { boxes, canvas, canvasTexture, lin } from "./common";

/** Lab-wide animation clock (seconds since the level appeared). */
export const labFx = { since: uniform(99) };

/** White wall panels (world-space grid) with occasional dark "non-conductive" panels. */
export function panelMaterial(opts: { size?: number; dark?: number; axis?: "xy" | "zy" | "xz" } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.55 });
  const sz = float(opts.size ?? 0.6);
  const a = opts.axis ?? "xy";
  const p = a === "xy" ? positionWorld.xy : a === "zy" ? positionWorld.zy : positionWorld.xz;
  const g = p.div(sz);
  const cell = floor(g);
  const f = fract(g);
  const seam = step(0.985, f.x).max(step(0.985, f.y)).max(step(f.x, 0.015)).max(step(f.y, 0.015));
  const darkPanel = step(1 - (opts.dark ?? 0.12), hash(cell.x.add(cell.y.mul(71.3))));
  const tone = hash(cell.x.mul(3.1).add(cell.y.mul(17.7))).mul(0.06).add(0.9);
  const base = mix(vec3(0.82, 0.83, 0.84).mul(tone), vec3(0.09, 0.095, 0.1), darkPanel);
  m.colorNode = mix(base, vec3(0.35), seam.mul(0.6));
  m.roughnessNode = mix(float(0.5), float(0.8), darkPanel);
  return m;
}

/** A portal: an oval that shows what its partner sees (screen-space sampled render target). */
export class Portal {
  readonly group = new THREE.Group();
  readonly surface: THREE.Mesh;
  readonly ring: THREE.Mesh;
  partner: Portal | null = null;
  rt: THREE.RenderTarget;
  readonly cam = new THREE.PerspectiveCamera();
  private open = uniform(0);

  /** `rt` should match the main pass (engine.matchingTarget) so the view reuses its pipelines. */
  constructor(readonly color: string, rt: THREE.RenderTarget, readonly w = 1.1, readonly h = 1.9) {
    this.rt = rt;
    const m = new THREE.MeshBasicNodeMaterial();
    const c = lin(color);
    const ec = vec3(c.r, c.g, c.b);
    const p = uv().sub(0.5).mul(2);
    const r = length(p);
    const ang = atan(p.y, p.x);
    const swirl = sin(ang.mul(6).add(time.mul(4)).add(r.mul(10))).mul(0.5).add(0.5);
    const view = texture(this.rt.texture, screenUV);
    const inside = smoothstep(1.0, 0.9, r.div(this.open.max(0.001)));
    const edge = smoothstep(0.75, 0.97, r).mul(smoothstep(1.02, 0.97, r));
    const col = mix(ec.mul(0.2), view.rgb, inside.mul(this.open)).add(ec.mul(edge.mul(swirl.mul(0.6).add(0.6)).mul(3)));
    m.colorNode = vec3(0);
    m.emissiveNode = col;
    m.opacityNode = smoothstep(1.02, 0.98, r);
    m.transparent = true;
    this.surface = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    this.group.add(this.surface);
    // glowing rim
    const rm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const q = uv().sub(0.5).mul(2);
    const rr = length(q);
    const flick = sin(atan(q.y, q.x).mul(12).sub(time.mul(6))).mul(0.3).add(0.7);
    rm.colorNode = vec3(0);
    rm.emissiveNode = ec.mul(smoothstep(0.9, 1.0, rr).mul(smoothstep(1.15, 1.0, rr)).mul(flick).mul(4));
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.2, h * 1.12), rm);
    this.ring.position.z = 0.005;
    this.group.add(this.ring);
  }

  link(p: Portal) {
    this.partner = p;
    p.partner = this;
  }

  setOpen(v: number) {
    this.open.value = v;
  }

  resize(w: number, h: number) {
    this.rt.setSize(Math.max(64, Math.floor(w)), Math.max(64, Math.floor(h)));
  }

  /** Place this portal's virtual camera so it sees through the partner. */
  updateCamera(main: THREE.PerspectiveCamera) {
    const dst = this.partner!;
    this.group.updateMatrixWorld();
    dst.group.updateMatrixWorld();
    const flip = new THREE.Matrix4().makeRotationY(Math.PI);
    const m = new THREE.Matrix4().copy(dst.group.matrixWorld).multiply(flip).multiply(this.group.matrixWorld.clone().invert()).multiply(main.matrixWorld);
    m.decompose(this.cam.position, this.cam.quaternion, this.cam.scale);
    this.cam.fov = main.fov;
    this.cam.aspect = main.aspect;
    this.cam.near = Math.max(0.05, this.cam.position.distanceTo(dst.group.getWorldPosition(new THREE.Vector3())) * 0.7);
    this.cam.far = main.far;
    this.cam.updateProjectionMatrix();
    this.cam.updateMatrixWorld();
  }
}

/** Chamber sign: big number, a progress bar and a row of pictograms. */
export function chamberSign(opts: { number: string; caption: string; progress: number; lines: string[]; width?: number }) {
  const W = 512, H = 800;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = "#e9e9e6";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#1a1a1a";
  ctx.font = `600 230px "Oswald", sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(opts.number, 30, 10, W - 60);
  ctx.font = `500 30px "Barlow Condensed", sans-serif`;
  ctx.fillText(opts.caption.toUpperCase(), 34, 270, W - 60);
  // progress bar
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(34, 320, W - 68, 6);
  const bars = 30;
  for (let i = 0; i < bars; i++) {
    ctx.fillStyle = i / bars < opts.progress ? "#1a1a1a" : "#c9c9c4";
    ctx.fillRect(34 + (i * (W - 68)) / bars, 336, (W - 68) / bars - 4, 26);
  }
  ctx.font = `400 28px "Inter", sans-serif`;
  let y = 400;
  for (const l of opts.lines) {
    ctx.fillStyle = "#1a1a1a";
    ctx.fillText(l, 34, y, W - 68);
    y += 46;
  }
  ctx.fillStyle = "#1a1a1a";
  ctx.font = `500 22px "Barlow Condensed", sans-serif`;
  ctx.fillText("BACKLOG SCIENCE ENRICHMENT CENTER", 34, H - 50);
  const tex = canvasTexture(c);
  const w = opts.width ?? 1.1;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
  m.colorNode = texture(tex).rgb;
  m.emissiveNode = texture(tex).rgb.mul(0.25);
  return new THREE.Mesh(new THREE.PlaneGeometry(w, (w * H) / W), m);
}

/**
 * A dark label strip: a bold title, colour swatches with labels, and a small note (e.g. the sort
 * order), auto-fitted and sized to read from across the chamber. Origin at its centre, facing +Z.
 */
export function legendStrip(opts: { title?: string; items?: { color: string; label: string }[]; note?: string; width: number; height?: number }) {
  const CW = 4096;
  const CH = Math.round((CW * (opts.height ?? 0.4)) / opts.width);
  const [c, ctx] = canvas(CW, CH);
  ctx.fillStyle = "#17191e";
  ctx.beginPath();
  ctx.roundRect(0, 0, CW, CH, Math.min(40, CH * 0.2));
  ctx.fill();
  ctx.textBaseline = "middle";
  const items = opts.items ?? [];
  const pad = CH * 0.32;
  // measure at full size, then shrink everything to fit
  let k = 1;
  const big = (s: number) => `600 ${Math.round(CH * 0.48 * s)}px "Oswald", sans-serif`;
  const mid = (s: number) => `500 ${Math.round(CH * 0.41 * s)}px "Oswald", sans-serif`;
  const small = (s: number) => `500 ${Math.round(CH * 0.3 * s)}px "Barlow Condensed", sans-serif`;
  const total = (s: number) => {
    let w = pad;
    if (opts.title) {
      ctx.font = big(s);
      w += ctx.measureText(opts.title).width + pad * 1.4;
    }
    ctx.font = mid(s);
    for (const it of items) w += CH * 0.47 * s + CH * 0.14 * s + ctx.measureText(it.label).width + pad;
    if (opts.note) {
      ctx.font = small(s);
      w += ctx.measureText(opts.note).width + pad;
    }
    return w;
  };
  k = Math.min(1, (CW - pad) / total(1));
  let x = pad;
  const cy = CH / 2 + CH * 0.02;
  if (opts.title) {
    ctx.fillStyle = "#ffffff";
    ctx.font = big(k);
    ctx.fillText(opts.title, x, cy);
    x += ctx.measureText(opts.title).width + pad * 1.4;
  }
  for (const it of items) {
    const sw = CH * 0.47 * k;
    ctx.fillStyle = it.color;
    ctx.shadowColor = it.color;
    ctx.shadowBlur = CH * 0.12;
    ctx.beginPath();
    ctx.roundRect(x, CH / 2 - sw / 2, sw, sw, sw * 0.18);
    ctx.fill();
    ctx.shadowBlur = 0;
    x += sw + CH * 0.14 * k;
    ctx.fillStyle = "#f2f4f7";
    ctx.font = mid(k);
    ctx.fillText(it.label, x, cy);
    x += ctx.measureText(it.label).width + pad;
  }
  if (opts.note) {
    ctx.fillStyle = "#9aa3b2";
    ctx.font = small(k);
    ctx.textAlign = "right";
    ctx.fillText(opts.note, CW - pad, cy);
  }
  const tex = canvasTexture(c);
  tex.anisotropy = 8;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, transparent: true });
  m.colorNode = texture(tex).rgb;
  m.opacityNode = texture(tex).a;
  m.emissiveNode = texture(tex).rgb.mul(0.45);
  return new THREE.Mesh(new THREE.PlaneGeometry(opts.width, (opts.width * CH) / CW), m);
}

/**
 * An Aperture-style data board (white enamel panel, black type, thin rules). `draw` gets a
 * canvas laid out in board millimetres scaled to pixels: draw with the helpers it receives.
 * Origin at the board's centre, facing +Z.
 */
export function dataBoard(width: number, height: number, draw: (b: BoardPen) => void) {
  const PX = 900; // pixels per metre
  const CW = Math.round(width * PX), CH = Math.round(height * PX);
  const [c, ctx] = canvas(CW, CH);
  ctx.fillStyle = "#eceeec";
  ctx.fillRect(0, 0, CW, CH);
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 6;
  ctx.strokeRect(24, 24, CW - 48, CH - 48);
  const pen = new BoardPen(ctx, CW, CH);
  draw(pen);
  const tex = canvasTexture(c);
  tex.anisotropy = 8;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.55 });
  m.colorNode = texture(tex).rgb;
  m.emissiveNode = texture(tex).rgb.mul(0.22);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), m);
  // a slim dark bezel behind
  const back = new THREE.Mesh(new THREE.BoxGeometry(width + 0.06, height + 0.06, 0.03), new THREE.MeshStandardNodeMaterial({ color: 0x2b2d33, roughness: 0.4, metalness: 0.4 }));
  back.position.z = -0.018;
  mesh.add(back);
  return mesh;
}

/** Drawing helpers for dataBoard: a cursor (y) moving down the board. */
export class BoardPen {
  y = 70;
  readonly pad = 70;
  constructor(readonly ctx: CanvasRenderingContext2D, readonly W: number, readonly H: number) {
    ctx.textBaseline = "alphabetic";
  }
  get inner() {
    return this.W - this.pad * 2;
  }
  /** big title + small caption, with a rule under */
  head(title: string, caption?: string, num?: string) {
    const c = this.ctx;
    c.fillStyle = "#1a1a1a";
    c.font = `600 120px "Oswald", sans-serif`;
    this.y += 108;
    c.fillText(title, this.pad, this.y, this.inner);
    if (num) {
      c.textAlign = "right";
      c.font = `500 120px "Oswald", sans-serif`;
      c.fillText(num, this.W - this.pad, this.y);
      c.textAlign = "left";
    }
    if (caption) {
      c.font = `500 50px "Barlow Condensed", sans-serif`;
      c.fillStyle = "#555";
      this.y += 64;
      c.fillText(caption.toUpperCase(), this.pad + 2, this.y, this.inner);
    }
    this.y += 24;
    c.fillStyle = "#1a1a1a";
    c.fillRect(this.pad, this.y, this.inner, 5);
    this.y += 40;
  }
  /** horizontal bars: label | bar | value */
  bars(rows: { label: string; value: number; color: string; text?: string }[], opts: { max?: number; labelW?: number; rowH?: number } = {}) {
    const c = this.ctx;
    const max = opts.max ?? Math.max(1, ...rows.map((r) => r.value));
    const lw = opts.labelW ?? 260, rh = opts.rowH ?? 62;
    const bw = this.inner - lw - 190;
    for (const r of rows) {
      c.fillStyle = "#1a1a1a";
      c.font = `500 ${Math.round(rh * 0.7)}px "Oswald", sans-serif`;
      c.fillText(r.label, this.pad, this.y + rh * 0.72, lw - 20);
      c.fillStyle = "#d4d6d3";
      c.fillRect(this.pad + lw, this.y + rh * 0.18, bw, rh * 0.6);
      c.fillStyle = r.color;
      c.fillRect(this.pad + lw, this.y + rh * 0.18, Math.max(4, (bw * r.value) / max), rh * 0.6);
      c.fillStyle = "#1a1a1a";
      c.font = `500 ${Math.round(rh * 0.6)}px "Inter", sans-serif`;
      c.fillText(r.text ?? String(r.value), this.pad + lw + bw + 22, this.y + rh * 0.7, 150);
      this.y += rh;
    }
    this.y += 16;
  }
  /** wrapped paragraph text; returns false if it ran out of room */
  text(s: string, opts: { size?: number; color?: string; font?: string; indent?: number; gap?: number; bullet?: string } = {}) {
    const c = this.ctx;
    const size = opts.size ?? 40;
    c.font = `${opts.font ?? "400"} ${size}px "Inter", sans-serif`;
    c.fillStyle = opts.color ?? "#1a1a1a";
    const x = this.pad + (opts.indent ?? 0);
    const maxW = this.inner - (opts.indent ?? 0);
    const words = s.split(/\s+/);
    let line = "";
    const lines: string[] = [];
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (c.measureText(t).width > maxW && line) {
        lines.push(line);
        line = w;
      } else line = t;
    }
    if (line) lines.push(line);
    if (this.y + lines.length * size * 1.3 > this.H - 60) return false;
    lines.forEach((l, i) => {
      if (i === 0 && opts.bullet) {
        c.fillStyle = opts.color ?? "#1a1a1a";
        c.fillText(opts.bullet, x - size * 1.1, this.y + size);
      }
      c.fillText(l, x, this.y + size);
      this.y += size * 1.3;
    });
    this.y += opts.gap ?? size * 0.4;
    return true;
  }
  /** small footer line at the bottom of the board */
  foot(s: string) {
    const c = this.ctx;
    c.font = `500 38px "Barlow Condensed", sans-serif`;
    c.fillStyle = "#666";
    c.fillText(s.toUpperCase(), this.pad, this.H - 58, this.inner);
  }
}

/** The Archivist: a hanging spherical AI core with a single eye. */
export class Archivist {
  readonly group = new THREE.Group();
  private eye: THREE.Mesh;
  private core: THREE.Group;
  mood = uniform(0); // 0 calm, 1 talking

  constructor() {
    const shell = new THREE.MeshStandardNodeMaterial({ color: 0xdedfe2, roughness: 0.35, metalness: 0.3 });
    const dark = new THREE.MeshStandardNodeMaterial({ color: 0x1a1b1f, roughness: 0.5, metalness: 0.5 });
    this.core = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 40, 30), shell);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.04, 12, 48), dark);
    band.rotation.y = Math.PI / 2;
    const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.08, 32).rotateX(Math.PI / 2), dark);
    socket.position.z = 0.4;
    const em = new THREE.MeshBasicNodeMaterial();
    const p = uv().sub(0.5);
    const pulse = sin(time.mul(3)).mul(0.15).add(0.85).add(this.mood.mul(sin(time.mul(18)).mul(0.25)));
    em.colorNode = vec3(0);
    em.emissiveNode = vec3(1.0, 0.75, 0.2).mul(smoothstep(0.5, 0.0, length(p)).mul(4).mul(pulse));
    this.eye = new THREE.Mesh(new THREE.CircleGeometry(0.12, 32), em);
    this.eye.position.z = 0.445;
    this.core.add(body, band, socket, this.eye);
    // arm up into the ceiling
    const arm = new THREE.Mesh(boxes([[0, 0.9, -0.1, 0.12, 1.4, 0.12], [0, 1.6, -0.1, 0.5, 0.12, 0.5]]), dark);
    this.group.add(this.core, arm);
  }

  update(t: number, look: THREE.Vector3) {
    this.core.position.y = Math.sin(t * 0.8) * 0.04;
    const target = this.group.worldToLocal(look.clone());
    const yaw = Math.atan2(target.x, target.z);
    const pitch = -Math.atan2(target.y - this.core.position.y, Math.hypot(target.x, target.z));
    this.core.rotation.y += (yaw - this.core.rotation.y) * 0.05;
    this.core.rotation.x += (pitch * 0.6 - this.core.rotation.x) * 0.05;
    this.core.rotation.z = Math.sin(t * 0.5) * 0.08;
  }
}

/** Glass pneumatic tube (open cylinder) with a soft rim. */
export function tube(height: number, radius: number) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  const rim = float(1).sub(abs(normalView.dot(positionViewDirection))).pow(3);
  m.colorNode = vec3(0);
  m.emissiveNode = vec3(0.6, 0.85, 1.0).mul(rim.mul(0.5).add(0.02));
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 32, 1, true), m);
  mesh.position.y = height / 2;
  const caps = new THREE.Mesh(
    boxes([
      [0, 0.05, 0, radius * 2.4, 0.1, radius * 2.4],
      [0, height - 0.05, 0, radius * 2.4, 0.1, radius * 2.4],
    ]),
    new THREE.MeshStandardNodeMaterial({ color: 0x2a2b30, roughness: 0.4, metalness: 0.6 }),
  );
  const g = new THREE.Group();
  g.add(mesh, caps);
  return g;
}

/** A weighted storage cube with hearts. */
export function companionCube(size = 0.4) {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardNodeMaterial({ color: 0xbfc3c8, roughness: 0.5, metalness: 0.2 }));
  g.add(shell);
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = "#e7e7e7";
  ctx.beginPath();
  ctx.arc(64, 64, 52, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ff5fa2";
  ctx.beginPath();
  ctx.moveTo(64, 96);
  ctx.bezierCurveTo(20, 66, 34, 30, 64, 50);
  ctx.bezierCurveTo(94, 30, 108, 66, 64, 96);
  ctx.fill();
  const t = canvasTexture(c);
  const fm = new THREE.MeshStandardNodeMaterial({ transparent: true, roughness: 0.4 });
  fm.colorNode = texture(t).rgb;
  fm.opacityNode = texture(t).a;
  fm.emissiveNode = texture(t).rgb.mul(vec3(1, 0.3, 0.6)).mul(texture(t).r.mul(0.4));
  for (let i = 0; i < 6; i++) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.6, size * 0.6), fm);
    const n = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)][i];
    f.position.copy(n).multiplyScalar(size / 2 + 0.002);
    f.lookAt(n.clone().multiplyScalar(10));
    g.add(f);
  }
  return g;
}

/** Instanced cell frames with a per-cell status light strip (colour per instance). */
export function cellFrames(cells: { pos: THREE.Vector3; quat: THREE.Quaternion; color: THREE.Color; size: number }[]) {
  const n = cells.length;
  const s = 1;
  const frameGeo = boxes([
    [0, -0.5 * s, -0.04, s, 0.06, 0.12],
    [0, 0.5 * s, -0.04, s, 0.06, 0.12],
    [-0.5 * s, 0, -0.04, 0.06, s, 0.12],
    [0.5 * s, 0, -0.04, 0.06, s, 0.12],
    [0, 0, -0.1, s, s, 0.02],
  ]);
  const frame = new THREE.InstancedMesh(frameGeo, new THREE.MeshStandardNodeMaterial({ color: 0x2b2d33, roughness: 0.45, metalness: 0.5 }), n);
  const lightGeo = new THREE.BoxGeometry(0.8, 0.035, 0.02).translate(0, -0.44, 0.02);
  const colAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  lightGeo.setAttribute("aColor", colAttr);
  const delayAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  lightGeo.setAttribute("aDelay", delayAttr);
  const xs = cells.map((c) => c.pos.x), ys = cells.map((c) => c.pos.y);
  const x0 = Math.min(...xs), y1 = Math.max(...ys);
  const lm = new THREE.MeshBasicNodeMaterial();
  const ac = attribute("aColor", "vec3");
  // power-up wave: each light switches on after a delay that sweeps across the wall
  const delay = attribute("aDelay", "float");
  const since = labFx.since.sub(delay);
  const on = since.lessThan(0).select(float(0.03), since.lessThan(0.12).select(float(2.4), float(1)));
  lm.colorNode = vec3(0);
  lm.emissiveNode = ac.mul(sin(time.mul(1.5).add(float(instanceIndex).mul(0.37))).mul(0.15).add(1.6)).mul(on);
  const light = new THREE.InstancedMesh(lightGeo, lm, n);
  const m = new THREE.Matrix4();
  cells.forEach((cl, i) => {
    m.compose(cl.pos, cl.quat, new THREE.Vector3(cl.size, cl.size, cl.size));
    frame.setMatrixAt(i, m);
    light.setMatrixAt(i, m);
    colAttr.setXYZ(i, cl.color.r, cl.color.g, cl.color.b);
    delayAttr.setX(i, 0.4 + (cl.pos.x - x0) * 0.16 + (y1 - cl.pos.y) * 0.22 + Math.random() * 0.08);
  });
  frame.computeBoundingSphere();
  light.computeBoundingSphere();
  return { frame, light };
}

export { cos, positionLocal };
