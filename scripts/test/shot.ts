// bun scripts/test/shot.ts [--url=http://localhost:5173/?level=den] [--device=desktop|phone|tablet]
//   [--engine=chromium|webkit] [--out=.cache/shots/x.png] [--wait=4000] [--throttle=4g] [--cpu=4]
//   [--actions='[["drag",200,0],["tap",0.5,0.5],["wait",800]]'] [--headed]
// Opens the app, waits until ready, runs optional actions, prints load + perf stats, screenshots.

import { chromium, webkit, devices, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const arg = (k: string, d?: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const has = (k: string) => process.argv.includes(`--${k}`);

const url = arg("url", "http://localhost:5173/?debug")!;
const device = arg("device", "desktop")!;
const engineName = arg("engine", "chromium")!;
const out = arg("out", `.cache/shots/${device}.png`)!;
const wait = +arg("wait", "3000")!;
const throttle = arg("throttle");
const cpu = arg("cpu");
const actions: any[] = JSON.parse(arg("actions", "[]")!);

const ctxOpts =
  device === "phone"
    ? { ...devices["iPhone 15 Pro"], deviceScaleFactor: 3 }
    : device === "tablet"
      ? { ...devices["iPad Pro 11"] }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };

const browser = await (engineName === "webkit" ? webkit : chromium).launch({
  headless: !has("headed"),
  channel: engineName === "chromium" ? "chrome" : undefined,
  // (keep rendering when the window is covered or in the background: you can use other windows)
  args: engineName === "chromium" ? ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-angle=metal", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"] : [],
});
const ctx = await browser.newContext(ctxOpts as any);
const page = await ctx.newPage();
const logs: string[] = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

if (engineName === "chromium" && (throttle || cpu)) {
  const cdp = await ctx.newCDPSession(page);
  if (throttle === "4g") await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 170, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 });
  if (throttle === "3g") await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 300, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  if (cpu) await cdp.send("Emulation.setCPUThrottlingRate", { rate: +cpu });
}

const t0 = Date.now();
await page.goto(url, { waitUntil: "load" });
const ok = await page.waitForFunction(() => (window as any).__ready !== undefined, null, { timeout: 120000 }).then(() => true, () => false);
const loadMs = Date.now() - t0;
await page.waitForTimeout(wait);
await runActions(page, actions);
const perf = await page.evaluate(() => ({ ready: (window as any).__ready, perf: (window as any).__perf, gpu: (navigator as any).gpu ? "navigator.gpu present" : "no navigator.gpu" }));
const bytes = await page.evaluate(() => performance.getEntriesByType("resource").reduce((s, e: any) => s + (e.transferSize || 0), 0));
mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out });
console.log(JSON.stringify({ ok, device, engine: engineName, loadMs, transferMB: +(bytes / 1e6).toFixed(2), ...perf }, null, 0));
const interesting = logs.filter((l) => !l.includes("[vite]") && !l.includes("Download the React"));
if (interesting.length) console.log(interesting.slice(0, 40).join("\n"));
await browser.close();

async function runActions(page: Page, list: any[]) {
  const vp = page.viewportSize()!;
  for (const a of list) {
    const [kind, ...p] = a;
    if (kind === "wait") await page.waitForTimeout(p[0]);
    if (kind === "tap") {
      await page.mouse.click(vp.width * p[0], vp.height * p[1]);
    }
    if (kind === "drag") {
      const [dx, dy, x = 0.5, y = 0.5] = p;
      await page.mouse.move(vp.width * x, vp.height * y);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) await page.mouse.move(vp.width * x + (dx * i) / 12, vp.height * y + (dy * i) / 12);
      await page.mouse.up();
    }
    if (kind === "wheel") await page.mouse.wheel(p[0] ?? 0, p[1] ?? 0);
    if (kind === "key") await page.keyboard.press(p[0]);
    if (kind === "eval") await page.evaluate(p[0]);
    if (kind === "shot") await page.screenshot({ path: p[0] });
  }
}
