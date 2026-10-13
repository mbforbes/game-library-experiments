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
  /** The scene currently on screen (each level owns its own Scene; see setScene). */
  scene: THREE.Scene;
  /** Main pass MRT (output + emissive). Render targets that reuse it share the main pass's GPU pipelines. */
  mrt: any;
  camera: THREE.PerspectiveCamera;
  pipeline: THREE.RenderPipeline;
  backend: "webgpu" | "webgl";
  quality: Quality;
  /** Post uniforms (TSL uniform nodes; set `.value`). flash = full-screen flash, fade = 0 visible .. 1 black */
  post: Record<"bloomStrength" | "bloomRadius" | "bloomThreshold" | "vignette" | "grain" | "flash" | "fade" | "crt" | "exposure", any>;
  dpr: number;
  render(): void;
  resize(): void;
  /** Show a different scene (level switch: just swaps what the main pass draws). */
  setScene(scene: THREE.Scene): void;
  /**
   * Compile every pipeline `scene` needs for the main pass up front (all objects, on screen or
   * not, visible or hidden), so the first time something comes into view doesn't stall the GPU
   * on a shader compile. Yields between objects; reports 0..1 progress.
   */
  precompile(scene: THREE.Scene, onProgress?: (k: number) => void, opts?: { parallel?: number; visibleOnly?: boolean }): Promise<void>;
  /** Someone is now waiting on the compile in progress: let it use more parallelism. */
  boostCompile(parallel?: number): void;
  /** A render target that matches the main pass (formats, MRT, samples) so it reuses its pipelines. */
  matchingTarget(w: number, h: number): THREE.RenderTarget;
  /**
   * Render `scene` from `cam` into a matchingTarget() exactly the way the main pass renders
   * (same MRT, same render context): reuses the main pass's node builds and GPU pipelines.
   */
  renderTo(scene: THREE.Scene, cam: THREE.Camera, rt: THREE.RenderTarget): void;
  /** called every frame with the frame's dt (s) to adapt pixel ratio */
  adapt(dt: number): void;
}

/**
 * three's compileAsync yields between objects with scheduler.yield(), or a whole animation frame
 * per object where that's missing (Safari): ~16 ms × hundreds of objects. A message-channel
 * yield gives the same "let the browser breathe" without the frame-sized wait.
 */
function polyfillSchedulerYield() {
  const g = globalThis as any;
  if (g.scheduler?.yield) return;
  const ch = new MessageChannel();
  const queue: (() => void)[] = [];
  ch.port1.onmessage = () => queue.shift()?.();
  g.scheduler = Object.assign(g.scheduler ?? {}, {
    yield: () =>
      new Promise<void>((r) => {
        queue.push(r);
        ch.port2.postMessage(0);
      }),
  });
}

