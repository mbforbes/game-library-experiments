// ?diag: where a frame's time goes on this device, room by room, for a set of variants:
//   bloom      as normally shown (bloom on)
//   plain      bloom off (its passes don't run)
//   floor      bloom off, nothing in the room drawn (the per-frame overhead)
//   noGames    bloom off, the game boxes not drawn
//   halfLights bloom off, half the room's point lights off (every lit pixel adds each light up)
//   noEnv      bloom off, the game boxes without the environment's reflections
//   matte      bloom off, the game boxes shaded matte (Lambert: no specular), same lights
//   nearLight  bloom off, the game boxes lit by the hemisphere + their nearest point light only
//   allMatte   bloom off, everything in the room matte
//   unlit      bloom off, the game boxes without lighting (their colours unlit)
//   plainEnd   bloom off again, last (did conditions drift during the run?)
// Every wait on the GPU has a time limit: a stall is recorded (where it happened) and the run goes
// on; results are sent after each room, so a run that stops still reports what it measured.
// With &msaa=0 the whole run is without multisampling (FXAA instead), and with &webgl on WebGL 2
// instead of WebGPU (a frame is waited for with a 1-pixel read there), to compare.
// Each variant: after the change, every shader it needs is compiled and it runs a second at
// display pace; then two measurements:
//   ms    frames drawn back to back (two in flight), clocks up: the work a frame takes. Median of
//         three windows of ~0.8 s each.
//   paced at display pace, as when using the site: from a frame's submission until the GPU has
//         finished it (mean over ~1.5 s), at whatever clock speed the device chooses.
// `js` is the part spent in our code + the browser's WebGPU calls; `gpu` / `gpuPaced` the GPU's own
// time per frame (timestamps), flat out (clocks up) and at display pace (the device's choice of
// clock): what's the GPU's work as opposed to the browser's. Sent to /api/profile ("diag").

import * as THREE from "three/webgpu";
import { lights } from "three/tsl";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
class Stall extends Error {}
/** `p`, or a Stall after `ms` */
const guard = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, wait(ms).then(() => Promise.reject(new Stall(what)))]) as Promise<T>;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

