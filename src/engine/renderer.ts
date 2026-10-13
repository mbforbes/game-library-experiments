// WebGPU renderer (automatic WebGL2 fallback) + post chain (selective bloom on emissive,
// vignette, grain) + adaptive resolution that keeps frame time on budget.

import * as THREE from "three/webgpu";
import { pass, mrt, output, emissive, uniform, vec4, vec3, screenUV, float, time, vec2, mix, fract, sin, dot, step, smoothstep } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

export interface Quality {
  tier: "low" | "mid" | "high";
  mobile: boolean;
  maxDpr: number;
  minDpr: number;
}

export function detectQuality(): Quality {
  const params = new URLSearchParams(location.search);
  const mobile = matchMedia("(pointer: coarse)").matches || /iPhone|iPad|Android/i.test(navigator.userAgent);
  const forced = params.get("quality") as Quality["tier"] | null;
  const tier: Quality["tier"] = forced ?? (mobile ? "mid" : "high");
  const native = window.devicePixelRatio || 1;
  return {
    tier,
    mobile,
    maxDpr: Math.min(native, tier === "low" ? 1 : tier === "mid" ? 2 : 2),
    minDpr: Math.min(native, tier === "low" ? 0.6 : 0.75),
  };
}

export interface Engine {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  pipeline: THREE.RenderPipeline;
  backend: "webgpu" | "webgl";
  quality: Quality;
  /** Post uniforms (TSL uniform nodes; set `.value`). flash = full-screen flash, fade = 0 visible .. 1 black */
  post: Record<"bloomStrength" | "bloomRadius" | "bloomThreshold" | "vignette" | "grain" | "flash" | "fade" | "crt", any>;
  dpr: number;
  render(): void;
  resize(): void;
  /** called every frame with the frame's dt (s) to adapt pixel ratio */
  adapt(dt: number): void;
}

export async function createEngine(canvas: HTMLCanvasElement): Promise<Engine> {
  const params = new URLSearchParams(location.search);
  const quality = detectQuality();
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: quality.tier !== "low",
    powerPreference: "high-performance",
    forceWebGL: params.has("webgl"),
  });
  await renderer.init();
  const backend = (renderer.backend as any).isWebGPUBackend ? "webgpu" : "webgl";
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 400);

  const post = {
    bloomStrength: uniform(1.1),
    bloomRadius: uniform(0.55),
    bloomThreshold: uniform(0.0),
    vignette: uniform(0.35),
    grain: uniform(0.035),
    flash: uniform(0),
    fade: uniform(0),
    crt: uniform(0), // 0 = picture on, 1 = CRT switched off (squashed to a line, then a dot)
  };

  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, emissive }));
  const color = scenePass.getTextureNode("output");
  const glow = scenePass.getTextureNode("emissive");
  const bloomPass = bloom(glow, post.bloomStrength as any, post.bloomRadius as any, post.bloomThreshold as any);
  if (quality.mobile) bloomPass.setResolutionScale(0.35);

  // CRT power-off between worlds: the picture squashes to a bright line, then to a dot
  const k1 = post.crt.div(0.55).clamp(0, 1);
  const k2 = post.crt.sub(0.55).div(0.45).clamp(0, 1);
  const sy = mix(float(1), float(0.004), k1.pow(0.6));
  const sx = mix(float(1), float(0.006), k2.pow(0.8));
  const q = screenUV.sub(0.5).div(vec2(sx, sy)).add(0.5);
  const inside = step(0, q.x).mul(step(q.x, 1)).mul(step(0, q.y)).mul(step(q.y, 1));
  const sceneC = color.sample(q);
  const bloomC = (bloomPass as any).getTextureNode().sample(q);
  // Vignette + film grain + flash/fade, applied in linear space before tone mapping
  const d = screenUV.sub(0.5).length();
  const vig = float(1).sub(d.mul(d).mul(post.vignette).mul(2.2)).clamp(0, 1);
  const g = fract(sin(dot(screenUV.add(fract(time.mul(0.37))), vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5).mul(post.grain);
  const glowLine = float(1).add(post.crt.mul(6));
  const dotGlow = smoothstep(0.06, 0.0, screenUV.sub(0.5).mul(vec2(1.6, 1)).length()).mul(k2).mul(float(1).sub(k2.pow(4))).mul(2);
  const composed = sceneC.add(bloomC).mul(vig).mul(glowLine).mul(inside).add(g).add(vec3(dotGlow));
  const flashed = composed.add(post.flash);
  pipeline.outputNode = vec4(mix(flashed.rgb, vec4(0, 0, 0, 1).rgb, post.fade.max(post.crt.greaterThan(0.995).select(float(1), float(0)))), 1);

  let dpr = quality.maxDpr;
  const engine: Engine = {
    renderer,
    scene,
    camera,
    pipeline,
    backend,
    quality,
    post,
    get dpr() {
      return dpr;
    },
    render() {
      pipeline.render();
    },
    resize() {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    adapt: makeAdaptor(),
  };

  function makeAdaptor() {
    // Average frame time over ~1.5s windows; step the pixel ratio down when slow, up when fast.
    let acc = 0, n = 0, cooldown = 2.5;
    const fixed = params.has("dpr");
    if (fixed) dpr = Math.max(0.5, Math.min(3, parseFloat(params.get("dpr")!)));
    return (dt: number) => {
      if (fixed) return;
      cooldown -= dt;
      acc += dt;
      n++;
      if (acc < 1.5) return;
      const avg = acc / n;
      acc = 0;
      n = 0;
      if (cooldown > 0) return;
      let next = dpr;
      if (avg > 1 / 45) next = Math.max(quality.minDpr, dpr * 0.85);
      else if (avg < 1 / 58 && dpr < quality.maxDpr) next = Math.min(quality.maxDpr, dpr * 1.1);
      if (Math.abs(next - dpr) > 0.01) {
        dpr = next;
        engine.resize();
        cooldown = 3;
      }
    };
  }

  engine.resize();
  window.addEventListener("resize", () => engine.resize());
  return engine;
}
