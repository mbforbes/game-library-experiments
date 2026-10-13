// NodeMaterial.setupLighting() honours `emissiveNode` on every node material (it feeds the
// MRT emissive target that drives selective bloom), but the typings only declare it on lit
// materials. We use it on unlit ones for neon, screens and holograms.
import "three/webgpu";

declare module "three/webgpu" {
  interface MeshBasicNodeMaterial {
    emissiveNode: any;
  }
}
