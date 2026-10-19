// "Lite" shading for older phone GPUs: every lit material in a room is shaded matte (diffuse light
// only, three's Lambert model: no specular highlights, no environment reflections). Measured on a
// phone, the lighting was most of what a room cost the GPU (matte everywhere: about a third less in
// the Den, half in the Lab). The materials are changed in place, before the room's shaders are
// compiled, so anything that animates or highlights a material keeps working.

import * as THREE from "three/webgpu";

const matte = new WeakSet<THREE.Material>();
const lambert = () => new THREE.PhongLightingModel(false);
const none = () => null;
const nothing = () => {};

export function matteShading(root: THREE.Object3D) {
  root.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
      const s = m as any;
      if (!s.isMeshStandardNodeMaterial || matte.has(m)) continue;
      matte.add(m);
      s.setupLightingModel = lambert;
      s.setupEnvironment = none; // (Lambert takes no reflections from the scene's environment)
      s.setupVariants = nothing; // (metalness / roughness: nothing left to use them)
      m.needsUpdate = true;
    }
  });
}
