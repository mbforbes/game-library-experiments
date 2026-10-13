// Inspect mode: the tapped game flies out of its slot to float in front of the camera,
// with a dimmer behind it. Drag to turn it over, flip to read the back. Closing flies it home.

import * as THREE from "three/webgpu";
import type { Game } from "../../shared/types";
import { Hero } from "../media/hero";
import type { ArtStore } from "../library/art";
import type { MediaField } from "../media/field";

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Inspector {
  hero: Hero | null = null;
  private field: MediaField | null = null;
  private fromM = new THREE.Matrix4();
  private pulledM = new THREE.Matrix4();
  private t = 0;
  private dir: 1 | -1 = 1;
  private yaw = 0;
  private pitch = 0;
  private yawVel = 0;
  private yawGoal = 0;
  private pitchGoal = 0;
  private dimmer: THREE.Mesh;
  private dimMat: THREE.MeshBasicNodeMaterial;
  private closing: (() => void) | null = null;
  layout: "side" | "top" = "side";

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private art: ArtStore) {
    this.dimMat = new THREE.MeshBasicNodeMaterial({ color: 0x05060a, transparent: true, opacity: 0, depthWrite: false, depthTest: false });
    this.dimmer = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.dimMat);
    this.dimmer.renderOrder = 998;
    this.dimmer.frustumCulled = false;
    this.dimmer.visible = false;
    scene.add(this.dimmer);
  }

  get active() {
    return !!this.hero;
  }

  open(game: Game, field: MediaField | null) {
    if (this.hero) this.close(true);
    const hero = new Hero(game, this.art);
    this.hero = hero;
    this.field = field;
    if (field && field.has(game.id)) {
      field.matrixOf(game.id, this.fromM);
      // hero is centred on its middle; instance origin is at its base
      const [, h] = hero.size;
      this.fromM.multiply(new THREE.Matrix4().makeTranslation(0, h / 2, 0));
      field.hide(game.id, true);
      // slide it out of the shelf first, along whichever face points at the camera
      const pos = new THREE.Vector3().setFromMatrixPosition(this.fromM);
      const toCam = this.camera.position.clone().sub(pos).normalize();
      const q = new THREE.Quaternion().setFromRotationMatrix(this.fromM);
      const axes = [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1)].map((a) => a.applyQuaternion(q));
      const out = axes.reduce((best, a) => (a.dot(toCam) > best.dot(toCam) ? a : best));
      const [w, , d] = hero.size;
      const dist = Math.max(w, d) * 0.9 + 0.03;
      this.pulledM.copy(this.fromM).premultiply(new THREE.Matrix4().makeTranslation(out.x * dist, out.y * dist + 0.004, out.z * dist));
    } else {
      // appear from slightly below the view
      this.fromM.compose(this.camera.localToWorld(new THREE.Vector3(0, -0.4, -0.8)), this.camera.quaternion, new THREE.Vector3(0.01, 0.01, 0.01));
      this.pulledM.copy(this.fromM);
    }
    this.scene.add(hero.object);
    hero.mesh.renderOrder = 999;
    this.t = 0;
    this.dir = 1;
    this.yaw = 0;
    this.pitch = 0;
    this.yawGoal = 0;
    this.pitchGoal = 0;
    this.yawVel = 0;
    this.closing = null;
  }

  close(immediate = false) {
    if (!this.hero) return;
    if (immediate) {
      this.finishClose();
      return;
    }
    this.dir = -1;
    this.closing = () => this.finishClose();
  }

  private finishClose() {
    if (this.hero && this.field) this.field.hide(this.hero.game.id, false);
    this.hero?.dispose();
    this.hero = null;
    this.field = null;
    this.closing = null;
    this.dimmer.visible = false;
  }

  flip() {
    this.yawGoal = Math.round((this.yawGoal + Math.PI) / Math.PI) * Math.PI;
    this.yawVel = 0;
  }

  drag(dx: number, dy: number) {
    this.yawGoal += dx * 0.012;
    this.pitchGoal = Math.max(-0.9, Math.min(0.9, this.pitchGoal + dy * 0.008));
  }

  release() {
    // settle to the nearest face (front / back / spine) for readability
    const q = Math.PI / 2;
    this.yawGoal = Math.round(this.yawGoal / q) * q;
    this.pitchGoal = 0;
  }

  showSpine() {
    this.yawGoal = Math.round(this.yawGoal / (Math.PI * 2)) * Math.PI * 2 + Math.PI / 2;
  }

  /** Where the hero floats, in camera space, so the HUD panel doesn't cover it. */
  private targetMatrix(out: THREE.Matrix4) {
    const hero = this.hero!;
    const [w, h, d] = hero.size;
    const dist = 0.7;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const viewH = 2 * dist * Math.tan(fov / 2);
    const viewW = viewH * this.camera.aspect;
    const side = this.layout === "side";
    const frac = side ? 0.62 : 0.32;
    const maxDim = Math.max(h, w * (side ? 1 : 1.2), d);
    const scale = Math.min((frac * viewH) / maxDim, ((side ? 0.5 : 0.8) * viewW) / Math.max(w, d));
    const x = side ? -viewW * 0.2 : 0;
    const y = side ? 0 : viewH * 0.215;
    const local = new THREE.Vector3(x, y, -dist);
    const pos = local.applyMatrix4(this.camera.matrixWorld);
    const rot = this.camera.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ")));
    return out.compose(pos, rot, new THREE.Vector3(scale, scale, scale));
  }

  update(dt: number, time: number) {
    if (!this.hero) return;
    this.t = Math.max(0, Math.min(1, this.t + (this.dir * dt) / 0.85));
    const k = 1 - Math.exp(-dt * 7);
    this.yaw += (this.yawGoal - this.yaw) * k;
    this.pitch += (this.pitchGoal - this.pitch) * k;
    const idle = Math.sin(time * 0.9) * 0.05;
    const target = this.targetMatrix(new THREE.Matrix4());
    // gentle idle sway
    target.multiply(new THREE.Matrix4().makeRotationY(idle));
    // phase 1 (first 22%): slide out of the shelf; phase 2: float up to the viewer
    const SPLIT = 0.22;
    const p0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), s0 = new THREE.Vector3();
    const p1 = new THREE.Vector3(), q1 = new THREE.Quaternion(), s1 = new THREE.Vector3();
    let pos: THREE.Vector3, rot: THREE.Quaternion, sc: THREE.Vector3, e: number;
    if (this.t < SPLIT) {
      const k = this.t / SPLIT;
      const ek = 1 - Math.pow(1 - k, 3);
      this.fromM.decompose(p0, q0, s0);
      this.pulledM.decompose(p1, q1, s1);
      pos = p0.lerp(p1, ek);
      rot = q0;
      sc = s0;
      e = 0;
    } else {
      e = ease((this.t - SPLIT) / (1 - SPLIT));
      this.pulledM.decompose(p0, q0, s0);
      target.decompose(p1, q1, s1);
      const arc = Math.sin(e * Math.PI) * 0.08;
      pos = p0.clone().lerp(p1, e);
      pos.y += arc;
      rot = q0.clone().slerp(q1, e);
      sc = s0.clone().lerp(s1, e);
    }
    this.hero.object.position.copy(pos);
    this.hero.object.quaternion.copy(rot);
    this.hero.object.scale.copy(sc);
    this.hero.glow = 0.25 * e;

    // dimmer: a camera-facing plane just behind the hero
    this.dimmer.visible = true;
    const dd = 1.4;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const vh = 2 * dd * Math.tan(fov / 2) * 1.2;
    this.dimmer.position.copy(new THREE.Vector3(0, 0, -dd).applyMatrix4(this.camera.matrixWorld));
    this.dimmer.quaternion.copy(this.camera.quaternion);
    this.dimmer.scale.set(vh * this.camera.aspect, vh, 1);
    this.dimMat.opacity = 0.72 * e;

    if (this.dir === -1 && this.t <= 0 && this.closing) this.closing();
  }
}
