// Showroom: a test bench that lines up one game of every form factor face-out and a run of
// spines, under neutral studio light. Handy for iterating on templates and materials.

import * as THREE from "three/webgpu";
import type { Game } from "../../shared/types";
import type { MediaKind } from "../../shared/platforms";
import { wallRail } from "../engine/rail";
import { MediaField, kindOf, type Placement } from "../media/field";
import { TEMPLATES } from "../media/templates";
import type { Level, LevelCtx } from "./types";

export default function showroom(): Level {
  let ctx: LevelCtx;
  const fields: MediaField[] = [];
  const level: Level = {
    id: "showroom",
    name: "Showroom",
    tagline: "Test bench",
    stations: [],
    fields,
    async build(c) {
      ctx = c;
      const { scene, art, store } = c;
      scene.background = new THREE.Color(0x1a1c22);
      const env = new THREE.PMREMGenerator(c.engine.renderer);
      const { RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js");
      scene.environment = env.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.8;
      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(1, 2, 2);
      scene.add(key, new THREE.AmbientLight(0xffffff, 0.3));
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardNodeMaterial({ color: 0x2a2d35, roughness: 0.6 }));
      floor.rotation.x = -Math.PI / 2;
      scene.add(floor);

      // one of each kind, face-out, on the floor line
      const seen = new Map<MediaKind, Game>();
      for (const g of store.games) {
        const k = kindOf(g, art);
        if (!seen.has(k) && art.has(g) && g.status !== "wishlist") seen.set(k, g);
      }
      const placements: Placement[] = [];
      let x = 0;
      for (const [k, g] of seen) {
        const t = TEMPLATES[k];
        placements.push({ game: g, position: new THREE.Vector3(x + t.size[0] / 2, 0.2, 0), quaternion: new THREE.Quaternion() });
        x += t.size[0] + 0.04;
      }
      // a shelf run of spines behind
      let sx = 0;
      const spineRun = store.games.filter((g) => g.status !== "wishlist" && TEMPLATES[kindOf(g, art)].spine && !TEMPLATES[kindOf(g, art)].faceOut).slice(0, 120);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
      for (const g of spineRun) {
        const t = TEMPLATES[kindOf(g, art)];
        placements.push({ game: g, position: new THREE.Vector3(sx + t.size[2] / 2, 0.55, -0.3), quaternion: q });
        sx += t.size[2] + 0.001;
        if (sx > x) break;
      }
      const field = new MediaField(c.kit, placements, { name: "showroom" });
      scene.add(field.group);
      fields.push(field);
      // a few wishlist holograms
      const wish = store.games.filter((g) => g.status === "wishlist").slice(0, 8);
      const holo = new MediaField(
        c.kit,
        wish.map((g, i) => ({ game: g, position: new THREE.Vector3(i * 0.16 + 0.08, 0.85, -0.3), quaternion: new THREE.Quaternion() })),
        { holo: true, name: "holo" },
      );
      scene.add(holo.group);
      fields.push(holo);

      const rail = wallRail(
        [
          [-0.2, 0.05],
          [x + 0.2, 0.05],
        ],
        { h: [0.2, 1.0], d: [0.25, 2.5], h0: 0.4, d0: 0.9 },
      );
      // viewer must be on +z side: flip normals if needed
      if (rail.normals[0].z < 0) rail.normals.forEach((n) => n.negate());
      c.rig.setRail(rail, { s: rail.length / 2 });
    },
    update() {},
    focusGame(g) {
      const p = fields.map((f) => f.centerOf(g.id)).find(Boolean);
      if (p) ctx.rig.goTo({ s: ctx.rig.rail!.project(p), h: p.y, d: 0.6 });
    },
    dispose() {
      fields.forEach((f) => f.dispose());
    },
  };
  return level;
}
