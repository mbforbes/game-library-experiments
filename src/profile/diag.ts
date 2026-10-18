// ?diag: where a frame's time goes on this device, room by room. Each room is drawn back to back
// (two frames in flight, like normal rendering, but without waiting for the display) so the time
// per frame is what the browser + GPU need, at full clock speed, for:
//   bloom      as normally shown (bloom on)
//   plain      bloom off (its passes don't run)
//   plain2x    bloom off at twice the resolution (what scales with pixels)
//   floor      bloom off, nothing in the room drawn (the per-frame overhead)
//   noGames    bloom off, the game boxes not drawn
//   noAlpha    bloom off, the game boxes drawn without their alpha test
// `ms` is the time per frame; `js` the part spent in our code + the browser's WebGPU calls.
// Results are sent to /api/profile (kind "diag").

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runDiag(app: any) {
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;left:12px;right:12px;bottom:84px;z-index:50;padding:12px 14px;border-radius:10px;background:rgba(8,9,14,.92);color:#e8eaf0;font:13px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap";
  document.body.appendChild(box);
  const say = (t: string) => (box.textContent = t);
  const e = app.engine, r = e.renderer as any, dev = r.backend.device as GPUDevice | undefined;
  if (!dev) return say("Diagnostic needs WebGPU.");
  app.governor.enabled = false;
  const step = () => {
    r._nodes.nodeFrame.update();
    e.render();
  };
  const bench = async (n = 60) => {
    for (let i = 0; i < 6; i++) step();
    await dev.queue.onSubmittedWorkDone();
    let js = 0;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const a = performance.now();
      step();
      js += performance.now() - a;
      if (i % 2 === 1) await dev.queue.onSubmittedWorkDone();
    }
    await dev.queue.onSubmittedWorkDone();
    return { ms: +((performance.now() - t0) / n).toFixed(2), js: +(js / n).toFixed(2) };
  };
  // a few frames at display pace (bloom fading, shaders finishing) before measuring
  const settle = async (frames = 40) => {
    for (let i = 0; i < frames; i++) {
      step();
      await new Promise((res) => requestAnimationFrame(res));
    }
  };
  const results: Record<string, Record<string, { ms: number; js: number }>> = {};
  const lines: string[] = [];
  const rooms = ["den", "stacks", "lab"];
  const s0 = { ...app.governor.settings };
  say("Diagnostic: measuring each room (about a minute). Leave the screen alone.");
  for (const [i, id] of rooms.entries()) {
    say(`Diagnostic: ${id} (${i + 1}/${rooms.length})…\n${lines.join("\n")}`);
    await app.loadLevel(id, () => {});
    await wait(1500);
    r.setAnimationLoop(null);
    const scene = app.active.scene;
    const games: any[] = [];
    scene.traverse((o: any) => o.isInstancedMesh && o.material?.alphaTest === 0.5 && games.push(o));
    const mats = new Set(games.map((o) => o.material));
    const row: Record<string, { ms: number; js: number }> = {};
    e.setDpr(1);
    e.setBloom(0.25);
    await settle();
    row.bloom = await bench();
    e.setBloom(0);
    await settle();
    row.plain = await bench();
    e.setDpr(2);
    await settle(20);
    row.plain2x = await bench();
    e.setDpr(1);
    await settle(20);
    const shown = scene.children.filter((c: any) => !c.isLight && c.visible);
    for (const c of shown) c.visible = false;
    await settle(10);
    row.floor = await bench();
    for (const c of shown) c.visible = true;
    for (const g of games) g.visible = false;
    await settle(10);
    row.noGames = await bench();
    for (const g of games) g.visible = true;
    for (const m of mats) ((m.alphaTest = 0), (m.needsUpdate = true));
    await settle(240); // (its shaders rebuild)
    row.noAlpha = await bench();
    for (const m of mats) ((m.alphaTest = 0.5), (m.needsUpdate = true));
    await settle(60);
    results[id] = row;
    lines.push(`${id.padEnd(6)} ${Object.entries(row).map(([k, v]) => `${k} ${v.ms}`).join(" · ")}`);
    r.setAnimationLoop(app.frame);
  }
  e.setDpr(s0.dpr);
  e.setBloom(s0.bloom);
  app.governor.enabled = true;
  const report = { v: 1, kind: "diag", at: new Date().toISOString(), device: app.device, ua: navigator.userAgent, backend: e.backend, msaa: e.msaa, settings: s0, results };
  let sent = "not sent";
  try {
    const res = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
    if (res.ok) sent = "sent ✓";
  } catch {}
  say(`Diagnostic done · results ${sent}\nms per frame:\n${lines.join("\n")}`);
}
