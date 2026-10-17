// WebGPU renderer (automatic WebGL2 fallback) + post chain (selective bloom on emissive,
// vignette, grain, FXAA when MSAA is off). Resolution and bloom are set from outside by the
// quality governor (see quality.ts).

import * as THREE from "three/webgpu";
import { pass, mrt, output, emissive, uniform, vec4, vec3, screenUV, float, time, vec2, mix, fract, sin, dot, step, smoothstep, renderOutput } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";

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
    // adaptive resolution never goes below this: lower looked blurry ("fuzzy")
    minDpr: Math.min(native, tier === "low" ? 0.6 : tier === "mid" ? 1.0 : 1.2),
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
  /** 4x MSAA on (else FXAA) */
  msaa: boolean;
  /** last measured GPU time per frame in ms (-1 when the browser can't measure it) */
  gpuMs: number;
  render(): void;
  resize(): void;
  /** Change the render pixel ratio (render targets are reallocated). */
  setDpr(dpr: number): void;
  /** Bloom resolution scale (0 = fade bloom out). */
  setBloom(scale: number): void;
  /** Show a different scene (level switch: just swaps what the main pass draws). */
  setScene(scene: THREE.Scene): void;
  /**
   * Compile every pipeline `scene` needs for the main pass up front (all objects, on screen or
   * not, visible or hidden), so the first time something comes into view doesn't stall the GPU
   * on a shader compile. Yields between objects; reports 0..1 progress. `paced`: only compile
   * in the idle time between frames (for compiles that run while the room is on screen). With
   * `gate`, waits before each object until it returns true (pausing while you interact).
   */
  precompile(scene: THREE.Scene, onProgress?: (k: number) => void, opts?: { parallel?: number; visibleOnly?: boolean; paced?: boolean; gate?: () => boolean }): Promise<void>;
  /** Someone is now waiting on the compile in progress: full speed, more parallelism. */
  boostCompile(parallel?: number): void;
  /** A compile is running at full speed (not paced to idle time): frame times say little now. */
  readonly compilingUnpaced: boolean;
  /** A render target that matches the main pass (formats, MRT, samples) so it reuses its pipelines. */
  matchingTarget(w: number, h: number): THREE.RenderTarget;
  /**
   * Render `scene` from `cam` into a matchingTarget() exactly the way the main pass renders
   * (same MRT, same render context): reuses the main pass's node builds and GPU pipelines.
   */
  renderTo(scene: THREE.Scene, cam: THREE.Camera, rt: THREE.RenderTarget): void;
}

export interface EngineOptions {
  msaa?: boolean;
  dpr?: number;
  bloom?: number;
  /** measure GPU time per frame with timestamp queries where supported */
  timestamps?: boolean;
}

/**
 * Wait until there are at least `ms` of idle time left before the next frame (shared across
 * callers: several objects fit in one long idle period). Without requestIdleCallback (Safari):
 * just after a frame, assuming ~8 ms. Never waits more than ~0.2 s, so work always progresses.
 */
