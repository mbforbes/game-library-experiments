// Small particle bursts (sparkles / dust) for moments like pulling a game off the shelf.
// One instanced mesh, simulated on the CPU (a few dozen particles at a time).

import * as THREE from "three/webgpu";
import { live } from "../../engine/quality";
import { uniform, vec3, attribute } from "three/tsl";

interface P {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  max: number;
  size: number;
}

export class Bursts {
  readonly mesh: THREE.InstancedMesh;
  private ps: P[] = [];
  private color = uniform(new THREE.Color(1, 1, 1));
  private fadeAttr: THREE.InstancedBufferAttribute;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();

  constructor(private max = 96) {
    const geo = new THREE.OctahedronGeometry(1, 0);
    this.fadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    geo.setAttribute("pFade", this.fadeAttr);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const fade = attribute("pFade", "float");
    mat.colorNode = vec3(0);
    mat.emissiveNode = this.color.mul(fade).mul(3);
    mat.opacityNode = fade;
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  emit(at: THREE.Vector3, color: string, n = 18, spread = 0.12, upward = 0.25) {
    if (!live.fx) return;
    this.color.value.set(color).convertSRGBToLinear();
    for (let i = 0; i < n; i++) {
      if (this.ps.length >= this.max) this.ps.shift();
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6 + 0.2, Math.random() - 0.5).normalize();
      this.ps.push({
        pos: at.clone().addScaledVector(dir, Math.random() * spread * 0.4),
        vel: dir.multiplyScalar(spread * (0.6 + Math.random())).add(new THREE.Vector3(0, upward * Math.random(), 0)),
        life: 0,
        max: 0.6 + Math.random() * 0.7,
        size: 0.003 + Math.random() * 0.004,
      });
    }
  }

  update(dt: number) {
    let k = 0;
    this.ps = this.ps.filter((p) => (p.life += dt) < p.max);
    for (const p of this.ps) {
      p.vel.multiplyScalar(Math.exp(-dt * 2.2));
      p.vel.y -= dt * 0.08;
      p.pos.addScaledVector(p.vel, dt);
      const f = 1 - p.life / p.max;
      this.s.setScalar(p.size * (0.5 + f));
      this.q.setFromEuler(new THREE.Euler(p.life * 7, p.life * 5, 0));
      this.m.compose(p.pos, this.q, this.s);
      this.mesh.setMatrixAt(k, this.m);
      this.fadeAttr.setX(k, f * f);
      k++;
    }
    this.mesh.count = k;
    if (k) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.fadeAttr.needsUpdate = true;
    }
  }
}
