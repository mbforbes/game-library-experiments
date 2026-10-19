// "Lite" shading for older phone GPUs: every lit material is shaded matte (diffuse light only,
// three's Lambert model: no specular highlights, no environment reflections). Measured on a phone,
// the lighting was most of what a room cost the GPU (matte everywhere: about a third less in the
// Den, half in the Lab). It's switched on for the whole visit before anything is built, so every
// material made at any time (close-up overlays, the opened game) gets the same matte shaders, and
// anything that animates or highlights a material keeps working.

import * as THREE from "three/webgpu";

const lambert = () => new THREE.PhongLightingModel(false);
const none = () => null;
const nothing = () => {};

export function useMatteShading() {
  for (const M of [THREE.MeshStandardNodeMaterial, THREE.MeshPhysicalNodeMaterial]) {
    const p = M.prototype as any;
    p.setupLightingModel = lambert;
    p.setupEnvironment = none; // (Lambert takes no reflections from the scene's environment)
    p.setupVariants = nothing; // (metalness / roughness: nothing left to use them)
  }
}