export async function runDiag(app: any) {
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;left:12px;right:12px;bottom:84px;z-index:50;padding:12px 14px;border-radius:10px;background:rgba(8,9,14,.92);color:#e8eaf0;font:12px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap";
  document.body.appendChild(box);
  const say = (t: string) => (box.textContent = t);
  const e = app.engine, r = e.renderer as any, dev = r.backend.device as GPUDevice | undefined;
  const gl = r.backend.gl as WebGL2RenderingContext | undefined;
  if (!dev && !gl) return say("Diagnostic: no WebGPU or WebGL backend.");
  const px = new Uint8Array(4);
  let stage = "";
  /** wait until the GPU has finished everything submitted so far (at most 5 s) */
  const done = async () => {
    if (dev) await guard(dev.queue.onSubmittedWorkDone(), 5000, `GPU work not done (${stage})`);
    else gl!.readPixels(0, 0, 1, 1, gl!.RGBA, gl!.UNSIGNED_BYTE, px);
  };
  app.governor.enabled = false;
  const step = () => {
    r._nodes.nodeFrame.update();
    e.render();
  };
  const settle = async (ms = 1000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      step();
      await guard(raf(), 3000, `no animation frame (${stage})`);
    }
  };
  const gpuNow = () => (e.gpuMs > 0 ? e.gpuMs : NaN);
  const med = (xs: number[]) => (xs.filter((x) => x > 0).length ? median(xs.filter((x) => x > 0)) : -1);
  const throughput = async (ms = 800) => {
    for (let i = 0; i < 8; i++) step();
    await done();
    let js = 0, n = 0;
    const g: number[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const a = performance.now();
      step();
      js += performance.now() - a;
      if (++n % 2 === 0) {
        await done();
        g.push(gpuNow());
      }
    }
    await done();
    return { ms: (performance.now() - t0) / n, js: js / n, gpu: med(g) };
  };
  const paced = async (ms = 1500) => {
    const lat: number[] = [], g: number[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const a = performance.now();
      step();
      if (dev) dev.queue.onSubmittedWorkDone().then(() => lat.push(performance.now() - a));
      else (await done(), lat.push(performance.now() - a));
      await guard(raf(), 3000, `no animation frame (${stage})`);
      g.push(gpuNow());
    }
    await done();
    return { lat: lat.reduce((s, x) => s + x, 0) / Math.max(1, lat.length), gpu: med(g) };
  };
  type Row = { ms: number; js: number; paced: number; gpu: number; gpuPaced: number } | { stall: string };
  const measure = async (scene: any, where: string): Promise<Row> => {
    stage = `${where} · compiling`;
    await guard(e.precompile(scene, undefined, { parallel: 4 }), 30000, `compile not done (${where})`);
    stage = `${where} · settling`;
    await settle(1000);
    const t = [];
    for (let k = 1; k <= 3; k++) {
      stage = `${where} · flat out ${k}/3`;
      t.push(await throughput());
    }
    stage = `${where} · display pace`;
    const p = await paced();
    const f = (x: number) => +x.toFixed(2);
    return { ms: f(median(t.map((x) => x.ms))), js: f(median(t.map((x) => x.js))), paced: f(p.lat), gpu: f(median(t.map((x) => x.gpu))), gpuPaced: f(p.gpu) };
  };
  const results: Record<string, Record<string, Row>> = {};
  const lines: string[] = [];
  const stalls: string[] = [];
  const rooms = ["den", "stacks", "lab"];
  const s0 = { ...app.governor.settings };
  const at = new Date().toISOString();
  const send = async (partial: boolean) => {
    const report = { v: 3, kind: "diag", at, partial, device: app.device, ua: navigator.userAgent, backend: e.backend, msaa: e.msaa, settings: s0, results, stalls, ready: (window as any).__ready ?? null, levelTimes: (window as any).__levelTimes ?? null };
    try {
      return (await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) })).ok;
    } catch {
      return false;
    }
  };
  // cheaper ways to shade (cached per material)
  const cache = new Map<string, any>();
  const variant = (name: string, m: any, make: (m: any) => any) => {
    const k = name + m.uuid;
    if (!cache.has(k)) cache.set(k, make(m));
    return cache.get(k);
  };
  const copyLook = (v: any, m: any) => {
    for (const k of ["colorNode", "emissiveNode", "opacityNode", "map", "alphaTest", "transparent", "opacity", "side", "depthWrite", "blending", "vertexColors"]) if (m[k] !== undefined) v[k] = m[k];
    if (m.color && v.color) v.color.copy(m.color);
    if (m.emissive && v.emissive) v.emissive.copy(m.emissive), (v.emissiveIntensity = m.emissiveIntensity);
    return v;
  };
  const unlit = (m: any) => variant("unlit", m, (m) => copyLook(new THREE.MeshBasicNodeMaterial(), m));
  const matte = (m: any) => variant("matte", m, (m) => copyLook(new THREE.MeshLambertNodeMaterial(), m));
  const noEnv = (m: any) =>
    variant("noEnv", m, (m) => {
      const v = m.clone();
      v.setupEnvironment = () => null;
      return v;
    });
  say("Diagnostic: measuring each room (about three minutes). Leave the screen alone.");
  for (const [i, id] of rooms.entries()) {
    await app.loadLevel(id, () => {});
    await wait(1500);
    r.setAnimationLoop(null);
    // (clocks are still up from building the room: let them settle before the first variant)
    await settle(3000);
    const scene = app.active.scene;
    const games: any[] = [];
    scene.traverse((o: any) => o.isInstancedMesh && o.material?.userData?.media && games.push(o));
    const row: Record<string, Row> = {};
    const run = async (name: string, setup: () => void, undo?: () => void) => {
      if (stalls.length >= 3) return; // (the GPU isn't coming back: stop measuring)
      say(`Diagnostic: ${id} (${i + 1}/${rooms.length}) · ${name}…\n${lines.join("\n")}${stalls.length ? `\nstalls: ${stalls.join("; ")}` : ""}`);
      setup();
      try {
        row[name] = await measure(scene, `${id} ${name}`);
      } catch (err) {
        if (!(err instanceof Stall)) throw err;
        row[name] = { stall: err.message };
        stalls.push(err.message);
      }
      undo?.();
    };
    const swap = (to: (m: any) => any) => games.forEach((g) => ((g.userData.mat ??= g.material), (g.material = to(g.userData.mat))));
    const unswap = () => games.forEach((g) => (g.material = g.userData.mat));
    const shown = scene.children.filter((c: any) => !c.isLight && c.visible);
    await run("bloom", () => (e.setDpr(1), e.setBloom(0.25)));
    await run("plain", () => e.setBloom(0));
    await run("floor", () => shown.forEach((c: any) => (c.visible = false)), () => shown.forEach((c: any) => (c.visible = true)));
    await run("noGames", () => games.forEach((g) => (g.visible = false)), () => games.forEach((g) => (g.visible = true)));
    const points: any[] = [];
    scene.traverse((o: any) => o.isPointLight && o.visible && points.push(o));
    const half = points.slice(0, Math.ceil(points.length / 2));
    if (half.length) await run("halfLights", () => half.forEach((l) => (l.visible = false)), () => half.forEach((l) => (l.visible = true)));
    await run("noEnv", () => swap(noEnv), unswap);
    await run("matte", () => swap(matte), unswap);
    // each field's boxes: the hemisphere + the point light nearest their middle
    const hemis: any[] = [];
    scene.traverse((o: any) => o.isHemisphereLight && hemis.push(o));
    if (points.length)
      await run(
        "nearLight",
        () =>
          games.forEach((g) => {
            g.userData.mat ??= g.material;
            g.geometry.computeBoundingSphere();
            const c = g.boundingSphere?.center.clone().applyMatrix4(g.matrixWorld) ?? g.getWorldPosition(g.position.clone());
            const near = [...points].sort((a, b) => a.getWorldPosition(c.clone()).distanceTo(c) - b.getWorldPosition(c.clone()).distanceTo(c))[0];
            g.material = variant(`near${near.uuid}`, g.userData.mat, (m) => {
              const v = m.clone();
              v.lightsNode = lights([...hemis, near]);
              return v;
            });
          }),
        unswap,
      );
    const lit: any[] = [];
    scene.traverse((o: any) => o.isMesh && o.material?.isMeshStandardNodeMaterial && lit.push(o));
    await run("allMatte", () => lit.forEach((o) => ((o.userData.mat ??= o.material), (o.material = matte(o.userData.mat)))), () => lit.forEach((o) => (o.material = o.userData.mat)));
    await run("unlit", () => swap(unlit), unswap);
    await run("plainEnd", () => {});
    results[id] = row;
    lines.push(`${id}: ${Object.entries(row).map(([k, v]) => ("stall" in v ? `${k} STALL` : `${k} ${v.paced}/${v.gpuPaced}`)).join(" · ")}`);
    r.setAnimationLoop(app.frame);
    await send(true);
  }
  e.setDpr(s0.dpr);
  e.setBloom(s0.bloom);
  app.governor.enabled = true;
  const sent = (await send(false)) ? "sent ✓" : "not sent";
  say(`Diagnostic done · results ${sent}${stalls.length ? ` · ${stalls.length} stall(s): ${stalls.join("; ")}` : ""}\nms per frame at display pace: submit to done / GPU time:\n${lines.join("\n")}`);
}
