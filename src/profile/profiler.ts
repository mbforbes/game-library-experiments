// The performance test (open the site with ?profile). About a minute, hands-off:
// tours all three rooms (moving along the shelves, zooming, pulling a game out and turning it),
// then holds a busy view in each room while switching effects off one at a time (resolution,
// bloom, ambient effects, props) so we can see what each one costs on this exact device.
// Everything (device + GPU details, load timings, per-step frame/CPU/GPU times, shader compile
// counts, errors) is sent to /api/profile when it finishes.
//
// Measuring is cheap (one timestamp per frame); the test UI is a static overlay.

import type { App } from "../app";
import type { QualitySettings } from "../engine/quality";
import { LEVELS } from "../levels";

interface Seg {
  name: string;
  room: string;
  settings: QualitySettings;
  frames: number;
  fps: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  slow20: number; // share of frames over 20 ms
  slow33: number;
  cpuAvg: number;
  cpuP90: number;
  gpuAvg: number; // -1 unknown
  drawCalls: number;
  triangles: number;
  pipelinesAdded: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

export async function runProfile(app: App) {
  const ui = overlay();
  const started = await ui.ask();
  if (!started) return ui.remove();
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" ").slice(0, 300));
    origError.apply(console, a as []);
  };
  window.addEventListener("error", (e) => errors.push(String(e.message).slice(0, 300)));
  const segs: Seg[] = [];
  const switches: Record<string, number> = {};
  const gov = app.governor;
  const wasEnabled = gov.enabled;
  gov.enabled = false; // we drive the settings during the test
  const base = { ...gov.settings };
  const ladder = gov.ladder;
  const maxDpr = ladder[ladder.length - 1];
  const pipes = () => (app.engine.renderer as any)._pipelines?.caches?.size ?? 0;
  const T0 = performance.now();
  const TOTAL = 56_000;
  const tick = setInterval(() => ui.progress(Math.min(1, (performance.now() - T0) / TOTAL)), 250);

  // one measured step: run `drive` every frame for `ms`, then summarise the frames
  async function step(name: string, room: string, ms: number, drive?: (k: number) => void) {
    ui.status(`${LEVELS[room]?.name ?? room} · ${name}`);
    await wait(250); // let the previous change settle (render targets, etc.)
    const p0 = pipes();
    const t0 = performance.now();
    let raf = 0;
    if (drive) {
      const loop = () => {
        drive(Math.min(1, (performance.now() - t0) / ms));
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    await wait(ms);
    cancelAnimationFrame(raf);
    const fr = app.samples.filter((f) => f.t >= t0);
    const dts = fr.map((f) => f.dt);
    const cpus = fr.map((f) => f.cpu);
    const gpus = fr.map((f) => f.gpu).filter((g) => g >= 0);
    const dtAvg = dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length);
    const gpuAvg = gpus.length ? gpus.reduce((a, b) => a + b, 0) / gpus.length : -1;
    const info = app.engine.renderer.info.render;
    segs.push({
      name,
      room,
      settings: { ...gov.settings },
      frames: fr.length,
      fps: +(1000 / Math.max(1, dtAvg)).toFixed(1),
      p50: +pct(dts, 0.5).toFixed(1),
      p90: +pct(dts, 0.9).toFixed(1),
      p99: +pct(dts, 0.99).toFixed(1),
      max: +Math.max(0, ...dts).toFixed(1),
      slow20: +(dts.filter((d) => d > 20).length / Math.max(1, dts.length)).toFixed(3),
      slow33: +(dts.filter((d) => d > 34).length / Math.max(1, dts.length)).toFixed(3),
      cpuAvg: +(cpus.reduce((a, b) => a + b, 0) / Math.max(1, cpus.length)).toFixed(2),
      cpuP90: +pct(cpus, 0.9).toFixed(2),
      gpuAvg: gpuAvg > dtAvg * 1.15 ? -1 : +gpuAvg.toFixed(2),
      drawCalls: info.drawCalls,
      triangles: info.triangles,
      pipelinesAdded: pipes() - p0,
    });
  }

  const set = (s: Partial<QualitySettings>) => gov.force({ ...s }, "profile");

  try {
    for (const room of ["den", "stacks", "lab"]) {
      // switch rooms (the first one is already up); the time includes building if not prebuilt
      if (app.level?.id !== room) {
        ui.status(`Opening ${LEVELS[room].name}…`);
        const ts = performance.now();
        await app.loadLevel(room);
        switches[room] = Math.round(performance.now() - ts);
      }
      set(base);
      const stations = app.level?.stations ?? [];
      // a busy, representative view: the room's first station
      stations[0]?.go();
      await wait(1400);
      // 1) moving along the shelves at the starting settings
      await step("move", room, 3500, () => app.rig.scroll(9));
      // 2) zoom out, then back in, looking around
      await step("zoom+look", room, 2000, (k) => {
        app.rig.zoom(k < 0.5 ? 1.012 : 0.988);
        app.rig.pan(0, Math.sin(k * 12) * 3);
      });
      // 3) pull a game out and turn it over
      const f = app.level?.fields[0];
      const g = f?.order[Math.floor(f.order.length * 0.4)];
      if (g) {
        app.openGame(g);
        await step("inspect", room, 1800, () => app.inspector.drag(4, 0));
        app.closeGame(true);
      }
      // 4) hold a view and switch things off one at a time
      stations[Math.min(1, stations.length - 1)]?.go();
      await wait(1200);
      set({ ...base, dpr: maxDpr, bloom: 0.5, fx: true });
      await step(`max (dpr ${maxDpr}, bloom hi)`, room, 1500);
      set({ ...base, dpr: 1, bloom: base.bloom, fx: true });
      await step("dpr 1", room, 1300);
      if (ladder[0] < 1) {
        set({ dpr: ladder[0] });
        await step(`dpr ${ladder[0]}`, room, 1300);
        set({ dpr: 1 });
      }
      set({ bloom: 0 });
      await step("no bloom", room, 1300);
      set({ bloom: base.bloom, fx: false });
      await step("no effects", room, 1300);
      set({ fx: true });
      // props: switched directly on the camera layer for the measurement
      (app as any).applyDecor(false);
      await step("no props", room, 1300);
      (app as any).applyDecor(true);
      set(base);
    }
  } catch (err) {
    errors.push(`profile: ${String(err)}`);
  }
  clearInterval(tick);
  gov.force(base, "profile done");
  gov.enabled = wasEnabled;
  console.error = origError;
  ui.status("Sending results…");
  ui.progress(1);

  const r = app.engine.renderer as any;
  const report = {
    v: 1,
    at: new Date().toISOString(),
    url: location.href,
    durationMs: Math.round(performance.now() - T0),
    device: app.device,
    ua: navigator.userAgent,
    viewport: `${innerWidth}x${innerHeight}`,
    backend: app.engine.backend,
    msaa: app.engine.msaa,
    every: (app as any).every,
    refreshMs: +(((app as any).intervals as number[]).slice().sort((a, b) => a - b)[45] ?? 0).toFixed(2),
    limits: r.backend?.device?.limits ? pick(r.backend.device.limits, ["maxTextureDimension2D", "maxBufferSize", "maxColorAttachments", "maxSampledTexturesPerShaderStage"]) : null,
    memory: (performance as any).memory ? { used: (performance as any).memory.usedJSHeapSize, limit: (performance as any).memory.jsHeapSizeLimit } : null,
    boot: (window as any).__boot ?? null,
    ready: (window as any).__ready ?? null,
    levelTimes: (window as any).__levelTimes ?? null,
    switches,
    startSettings: base,
    governorLog: gov.log,
    pipelines: r._pipelines?.caches?.size ?? null,
    programs: r._pipelines ? { vertex: r._pipelines.programs.vertex.size, fragment: r._pipelines.programs.fragment.size } : null,
    segments: segs,
    errors: errors.slice(0, 30),
  };
  let sent: string | null = null;
  for (let i = 0; i < 3 && !sent; i++) {
    try {
      const res = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
      if (res.ok) sent = ((await res.json()) as { id: string }).id;
    } catch {}
    if (!sent) await wait(1500);
  }
  if (!sent) {
    try {
      localStorage.setItem("the-backlog-profile-unsent", JSON.stringify(report));
    } catch {}
  }
  ui.done(sent, segs);
}

