// bun scripts/test/perf.ts [--url=...] [--device=desktop|phone] [--headless] [--script=den|stacks|lab|switch]
// Drives the app like a person (drag, scroll, hover, click games, flip, close, stations, level
// switches) in real Chrome with its GPU, records every frame's duration, and reports stutters
// per action so slow pieces can be found (combine with ?no=... ablation flags in the URL).

import { chromium, devices, type Page } from "playwright";

const arg = (k: string, d?: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const url = arg("url", "http://localhost:5173/?level=den")!;
const device = arg("device", "desktop")!;
const script = arg("script", "den")!;
const headless = process.argv.includes("--headless");
const tracePath = arg("trace");

// --channel=chromium uses Playwright's own Chromium (separate Metal shader cache: clear it to test
// a first visit with nothing compiled, see --cold)
const channel = arg("channel", "chrome")!;
if (process.argv.includes("--cold")) {
  const { execSync } = await import("node:child_process");
  const dir = execSync("getconf DARWIN_USER_CACHE_DIR").toString().trim();
  for (const id of ["com.google.chrome.for.testing", "com.google.chrome.for.testing.helper"]) execSync(`rm -rf "${dir}/${id}"`);
  console.log("cleared Playwright Chromium's Metal shader cache");
}
const browser = await chromium.launch({ headless, channel: channel === "chromium" ? undefined : channel, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"] });
const ctx = await browser.newContext(device === "phone" ? { ...devices["iPhone 15 Pro"], deviceScaleFactor: 3 } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors: string[] = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
await page.addInitScript(() => {
  const w = window as any;
  w.__frames = [] as { t: number; dt: number; label: string }[];
  w.__label = "boot";
  let last = performance.now();
  const loop = (t: number) => {
    w.__frames.push({ t, dt: t - last, label: w.__label });
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

const t0 = Date.now();
await page.goto(url);
await page.waitForFunction(() => (window as any).__ready !== undefined, null, { timeout: 120000 });
const readyMs = Date.now() - t0;
const builds: string[] = [];
page.on("console", (m) => m.text().startsWith("[build]") && builds.push(m.text()));
page.on("console", (m) => m.text().startsWith("[level]") && console.log(m.text()));
// log every node build that happens at render time (i.e. wasn't precompiled), with its object
await page.evaluate(() => {
  const w = window as any;
  const nodes = w.app.engine.renderer._nodes;
  const orig = nodes.getForRender.bind(nodes);
  nodes.getForRender = (ro: any, ...rest: any[]) => {
    const had = nodes.get(ro).nodeBuilderState !== undefined;
    const t = performance.now();
    const r = orig(ro, ...rest);
    const dt = performance.now() - t;
    if (!had && dt > 3) {
      const path: string[] = [];
      for (let o = ro.object; o && path.length < 4; o = o.parent) path.push(o.name || o.type);
      console.log(`[build] ${dt.toFixed(0)}ms ${w.__label} ${ro.material.type}#${ro.material.id} ${path.join("<")}`);
    }
    return r;
  };
});
const vp = page.viewportSize()!;
const label = (l: string) => page.evaluate((x) => ((window as any).__label = x), l);
const wait = (ms: number) => page.waitForTimeout(ms);

async function drag(dx: number, dy: number, steps = 30, x = 0.5, y = 0.5) {
  await page.mouse.move(vp.width * x, vp.height * y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(vp.width * x + (dx * i) / steps, vp.height * y + (dy * i) / steps);
    await wait(16);
  }
  await page.mouse.up();
}
async function scroll(dy: number, n = 20) {
  await page.mouse.move(vp.width * 0.5, vp.height * 0.5);
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, dy);
    await wait(30);
  }
}
async function hoverSweep() {
  for (let i = 0; i <= 40; i++) {
    await page.mouse.move(vp.width * (0.2 + (0.6 * i) / 40), vp.height * (0.35 + 0.3 * Math.sin(i / 5)));
    await wait(25);
  }
}
async function station(i: number) {
  await page.evaluate((k) => (document.querySelectorAll(".station")[k] as HTMLElement)?.click(), i);
}
async function clickGameNear(x: number, y: number) {
  await page.mouse.click(vp.width * x, vp.height * y);
}

await label("settle");
await wait(3000);
if (tracePath) await browser.startTracing(page, { path: tracePath, categories: (arg("cats") ?? "devtools.timeline,disabled-by-default-devtools.timeline,toplevel,v8.execute,disabled-by-default-v8.cpu_profiler,gpu").split(",") });
await label("idle");
await wait(2000);

if (script === "switch") {
  for (const l of ["stacks", "lab", "den", "stacks"]) {
    await label("switch:" + l);
    const ts = Date.now();
    await page.evaluate((id) => {
      (window as any).app.loadLevel(id);
    }, l);
    await page.waitForFunction(() => !(window as any).app.loadingLevel, null, { timeout: 60000 });
    console.log(`switch to ${l}: ${Date.now() - ts}ms`);
    await label("after:" + l);
    await wait(2500);
  }
} else {
  await label("drag-pan");
  await drag(-600, 0);
  await drag(500, 150);
  await drag(-300, -250);
  await label("scroll");
  await scroll(120, 25);
  await scroll(-120, 25);
  await label("zoom");
  await page.keyboard.down("Control");
  await scroll(-60, 15);
  await scroll(60, 15);
  await page.keyboard.up("Control");
  await label("hover");
  await hoverSweep();
  for (let k = 0; k < 3; k++) {
    await label(`open-${k}`);
    await page.evaluate((i) => {
      const app = (window as any).app;
      const f = app.level.fields[0];
      const g = f.order[(i * 37 + 11) % f.order.length];
      app.level.focusGame(g);
      setTimeout(() => app.openGame(g), 900);
    }, k);
    await wait(2200);
    await label(`flip-${k}`);
    await page.evaluate(() => (window as any).app.inspector.flip());
    await wait(900);
    await label(`close-${k}`);
    await page.evaluate(() => (window as any).app.closeGame());
    await wait(1200);
  }
  for (let s = 0; s < 6; s++) {
    await label(`station-${s}`);
    await station(s);
    await wait(2200);
    await label(`station-${s}-drag`);
    await drag(-250, 60, 20);
    await wait(400);
  }
  await label("tap");
  await clickGameNear(0.45, 0.5);
  await wait(1800);
  await page.evaluate(() => (window as any).app.closeGame());
  await wait(1000);
}
await label("end");
await wait(300);
if (tracePath) await browser.stopTracing();

const frames: { t: number; dt: number; label: string }[] = await page.evaluate(() => (window as any).__frames);
const after = frames.filter((f) => f.label !== "boot" && f.label !== "settle");
const by = new Map<string, number[]>();
for (const f of after) {
  if (!by.has(f.label)) by.set(f.label, []);
  by.get(f.label)!.push(f.dt);
}
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
console.log(`ready ${readyMs}ms  backend ${await page.evaluate(() => (window as any).app?.engine?.backend)}  dpr ${await page.evaluate(() => (window as any).app?.engine?.dpr)}`);
console.log("segment".padEnd(22), "frames  p50   p95    max   >50ms >200ms");
for (const [k, v] of by) {
  console.log(k.padEnd(22), String(v.length).padStart(5), pct(v, 0.5).toFixed(1).padStart(6), pct(v, 0.95).toFixed(1).padStart(6), Math.max(...v).toFixed(0).padStart(6), String(v.filter((x) => x > 50).length).padStart(5), String(v.filter((x) => x > 200).length).padStart(5));
}
const worst = [...after].sort((a, b) => b.dt - a.dt).slice(0, 12);
console.log("worst frames:", worst.map((f) => `${f.dt.toFixed(0)}ms@${f.label}`).join("  "));
const all = after.map((f) => f.dt);
console.log(`overall: ${all.length} frames, p50 ${pct(all, 0.5).toFixed(1)}ms, p95 ${pct(all, 0.95).toFixed(1)}ms, stalls>100ms ${all.filter((x) => x > 100).length}, total stall time ${(all.filter((x) => x > 50).reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s`);
if (errors.length) console.log("errors:", errors.slice(0, 8).join("\n"));
const during = builds.filter((b) => !/ (settle|idle) /.test(b));
if (builds.length) console.log(`node builds outside the loading screen: ${builds.length} (${during.length} during interactions)\n` + during.slice(0, 40).join("\n"));
await browser.close();
