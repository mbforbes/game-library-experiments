// One shared node material paints every game in the library: shell plastic, printed cover
// (from the atlas, per-instance crop), printed spine (spine atlas), glowing edges, plus
// per-instance highlight / dim state. A hologram variant renders wishlist "ghost" games.

import * as THREE from "three/webgpu";
import { attribute, texture, uv, vec2, vec3, float, select, mix, normalView, positionViewDirection, time, positionWorld, sin, dot, max } from "three/tsl";

function sampleCover(pages: THREE.Texture[]) {
  const iCover = attribute("iCover", "vec4");
  const iColor = attribute("iColor", "vec4");
  const u = uv();
  const cuv = iCover.xy.add(vec2(u.x, u.y.oneMinus()).mul(iCover.zw));
  let cover: any = texture(pages[0], cuv);
  for (let k = 1; k < pages.length; k++) cover = select(iColor.w.greaterThan(k - 0.5), texture(pages[k], cuv), cover);
  return cover;
}

function parts() {
  const part = attribute("part", "float");
  const between = (a: number, b: number) => part.greaterThan(a).and(part.lessThan(b));
  return {
    isCover: between(0.5, 1.5),
    isSpine: between(1.5, 2.5),
    isBack: between(2.5, 3.5),
    isGlow: between(4.5, 5.5),
    isDark: between(5.5, 6.5),
  };
}

export function makeMediaMaterial(pages: THREE.Texture[], spineTex: THREE.Texture): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const iSpine = attribute("iSpine", "vec4");
  const iColor = attribute("iColor", "vec4");
  const iGlow = attribute("iGlow", "vec4");
  const iState = attribute("iState", "vec4"); // x roughness, y highlight, z dim, w self-glow (slabs/cabinets)
  const { isCover, isSpine, isBack, isGlow, isDark } = parts();
  const cover = sampleCover(pages);
  const u = uv();
  const suv = iSpine.xy.add(vec2(u.x, u.y.oneMinus()).mul(iSpine.zw));
  const spine = texture(spineTex, suv);
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

  mat.roughnessNode = select(isCover, float(0.3), select(isSpine, float(0.4), select(isGlow, float(0.08), iState.x)));
  mat.metalnessNode = float(0);

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
  const cover = sampleCover(pages);
  const tint = iGlow.rgb;
  const scan = sin(positionWorld.y.mul(900).sub(time.mul(6))).mul(0.5).add(0.5).pow(3);
  const flicker = sin(time.mul(23).add(positionWorld.x.mul(40))).mul(0.06).add(0.94);
  const rim = float(1).sub(normalView.dot(positionViewDirection).abs()).pow(1.6);
  const coverLum = max(cover.r, max(cover.g, cover.b));
  const art = mix(tint.mul(coverLum), cover.rgb, 0.45).mul(1.1);
  const body = select(isCover, art, tint.mul(0.08));
  const c = body.add(tint.mul(rim.mul(0.9))).add(tint.mul(scan.mul(0.12))).mul(flicker);
  const dim = float(1).sub(iState.z.mul(0.85));
  mat.colorNode = vec3(0);
  mat.roughnessNode = float(1);
  mat.emissiveNode = c.mul(dim).mul(iState.y.mul(0.8).add(1));
  mat.opacityNode = float(0.9);
  return mat;
}
