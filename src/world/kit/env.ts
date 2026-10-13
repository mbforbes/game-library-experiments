// Environment maps for reflections: a dark room lit by coloured neon panels, prefiltered (PMREM).

import * as THREE from "three/webgpu";

export function neonEnvironment(renderer: THREE.WebGPURenderer, panels: { color: string; pos: [number, number, number]; size: [number, number, number]; intensity?: number }[], bg = 0x050409) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(bg);
  const room = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 10), new THREE.MeshBasicNodeMaterial({ color: bg, side: THREE.BackSide }));
  room.position.y = 2;
  scene.add(room);
  for (const p of panels) {
    const c = new THREE.Color(p.color).multiplyScalar(p.intensity ?? 3);
    const m = new THREE.Mesh(new THREE.BoxGeometry(...p.size), new THREE.MeshBasicNodeMaterial({ color: c }));
    m.position.set(...p.pos);
    scene.add(m);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.03).texture;
  pmrem.dispose();
  return tex;
}