function pick(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}

// ---- the overlay ------------------------------------------------------------------------------

function overlay() {
  const el = document.createElement("div");
  el.className = "profile-ui";
  el.innerHTML = `<div class="pu-card">
    <div class="pu-title">Performance test</div>
    <p class="pu-text">This takes about a minute. It walks through all three rooms on its own and measures how smoothly your device draws them, then sends the numbers (device and graphics info, frame timings; nothing personal) so the site can be tuned for it.</p>
    <p class="pu-text">Please don't touch the screen while it runs.</p>
    <div class="pu-bar"><i></i></div>
    <div class="pu-status"></div>
    <div class="pu-actions"><button class="pu-go">Start the test</button><button class="pu-skip">Not now</button></div>
  </div>`;
  document.body.appendChild(el);
  const $ = (s: string) => el.querySelector(s) as HTMLElement;
  return {
    ask: () =>
      new Promise<boolean>((resolve) => {
        $(".pu-go").onclick = () => {
          $(".pu-actions").style.display = "none";
          el.classList.add("running");
          $(".pu-title").textContent = "Test running…";
          resolve(true);
        };
        $(".pu-skip").onclick = () => resolve(false);
      }),
    status: (t: string) => ($(".pu-status").textContent = t),
    progress: (k: number) => (($(".pu-bar i") as HTMLElement).style.width = `${Math.round(k * 100)}%`),
    remove: () => el.remove(),
    done: (id: string | null, segs: Seg[]) => {
      el.classList.remove("running");
      el.classList.add("finished");
      $(".pu-title").textContent = id ? "Done, thank you!" : "Done, but sending failed";
      const rooms = ["den", "stacks", "lab"].map((r) => {
        const s = segs.filter((x) => x.room === r && x.name === "move")[0];
        return s ? `${LEVELS[r].name}: ${Math.round(s.fps)} fps while moving` : "";
      });
      $(".pu-text").innerHTML = (id ? `Results sent (ref ${id.slice(11, 19)}).` : "Couldn't reach the server; the results are saved on this device.") + `<br>${rooms.filter(Boolean).join("<br>")}`;
      el.querySelectorAll(".pu-text")[1]?.remove();
      $(".pu-status").textContent = "";
      const a = $(".pu-actions");
      a.style.display = "flex";
      a.innerHTML = `<button class="pu-close">Close</button>`;
      ($(".pu-close") as HTMLButtonElement).onclick = () => el.remove();
    },
  };
}