export async function createEngine(canvas: HTMLCanvasElement): Promise<Engine> {
  polyfillSchedulerYield();
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
    grain: uniform(0.018),
    flash: uniform(0),
    fade: uniform(0),
    crt: uniform(0), // 0 = picture on, 1 = CRT switched off (squashed to a line, then a dot)
    exposure: { value: 1 }, // tone-mapping exposure (applied to the renderer by the app each frame)
  };

  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const mainMrt = mrt({ output, emissive });
  scenePass.setMRT(mainMrt);
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
    mrt: mainMrt,
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
    setScene(s) {
      engine.scene = s;
      scenePass.scene = s;
    },
    async precompile(s, onProgress, opts = {}) {
      // the pass's render target only gets its final sample count / type once the pipeline has run
      if (!rendered) engine.render();
      const restore: (() => void)[] = [];
      if (!opts.visibleOnly)
        s.traverse((o) => {
          // (lights stay as they are: the light set is part of every lit shader)
          if (!o.visible && !(o as THREE.Light).isLight) {
            o.visible = true;
            restore.push(() => (o.visible = false));
          }
          if (o.frustumCulled) {
            o.frustumCulled = false;
            restore.push(() => (o.frustumCulled = true));
          }
        });
      // Shaders are built object by object (yielding between them) and read the renderer's MRT /
      // target when they are, so those stay set until the compile finishes; frames rendered
      // meanwhile run with a clean state (see render()). Overlapping compiles share the state.
      if (compiling++ === 0) {
        renderer.setRenderTarget((scenePass as any).renderTarget);
        renderer.setMRT(mainMrt);
      }
      // Render objects are keyed by render context, and contexts by call depth: the scene pass
      // renders nested inside the post quad, so compile in a context with the same depth or
      // every object gets its nodes built a second time when it's first drawn.
      const rc = (renderer as any)._renderContexts;
      const get = rc.get;
      rc.get = (rt: any, m: any, depth?: number) => get.call(rc, rt, m, depth ?? passDepth);
      const pending: Promise<unknown>[] = [];
      const prevCollect = pipes.__collect;
      pipes.__collect = { list: pending, limit: Math.max(1, opts.parallel ?? 4) };
      let job: Promise<void>;
      try {
        job = renderer.compileAsync(s, camera, null, onProgress ? (e: ProgressEvent) => onProgress(e.loaded / Math.max(1, e.total)) : null);
      } finally {
        // the render list was collected synchronously: visibility / culling can go back now
        rc.get = get;
        for (const r of restore) r();
      }
      await job.catch((err) => console.warn("[engine] precompile", err));
      pipes.__collect = prevCollect;
      await Promise.allSettled(pending);
      if (--compiling === 0) {
        renderer.setRenderTarget(null);
        renderer.setMRT(null);
      }
    },
    boostCompile(parallel = 4) {
      if (pipes.__collect) pipes.__collect.limit = Math.max(pipes.__collect.limit, parallel);
    },
    matchingTarget(w, h) {
      // same as PassNode.setup(): renderer's sample count + output buffer type, one attachment
      // per MRT output, named after it (MRT outputs are matched to attachments by name)
      const names = Object.keys((mainMrt as any).outputNodes);
      const rt = new THREE.RenderTarget(w, h, { count: names.length, type: renderer.getOutputBufferType(), samples: renderer.samples, depthBuffer: true });
      names.forEach((n, i) => (rt.textures[i].name = n));
      return rt;
    },
    renderTo(s, cam, rt) {
      const rc = (renderer as any)._renderContexts;
      const get = rc.get;
      rc.get = (t: any, m: any, depth?: number) => get.call(rc, t, m, t === rt ? passDepth : depth);
      const prevMrt = renderer.getMRT(), prevRt = renderer.getRenderTarget();
      try {
        renderer.setRenderTarget(rt);
        renderer.setMRT(mainMrt);
        renderer.render(s, cam);
      } finally {
        renderer.setMRT(prevMrt);
        renderer.setRenderTarget(prevRt);
        rc.get = get;
      }
    },
  };
  let rendered = false;
  let compiling = 0;
  // GPU pipelines are never created synchronously: a pipeline the frame needs that isn't ready
  // is requested asynchronously and its objects are simply not drawn until it is (three skips
  // objects whose pipeline isn't ready). A cold shader cache makes each compile cost 0.2-4 s;
  // a synchronous one froze the whole frame for that long. During precompiles up to `limit`
  // compile at once (beyond that compileAsync waits for the newest, as it normally would):
  // flooding Metal's compiler starves Chrome's own drawing, so background work uses 1-2.
  const pipes = (renderer as any)._pipelines;
  {
    const getForRender = pipes.getForRender;
    const inflight = new Set<Promise<unknown>>();
    pipes.getForRender = function (ro: any, promises: any[] | null = null) {
      const c = pipes.__collect as { list: Promise<unknown>[]; limit: number } | undefined;
      if (!promises) return getForRender.call(pipes, ro, []); // render path: async, never stall
      if (!c) return getForRender.call(pipes, ro, promises);
      const mine: Promise<unknown>[] = [];
      const r = getForRender.call(pipes, ro, mine);
      for (const p of mine) {
        inflight.add(p);
        p.finally(() => inflight.delete(p));
        c.list.push(p);
        if (inflight.size >= c.limit) promises.push(p);
      }
      return r;
    };
  }
  // learn the call depth the scene pass renders at (see precompile)
  let passDepth = 1;
  {
    const rc = (renderer as any)._renderContexts;
    const get = rc.get;
    rc.get = (rt: any, m: any, depth?: number) => {
      if (rt && rt === (scenePass as any).renderTarget && m === mainMrt && depth !== undefined) {
        passDepth = depth;
        rc.get = get;
      }
      return get.call(rc, rt, m, depth);
    };
  }
  engine.render = () => {
    rendered = true;
    if (compiling) {
      const rt = renderer.getRenderTarget(), m = renderer.getMRT();
      renderer.setRenderTarget(null);
      renderer.setMRT(null);
      pipeline.render();
      renderer.setRenderTarget(rt);
      renderer.setMRT(m);
    } else pipeline.render();
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
