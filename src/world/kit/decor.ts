// Decor: framed posters of favourite games (hi-res cover art), lit by a small picture light.

import * as THREE from "three/webgpu";
import { texture, vec3, vec2, uv, uniform } from "three/tsl";
import type { Game } from "../../../shared/types";
import type { ArtStore } from "../../library/art";
import { boxes, neonMaterial } from "./common";

/** A framed poster of a game's cover. Front faces +Z; origin at the poster centre. */
export function poster(art: ArtStore, game: Game, height: number, frameColor = 0x111116, lightColor = "#ffd9a8") {
  const g = new THREE.Group();
  const aspectU = uniform(0.7);
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.35 });
  // art textures are uploaded unflipped (flipY = false): flip v here
  const t = texture(new THREE.Texture(), vec2(uv().x, uv().y.oneMinus()));
  mat.colorNode = t.rgb;
  mat.emissiveNode = t.rgb.mul(0.08);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  g.add(plane);
  const frameMat = new THREE.MeshStandardNodeMaterial({ color: frameColor, roughness: 0.4, metalness: 0.3 });
  const frame = new THREE.Mesh(new THREE.BufferGeometry(), frameMat);
  g.add(frame);
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.012, 0.03), neonMaterial(lightColor, 2.5));
  g.add(lamp);
  const layout = (aspect: number) => {
    aspectU.value = aspect;
    const w = height * aspect, h = height, f = 0.03;
    plane.scale.set(w, h, 1);
    plane.position.z = 0.012;
    frame.geometry.dispose();
    frame.geometry = boxes([
      [0, h / 2 + f / 2, 0, w + 2 * f, f, 0.03],
      [0, -h / 2 - f / 2, 0, w + 2 * f, f, 0.03],
      [-w / 2 - f / 2, 0, 0, f, h, 0.03],
      [w / 2 + f / 2, 0, 0, f, h, 0.03],
      [0, 0, -0.004, w, h, 0.01],
      // the picture light's bracket: a post on the frame's top and an arm out to the lamp (it hung in the air)
      [0, h / 2 + f + 0.0175, 0.008, 0.008, 0.035, 0.008],
      [0, h / 2 + f + 0.035, 0.035, 0.008, 0.008, 0.055],
    ]);
    lamp.position.set(0, h / 2 + f + 0.04, 0.06);
    lamp.scale.x = Math.max(0.6, w / 0.2 * 0.6);
  };
  layout(0.7);
  art.hiRes(game).then((tex) => {
    if (!tex) return;
    const img = tex.image as { width: number; height: number };
    t.value = tex;
    layout(img.width / img.height);
  });
  return g;
}

export { vec3 };
