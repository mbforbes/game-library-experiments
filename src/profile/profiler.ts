// The performance test (open the site with ?profile). About a minute, hands-off:
// in each room, several seconds of continuous browsing the way a person does it (moving along
// the shelves with the pointer drifting over games, opening one, turning it, putting it back,
// moving on, zooming, opening another), then holds a busy view while switching effects off one
// at a time (resolution, bloom, ambient effects, props) to see what each costs on this device.
// Everything (device + GPU details, load timings, per-step frame/CPU/GPU times, shader compile
// counts, errors) is sent to /api/profile when it finishes.
//
// Measuring is cheap (one timestamp per frame); the test UI is a static overlay.

import type { App } from "../app";
import type { InputHandlers } from "../engine/input";
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
  /** frames that took over twice the usual time (and over 34 ms), with what was going on */
  hitches: { at: number; ms: number; doing: string }[];
  /** browsing: how many games the pointer passed over and how many were opened */
  hovered?: number;
  opened?: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

export async function runProfile(app: App) {
  const ui = overlay();
  const started = await ui.ask();
  if (!started) return ui.remove();
  // The whole test takes a minute from "Start": a fixed part (getting ready, room switches,
  // switching effects off one at a time) and browsing, which gets the rest, shared by the rooms.
  const T0 = performance.now();
  const TOTAL = 60_000;
  const tick = setInterval(() => ui.progress(Math.min(1, (performance.now() - T0) / TOTAL)), 250);
  // measure a settled site: let the other rooms finish building first (usually done by now)
  ui.status("Getting ready…");
  await Promise.race([app.prebuilt, wait(8000)]);
  const readyMs = Math.round(performance.now() - T0);
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

  // what the test is doing right now (to say what was going on when a frame took long)
  const marks: { t: number; doing: string }[] = [];
  const doing = (d: string) => {
    if (marks[marks.length - 1]?.doing !== d) marks.push({ t: performance.now(), doing: d });
  };

  // one measured step: run `drive` every frame for `ms`, then summarise the frames
  async function step(name: string, room: string, ms: number, drive?: (k: number) => void) {
    doing(name);
    ui.status(`${LEVELS[room]?.name ?? room} · ${name}`);
    await wait(200); // let the previous change settle (render targets, etc.)
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
    const p50 = pct(dts, 0.5);
    const hitches = fr
      .filter((f) => f.dt > 34 && f.dt > 2 * p50)
      .slice(0, 40)
      .map((f) => {
        const mid = f.t - f.dt / 2;
        let d = name;
        for (const m of marks) if (m.t <= mid) d = m.doing;
        return { at: +((f.t - t0) / 1000).toFixed(2), ms: Math.round(f.dt), doing: d };
      });
    const info = app.engine.renderer.info.render;
    segs.push({
      name,
      room,
      settings: { ...gov.settings },
      frames: fr.length,
      fps: +(1000 / Math.max(1, dtAvg)).toFixed(1),
      p50: +p50.toFixed(1),
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
      hitches,
      ...(name === "browse" ? { hovered: browseStats.hovered.size, opened: browseStats.opened } : {}),
    });
  }

  const set = (s: Partial<QualitySettings>) => gov.force({ ...s }, "profile");

  // Several seconds of browsing like a person, through the app's own input handlers (what a
  // pointer, wheel, finger or key ends up calling): move along the shelves while the pointer
  // drifts over games (each one under it lifts and shows its title), open the one under the
  // pointer, turn it over, put it back (Esc), keep moving, now zooming a little, open another...
  // (A game is opened the way a tap on it opens it; the tap itself isn't sent, as it could land
  // on a room's own clickable things.)
  const browseStats = { hovered: new Set<string>(), opened: 0 };
  function browser() {
    const h = (app as any).input.handlers as Required<InputHandlers>;
    const W = innerWidth, H = innerHeight;
    let t0 = -1, last = 0, state = "move", until = 0, opened = 0, flipped = false;
    browseStats.hovered.clear();
    browseStats.opened = 0;
    return () => {
      const now = performance.now();
      if (t0 < 0) t0 = last = now;
      const t = (now - t0) / 1000, dt = Math.max(0.001, Math.min(0.05, (now - last) / 1000));
      last = now;
      if (state === "move") {
        doing(opened ? "moving + zooming, pointer over games" : "moving, pointer over games");
        h.scroll(0, (opened % 2 ? -1 : 1) * (7 + 5 * Math.sin(t * 1.7)));
        if (opened) h.zoom(t % 1.6 < 0.8 ? 0.994 : 1.006);
        h.hover(W * (0.5 + 0.28 * Math.sin(t * 1.3)), H * (0.48 + 0.14 * Math.sin(t * 2.3 + 1)));
        const hov = (app as any).hovered as { id: string } | null;
        if (hov) browseStats.hovered.add(hov.id);
        const due = 1.5 + opened * 2.9;
        let g = hov ? app.store.byId.get(hov.id) : undefined;
        if (!g && t > due + 1) {
          // nothing under the pointer for a while (an emptier view): open one from the shelf instead
          const f = app.level?.fields[0];
          g = f?.order[Math.floor(f.order.length * ((0.3 + opened * 0.17) % 1))];
        }
        if (g && t > due) {
          doing("opening a game");
          app.openGame(g);
          browseStats.opened = opened + 1;
          state = "open";
          until = t + 0.6;
        }
      } else if (state === "open") {
        if (t > until) {
          state = "turn";
          until = t + 0.9;
          flipped = false;
        }
      } else if (state === "turn") {
        doing("turning it over");
        h.pan(6, Math.sin(t * 4) * 2, dt);
        if (opened % 2 && !flipped && t > until - 0.45) {
          flipped = true;
          h.key(new KeyboardEvent("keydown", { key: "f" })); // and flip this one over
        }
        if (t > until) {
          h.panEnd();
          doing("putting it back");
          h.key(new KeyboardEvent("keydown", { key: "Escape" }));
          opened++;
          state = "close";
          until = t + 0.25;
        }
      } else if (state === "close" && t > until && !app.inspector.active) state = "move";
    };
  }

  try {
    const rooms = ["den", "stacks", "lab"];
    for (const [i, room] of rooms.entries()) {
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
      await wait(800);
      // 1) browse at the starting settings, without stopping, for this room's share of what's
      //    left of the minute (after this room's other steps, the later rooms' and the sending)
      const left = rooms.length - i;
      const perRoom = 0.8 + 0.2 + 0.7 + (ladder[0] < 1 ? 6 : 5) * 1.2; // s, besides browsing
      const budget = (T0 + TOTAL - 1200 - performance.now()) / 1000 - (left - 1) * 1.2 - left * perRoom;
      await step("browse", room, 1000 * Math.max(5, Math.min(12, budget / left)), browser());
      if (app.inspector.active) app.closeGame(true);
      // 2) hold a view and switch things off one at a time
      stations[Math.min(1, stations.length - 1)]?.go();
      await wait(700);
      set({ ...base, dpr: maxDpr, bloom: 0.5, fx: true });
      await step(`max (dpr ${maxDpr}, bloom hi)`, room, 1000);
      set({ ...base, dpr: 1, bloom: base.bloom, fx: true });
      await step("dpr 1", room, 1000);
      if (ladder[0] < 1) {
        set({ dpr: ladder[0] });
        await step(`dpr ${ladder[0]}`, room, 1000);
        set({ dpr: 1 });
      }
      set({ bloom: 0 });
      await step("no bloom", room, 1000);
      set({ bloom: base.bloom, fx: false });
      await step("no effects", room, 1000);
      set({ fx: true });
      // props: switched directly on the camera layer for the measurement
      (app as any).applyDecor(false);
      await step("no props", room, 1000);
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
    readyMs,
    device: app.device,
    ua: navigator.userAgent,
    viewport: `${innerWidth}x${innerHeight}`,
    backend: app.engine.backend,
    msaa: app.engine.msaa,
    every: (app as any).every,
    refreshMs: +((((app as any).intervals as number[]).slice().sort((a, b) => a - b)[Math.floor(((app as any).intervals.length || 1) * 0.2)] ?? 0) as number).toFixed(2),
    limits: r.backend?.device?.limits ? pick(r.backend.device.limits, ["maxTextureDimension2D", "maxBufferSize", "maxColorAttachments", "maxSampledTexturesPerShaderStage"]) : null,
    // the device three actually rendered with (it asks for a "compatibility" adapter)
    device3: r.backend?.device
      ? {
          features: [...(r.backend.device.features ?? [])].slice(0, 40),
          adapterInfo: r.backend.device.adapterInfo ? pick(r.backend.device.adapterInfo, ["vendor", "architecture", "device", "description"]) : null,
          timestamps: !!r.backend.trackTimestamp,
        }
      : null,
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
        const s = segs.filter((x) => x.room === r && x.name === "browse")[0];
        const n = s?.hitches.filter((h) => h.ms > 50).length ?? 0;
        return s ? `${LEVELS[r].name}: ${Math.round(s.fps)} fps while browsing${n ? ` (${n} stutter${n > 1 ? "s" : ""})` : ""}` : "";
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