let idleDeadline: { timeRemaining(): number } | null = null;
async function idleSlot(ms: number) {
  if (idleDeadline && idleDeadline.timeRemaining() >= ms) return;
  const ric = (window as any).requestIdleCallback as ((cb: (d: { timeRemaining(): number; didTimeout: boolean }) => void, o: { timeout: number }) => void) | undefined;
  idleDeadline = await new Promise((r) => {
    if (ric) ric((d) => r(d.didTimeout ? { timeRemaining: () => 0 } : d), { timeout: 200 });
    else
      requestAnimationFrame(() =>
        setTimeout(() => {
          const end = performance.now() + 8;
          r({ timeRemaining: () => Math.max(0, end - performance.now()) });
        }, 0),
      );
  });
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

export async function createEngine(canvas: HTMLCanvasElement, opts: EngineOptions = {}): Promise<Engine> {
  polyfillSchedulerYield();
  const params = new URLSearchParams(location.search);
  const quality = detectQuality();
  const msaa = opts.msaa ?? true;
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: msaa,
    powerPreference: "high-performance",
    forceWebGL: params.has("webgl"),
    trackTimestamp: !!opts.timestamps,
  } as any);
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
  // bloom "off" fades it out and shrinks its passes to almost nothing (no graph changes, so no
  // shader recompiles when the quality governor toggles it)
  const bloomMix = uniform(opts.bloom === 0 ? 0 : 1);
  let bloomGoal = bloomMix.value as number;
  bloomPass.setResolutionScale(Math.max(0.08, opts.bloom ?? 0.25));

  // CRT power-off between worlds: the picture squashes to a bright line, then to a dot
  const k1 = post.crt.div(0.55).clamp(0, 1);
  const k2 = post.crt.sub(0.55).div(0.45).clamp(0, 1);
  const sy = mix(float(1), float(0.004), k1.pow(0.6));
  const sx = mix(float(1), float(0.006), k2.pow(0.8));
  const q = screenUV.sub(0.5).div(vec2(sx, sy)).add(0.5);
  const inside = step(0, q.x).mul(step(q.x, 1)).mul(step(0, q.y)).mul(step(q.y, 1));
  const sceneC = color.sample(q);
  const bloomC = (bloomPass as any).getTextureNode().sample(q).mul(bloomMix);
  // Vignette + film grain + flash/fade, applied in linear space before tone mapping
  const d = screenUV.sub(0.5).length();
  const vig = float(1).sub(d.mul(d).mul(post.vignette).mul(2.2)).clamp(0, 1);
  const g = fract(sin(dot(screenUV.add(fract(time.mul(0.37))), vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5).mul(post.grain);
  const glowLine = float(1).add(post.crt.mul(6));
  const dotGlow = smoothstep(0.06, 0.0, screenUV.sub(0.5).mul(vec2(1.6, 1)).length()).mul(k2).mul(float(1).sub(k2.pow(4))).mul(2);
  const composed = sceneC.add(bloomC).mul(vig).mul(glowLine).mul(inside).add(g).add(vec3(dotGlow));
  const flashed = composed.add(post.flash);
  const final = vec4(mix(flashed.rgb, vec4(0, 0, 0, 1).rgb, post.fade.max(post.crt.greaterThan(0.995).select(float(1), float(0)))), 1);
  if (msaa) pipeline.outputNode = final;
  else {
    // no MSAA: tone map + encode first, then FXAA on the final image (cheap, one extra pass)
    pipeline.outputColorTransform = false;
    pipeline.outputNode = fxaa(renderOutput(final));
  }

  let dpr = Math.max(0.5, Math.min(3, opts.dpr ?? Math.min(window.devicePixelRatio || 1, 1.5)));
  // GPU time: resolve timestamp queries in the background, averaged over the frames they cover
  let gpuMs = -1, resolving = false, framesSince = 0;
  const timing = !!opts.timestamps && !!(renderer.backend as any).trackTimestamp;
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
    msaa,
    get gpuMs() {
      return gpuMs;
    },
    render() {
      const b = bloomMix.value as number;
      if (b !== bloomGoal) bloomMix.value = b + Math.sign(bloomGoal - b) * Math.min(Math.abs(bloomGoal - b), 0.03);
      pipeline.render();
      if (timing) {
        framesSince++;
        if (!resolving) {
          resolving = true;
          framesSince = 0;
          renderer
            .resolveTimestampsAsync("render")
            .then((ms) => {
              // (three reports the most recent frame's passes)
              if (typeof ms === "number" && ms > 0) gpuMs = ms;
            })
            .catch(() => {})
            .finally(() => (resolving = false));
        }
      }
    },
    setDpr(next) {
      if (Math.abs(next - dpr) < 0.01) return;
      dpr = next;
      engine.resize();
    },
    setBloom(scale) {
      bloomGoal = scale > 0 ? 1 : 0;
      bloomPass.setResolutionScale(Math.max(0.08, scale));
    },
    resize() {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
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
      compilingScenes.add(s);
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
      if (opts.paced || opts.gate) gates.set(s, opts.gate ?? (() => true));
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
      gates.delete(s);
      compilingScenes.delete(s);
      if (--compiling === 0) {
        renderer.setRenderTarget(null);
        renderer.setMRT(null);
      }
    },
    get compilingUnpaced() {
      for (const c of compilingScenes) if (!gates.has(c)) return true;
      return false;
    },
    boostCompile(parallel = 4) {
      gates.clear(); // (no more pausing or pacing: someone is waiting)
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
      if (!promises) return getForRender.call(pipes, ro, pipes.__sync ? null : []); // render path: async, never stall (except isolated renders, below)
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
  // Paced / gated compiles (precompile's `paced` and `gate`). compileAsync builds each object's
  // shaders through getForRenderAsync (nothing else calls it), so such a scene waits there before
  // each object: for its gate, then for idle time between frames. Left alone, compileAsync's own
  // yields (scheduler.yield) run ahead of rendering, so a long compile on screen got frames
  // through only every 50-100 ms (Chrome's render-starvation limit) even though no single task
  // was long.
  const gates = new Map<THREE.Object3D, () => boolean>();
  const compilingScenes = new Set<THREE.Object3D>();
  {
    const nodes = (renderer as any)._nodes;
    const getAsync = nodes.getForRenderAsync;
    nodes.getForRenderAsync = async function (ro: any) {
      const may = gates.get(ro.scene);
      if (may)
        for (;;) {
          if (!may()) {
            await new Promise((r) => setTimeout(r, 250));
            continue;
          }
          await idleSlot(8);
          if (may()) break;
        }
      return getAsync.call(nodes, ro);
    };
  }
  // One-shot offscreen renders (environment maps: PMREMGenerator.fromScene) are drawn once and
  // never again, so they can't skip objects whose pipeline is still compiling, and they need the
  // renderer's own state, not a compile's main-pass MRT / target (an environment generated during
  // a compile got shaders with no outputs). Few pipelines, created the first time only.
  (renderer as any).__isolated = <T>(fn: () => T): T => {
    const rt = renderer.getRenderTarget(), m = renderer.getMRT();
    renderer.setRenderTarget(null);
    renderer.setMRT(null);
    pipes.__sync = (pipes.__sync ?? 0) + 1;
    try {
      return fn();
    } finally {
      pipes.__sync--;
      renderer.setRenderTarget(rt);
      renderer.setMRT(m);
    }
  };
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
  const draw = engine.render; // bloom fade + pipeline.render + GPU timing
  engine.render = () => {
    rendered = true;
    if (compiling) {
      const rt = renderer.getRenderTarget(), m = renderer.getMRT();
      renderer.setRenderTarget(null);
      renderer.setMRT(null);
      draw();
      renderer.setRenderTarget(rt);
      renderer.setMRT(m);
    } else draw();
  };

  engine.resize();
  window.addEventListener("resize", () => engine.resize());
  return engine;
}
