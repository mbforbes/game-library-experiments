// One shared node material paints every game in the library: shell plastic (incl. special
// metallic/coloured shells), printed cover or real cartridge photo (from the atlas, per-instance
// crop / contain-fit with alpha), printed or real scanned spine, glowing edges, plus per-instance
// highlight / dim state. A hologram variant renders wishlist "ghost" games.
//
// Per-instance attributes (one interleaved buffer):
//   iCover  (u, v, w, h)                     atlas rect of the front image
//   iSpine  (u, v, w, h)                     spine rect (runtime canvas or real-spine atlas)
//   iColor  (r, g, b, coverPage)
//   iGlow   (r, g, b, glowIntensity)
//   iState  (roughness, highlight, dim, selfGlow)
//   iExtra  (spinePage, padX, padY, metalness)   spinePage 0 = runtime canvas; padX >= 0 = photo mode

import * as THREE from "three/webgpu";
import { attribute, texture, uv, vec2, vec3, float, select, mix, normalView, positionViewDirection, time, positionWorld, sin, dot, max, step } from "three/tsl";

function sampleCover(pages: THREE.Texture[]) {
  const iCover = attribute("iCover", "vec4");
  const iColor = attribute("iColor", "vec4");
  const iExtra = attribute("iExtra", "vec4");
  const u = uv();
  // photo mode: contain-fit the photo inside the front quad; outside it is transparent
  const photo = iExtra.y.greaterThanEqual(0);
  const pad = vec2(iExtra.y.max(0), iExtra.z.max(0));
  const p = u.sub(pad).div(vec2(1, 1).sub(pad.mul(2)));
  const inside = step(0, p.x).mul(step(p.x, 1)).mul(step(0, p.y)).mul(step(p.y, 1));
  const q = select(photo, p.clamp(0.001, 0.999), u);
  const cuv = iCover.xy.add(vec2(q.x, q.y.oneMinus()).mul(iCover.zw));
  let cover: any = texture(pages[0], cuv);
  for (let k = 1; k < pages.length; k++) cover = select(iColor.w.greaterThan(k - 0.5), texture(pages[k], cuv), cover);
  const alpha = select(photo, cover.a.mul(inside), float(1));
  return { cover, alpha };
}

function parts() {
  const part = attribute("part", "float");
  const between = (a: number, b: number) => part.greaterThan(a).and(part.lessThan(b));
  return {
    isShell: part.lessThan(0.5),
    isCover: between(0.5, 1.5),
    isSpine: between(1.5, 2.5),
    isBack: between(2.5, 3.5),
    isGlow: between(4.5, 5.5),
    isDark: between(5.5, 6.5),
  };
}

export function makeMediaMaterial(pages: THREE.Texture[], spineTex: THREE.Texture, spinePages: THREE.Texture[] = []): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.alphaTest = 0.5; // photo-mode cartridges are cut-outs
  const iSpine = attribute("iSpine", "vec4");
  const iColor = attribute("iColor", "vec4");
  const iGlow = attribute("iGlow", "vec4");
  const iState = attribute("iState", "vec4"); // x roughness, y highlight, z dim, w self-glow (slabs/cabinets)
  const iExtra = attribute("iExtra", "vec4");
  const { isShell, isCover, isSpine, isBack, isGlow, isDark } = parts();
  const { cover, alpha } = sampleCover(pages);
  const u = uv();
  const suv = iSpine.xy.add(vec2(u.x, u.y.oneMinus()).mul(iSpine.zw));
  let spine: any = texture(spineTex, suv);
  spinePages.forEach((t, k) => {
    spine = select(iExtra.x.greaterThan(k + 0.5), texture(t, suv), spine);
  });
  const hasSpine = iSpine.z.greaterThan(0);
  const shell = iColor.rgb;

  let col: any = shell;
  col = select(isBack, shell.mul(0.6), col);
  col = select(isCover, cover.rgb, col);
  col = select(isSpine, select(hasSpine, spine.rgb, shell), col);
  col = select(isDark, vec3(0.015), col);
  col = select(isGlow, vec3(0.012, 0.014, 0.018), col);

  const dim = iState.z;
  const lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum).mul(0.18), dim.mul(0.88));
  mat.colorNode = col;
  mat.opacityNode = select(isCover, alpha, float(1));

  mat.roughnessNode = select(isCover, float(0.3), select(isSpine, float(0.4), select(isGlow, float(0.08), iState.x)));
  mat.metalnessNode = select(isShell.or(isBack), iExtra.w, float(0));

  const rim = float(1).sub(normalView.dot(positionViewDirection).abs()).pow(2.0);
  const hl = iState.y;
  const self = iState.w.mul(float(1).sub(dim.mul(0.8)));
  let glow: any = iGlow.rgb.mul(select(isGlow, iGlow.w.mul(1.6), float(0)));
  glow = glow.add(select(isSpine, spine.rgb.mul(self), vec3(0)));
  glow = glow.add(select(isCover, cover.rgb.mul(self.mul(0.12)), vec3(0)));
  glow = glow.add(iGlow.rgb.mul(hl.mul(rim.mul(1.4).add(0.12))));
  mat.emissiveNode = glow;
  return mat;
}

/** Holographic "not owned yet" material for wishlist games. */
export function makeHoloMaterial(pages: THREE.Texture[]): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.AdditiveBlending;
  const iGlow = attribute("iGlow", "vec4");
  const iState = attribute("iState", "vec4");
  const { isCover } = parts();
  const { cover, alpha } = sampleCover(pages);
  const tint = iGlow.rgb;
  const scan = sin(positionWorld.y.mul(900).sub(time.mul(6))).mul(0.5).add(0.5).pow(3);
  const flicker = sin(time.mul(23).add(positionWorld.x.mul(40))).mul(0.06).add(0.94);
  const rim = float(1).sub(normalView.dot(positionViewDirection).abs()).pow(1.6);
  const coverLum = max(cover.r, max(cover.g, cover.b));
  const art = mix(tint.mul(coverLum), cover.rgb, 0.45).mul(1.1).mul(alpha);
  const body = select(isCover, art, tint.mul(0.08));
  const c = body.add(tint.mul(rim.mul(0.9))).add(tint.mul(scan.mul(0.12))).mul(flicker);
  const dim = float(1).sub(iState.z.mul(0.85));
  mat.colorNode = vec3(0);
  mat.roughnessNode = float(1);
  mat.emissiveNode = c.mul(dim).mul(iState.y.mul(0.8).add(1));
  mat.opacityNode = float(0.9);
  return mat;
}
