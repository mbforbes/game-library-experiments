// Quality: fast by default, then earn the extras.
//
// The site has to hold 60 fps on devices we can't test on (an older phone, Windows laptops and
// desktops). So it starts from a conservative setting that should be smooth anywhere, then a
// governor watches real frame times while you use it:
//   • frames consistently fast (with GPU headroom when the browser can measure it) → step up one
//     notch (sharper resolution, nicer bloom, sharp close-up covers)
//   • frames consistently slow → step down (bloom, resolution, then ambient effects)
// A knob that had to come down is never raised again in the same visit (no flicker), and the
// settled result is remembered for this device, so the next visit starts where it ended up.
// Changes are small and gradual; anything big (props, anti-aliasing) only changes between rooms
// or on the next visit.

export interface QualitySettings {
  /** render pixel ratio */
  dpr: number;
  /** bloom resolution scale; 0 = bloom off */
  bloom: number;
  /** ambient effects: dust, light shafts, hologram, live portal views, burst particles */
  fx: boolean;
  /** decorative props */
  decor: boolean;
  /** sharp atlases + close-up cover overlays */
  hiRes: boolean;
  /** 4x MSAA (needs a reload to change; FXAA is used when off) */
  msaa: boolean;
}

export interface DeviceInfo {
  mobile: boolean;
  os: string;
  browser: string;
  native: number; // devicePixelRatio
  cores?: number;
  memory?: number;
  screen: string;
  gpu: { api: "webgpu" | "webgl" | "none"; vendor?: string; architecture?: string; device?: string; description?: string; renderer?: string; features?: string[] };
  integrated: boolean;
}

const LS = "the-backlog-quality-v1";

export async function detectDevice(): Promise<DeviceInfo> {
  const ua = navigator.userAgent;
  const mobile = matchMedia("(pointer: coarse)").matches || /iPhone|iPad|Android/i.test(ua);
  const os = /iPhone|iPad/.test(ua) ? "ios" : /Android/.test(ua) ? "android" : /Windows/.test(ua) ? "windows" : /Mac OS X/.test(ua) ? "mac" : /Linux/.test(ua) ? "linux" : "other";
  const browser = /Edg\//.test(ua) ? "edge" : /Firefox\//.test(ua) ? "firefox" : /Chrome\//.test(ua) ? "chrome" : /Safari\//.test(ua) ? "safari" : "other";
  const gpu: DeviceInfo["gpu"] = { api: "none" };
  try {
    const nav = navigator as any;
    if (nav.gpu) {
      const ad = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (ad) {
        const info = ad.info ?? (await ad.requestAdapterInfo?.()) ?? {};
        Object.assign(gpu, { api: "webgpu", vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, features: [...(ad.features ?? [])].slice(0, 40) });
      }
    }
  } catch {}
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      gpu.renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
      if (gpu.api === "none") gpu.api = "webgl";
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {}
  const name = `${gpu.vendor ?? ""} ${gpu.architecture ?? ""} ${gpu.description ?? ""} ${gpu.renderer ?? ""}`.toLowerCase();
  // integrated desktop GPUs: these struggle with MSAA on our half-float targets
  const integrated = !mobile && (/intel|uhd|iris|xe-?lp|gen-?\d|vega \d|radeon\(tm\) graphics|microsoft basic/.test(name) && !/arc a\d/.test(name));
  return {
    mobile,
    os,
    browser,
    native: window.devicePixelRatio || 1,
    cores: navigator.hardwareConcurrency,
    memory: (navigator as any).deviceMemory,
    screen: `${screen.width}x${screen.height}`,
    gpu,
    integrated,
  };
}

const fingerprint = (d: DeviceInfo) => `${d.os}|${d.browser}|${d.gpu.api}|${d.gpu.vendor ?? ""}|${d.gpu.architecture ?? ""}|${d.gpu.renderer ?? ""}|${d.screen}|${d.native}`;

/** DPR rungs for this device (low → high). */
export function dprLadder(d: DeviceInfo): number[] {
  const max = Math.min(d.native, 2);
  const rungs = d.mobile ? [1, 1.25, 1.5, 1.75, 2] : [0.75, 1, 1.25, 1.5, 1.75, 2];
  const out = rungs.filter((r) => r <= max + 1e-3);
  if (!out.length || out[out.length - 1] < max - 0.05) out.push(max);
  return out;
}

export const BLOOM_LADDER = [0, 0.25, 0.5];

/** Starting point: a remembered setting for this device, else a conservative one. */
export function initialSettings(d: DeviceInfo, params: URLSearchParams): { s: QualitySettings; remembered: boolean } {
  const ladder = dprLadder(d);
  const base: QualitySettings = {
    // phones render at 1.5x at most to start; desktops at their native ratio up to 1x
    dpr: d.mobile ? Math.min(d.native, 1.5) : Math.min(d.native, 1),
    bloom: 0.25,
    fx: true,
    decor: true,
    hiRes: false,
    msaa: d.mobile || !d.integrated, // tile GPUs resolve MSAA almost for free
  };
  let remembered = false;
  try {
    const saved = JSON.parse(localStorage.getItem(LS) ?? "null");
    if (saved && saved.fp === fingerprint(d) && saved.s) {
      Object.assign(base, saved.s);
      remembered = true;
    }
  } catch {}
  // URL overrides for testing: ?q=low|high, ?dpr=1.5, ?msaa=0
  const q = params.get("q") ?? params.get("quality");
  if (q === "low") Object.assign(base, { dpr: ladder[0], bloom: 0, fx: false, hiRes: false, msaa: false });
  if (q === "high") Object.assign(base, { dpr: ladder[ladder.length - 1], bloom: 0.5, fx: true, decor: true, hiRes: true, msaa: true });
  if (params.has("dpr")) base.dpr = Math.max(0.5, Math.min(3, parseFloat(params.get("dpr")!)));
  if (params.has("msaa")) base.msaa = params.get("msaa") !== "0";
  base.dpr = snap(base.dpr, ladder);
  return { s: base, remembered };
}

const snap = (v: number, ladder: number[]) => ladder.reduce((b, r) => (Math.abs(r - v) < Math.abs(b - v) ? r : b), ladder[0]);

export function saveSettings(d: DeviceInfo, s: QualitySettings) {
  try {
    localStorage.setItem(LS, JSON.stringify({ fp: fingerprint(d), s, at: new Date().toISOString() }));
  } catch {}
}

// ---------------------------------------------------------------------------------------------

export interface GovernorHooks {
  apply(s: QualitySettings, changed: (keyof QualitySettings)[]): void;
  /** true while a world is loading/switching or the tab is hidden (don't judge those frames) */
  busy(): boolean;
}

interface Sample {
  dt: number;
  cpu: number;
  gpu: number; // ms, or -1 when unknown
}

/**
 * Watches rendered frames and nudges the settings. `budget` is the frame time we aim for: the
 * cadence's interval (16.7 ms at 60 fps; 18.2 ms on a 165 Hz screen running every 3rd refresh).
 */
export class Governor {
  enabled = true;
  readonly settings: QualitySettings;
  /** caps learned this visit: a knob lowered for slowness won't go back up */
  private cap: Partial<Record<"dpr" | "bloom", number>> & { fx?: boolean; hiRes?: boolean } = {};
  private win: Sample[] = [];
  private bad = 0;
  private good = 0;
  private quietUntil = 0;
  private lastDown = -1e9;
  private trial: { key: keyof QualitySettings; prev: QualitySettings } | null = null;
  readonly log: { t: number; change: string; reason: string }[] = [];
  /** main-thread time taken by long tasks (other than our frames) since the last window */
  private longMs = 0;
  /** Long tasks (PerformanceObserver "longtask", Chromium): background work, not rendering. */
  noteLongTask(ms: number) {
    this.longMs += ms;
  }
  /** the last judged window (for the profiler / debugging) */
  stats = { slow: 0, cpu: 0, gpu: -1, good: 0, bad: 0 };
  readonly ladder: number[];

  constructor(
    private d: DeviceInfo,
    s: QualitySettings,
    private hooks: GovernorHooks,
    private budget = 1000 / 60,
  ) {
    this.settings = { ...s };
    this.ladder = dprLadder(d);
  }

  /** The frame time to aim for changed (a new cadence): judge against it from the next window. */
  setBudget(ms: number) {
    if (Math.abs(ms - this.budget) < 0.05) return;
    this.budget = ms;
    this.win = [];
  }
  get frameBudget() {
    return this.budget;
  }

  /** Feed one rendered frame. */
  frame(dt: number, cpu: number, gpu: number) {
    const now = performance.now();
    if (!this.enabled || this.hooks.busy() || now < this.quietUntil || dt > 250) {
      // ignore load hitches, tab switches and the frames right after a change
      if (dt > 250) this.quietUntil = Math.max(this.quietUntil, now + 1500);
      return;
    }
    this.win.push({ dt, cpu, gpu });
    if (this.win.length < 60) return; // judge ~1 s windows
    const w = this.win;
    this.win = [];
    const span = w.reduce((a, f) => a + f.dt, 0);
    const busy = this.longMs / Math.max(1, span);
    this.longMs = 0;
    // a window dominated by background work (building other rooms, decoding...) says nothing
    // about how heavy the rendering is: don't judge it
    if (busy > 0.25) {
      this.bad = 0;
      this.good = 0;
      return;
    }
    const slow = w.filter((f) => f.dt > this.budget * 1.3).length / w.length;
    const gpuKnown = w.filter((f) => f.gpu >= 0);
    let gpuAvg = gpuKnown.length ? gpuKnown.reduce((a, f) => a + f.gpu, 0) / gpuKnown.length : -1;
    const cpuAvg = w.reduce((a, f) => a + f.cpu, 0) / w.length;
    const dtAvg = w.reduce((a, f) => a + f.dt, 0) / w.length;
    // GPU timestamps sum render passes; on tile GPUs (Apple) passes overlap, so the sum can
    // exceed the real frame time. Only trust it when it's plausible.
    if (gpuAvg > dtAvg * 1.15) gpuAvg = -1;
    this.stats = { slow, cpu: cpuAvg, gpu: gpuAvg, good: this.good, bad: this.bad };

    if (this.trial) {
      // judging a step up we couldn't prove safe in advance
      const t = this.trial;
      this.trial = null;
      if (slow > 0.12) return this.revert(t, `trial ${t.key} failed (${pct(slow)} slow)`);
    }
    if (slow > 0.25) {
      this.good = 0;
      // badly slow (half the frames late): act on the first window, and take bigger steps
      const severe = slow > 0.5;
      if (++this.bad >= (severe ? 1 : 2)) {
        this.bad = 0;
        // CPU-bound (the frame's own work is most of the budget): resolution won't help
        const cpuBound = cpuAvg > this.budget * 0.7;
        this.stepDown(`${pct(slow)} of frames slow, cpu ${cpuAvg.toFixed(1)}ms, gpu ${gpuAvg < 0 ? "?" : gpuAvg.toFixed(1) + "ms"}`, severe, cpuBound);
      }
      return;
    }
    this.bad = Math.max(0, this.bad - 1);
    // What may go up: anything with lots of headroom; with some, only the cheap extras (bloom,
    // effects, close-up detail, props: a fraction of a ms, it's pixels that cost), as a trial
    // that reverts if frames start missing. Without GPU timings, everything is a trial.
    let up: "dpr" | "other" | null = null;
    if (gpuAvg < 0 || gpuAvg < this.budget * 0.55) up = "dpr";
    else if (gpuAvg < this.budget * 0.75) up = "other";
    if (slow < 0.03 && cpuAvg < this.budget * 0.6 && up) {
      if (++this.good >= (gpuAvg >= 0 ? 2 : 4) && now - this.lastDown > 15000) {
        this.good = 0;
        this.stepUp(gpuAvg < 0 || up === "other", `smooth (${pct(slow)} slow), cpu ${cpuAvg.toFixed(1)}ms, gpu ${gpuAvg < 0 ? "?" : gpuAvg.toFixed(1) + "ms"}`, up === "dpr");
      }
    } else this.good = 0;
  }

  /** Force settings (profiler ablations). */
  force(next: Partial<QualitySettings>, reason = "forced") {
    const changed = (Object.keys(next) as (keyof QualitySettings)[]).filter((k) => this.settings[k] !== next[k]);
    if (!changed.length) return;
    Object.assign(this.settings, next);
    this.commit(changed, reason, false);
  }

  private stepDown(reason: string, severe = false, cpuBound = false) {
    const s = this.settings;
    const i = this.ladder.indexOf(s.dpr);
    const bi = BLOOM_LADDER.indexOf(s.bloom);
    let key: keyof QualitySettings | null = null;
    const floor = this.d.mobile ? 1.25 : 1;
    // order: what costs the most for the least visible loss
    if (cpuBound && s.fx) {
      // the frame's own work is the problem: fewer things to draw/update helps, pixels don't
      s.fx = false;
      this.cap.fx = false;
      key = "fx";
    } else if (severe && i > 0 && s.dpr > floor) {
      s.dpr = this.ladder[Math.max(0, i - 2)];
      if (s.dpr < floor && this.ladder.includes(floor)) s.dpr = floor;
      this.cap.dpr = s.dpr;
      key = "dpr";
    } else if (bi > 1) {
      s.bloom = BLOOM_LADDER[bi - 1];
      this.cap.bloom = s.bloom;
      key = "bloom";
    } else if (i > 0 && s.dpr > floor) {
      s.dpr = this.ladder[i - 1];
      this.cap.dpr = s.dpr;
      key = "dpr";
    } else if (s.hiRes) {
      s.hiRes = false;
      this.cap.hiRes = false;
      key = "hiRes";
    } else if (s.fx) {
      s.fx = false;
      this.cap.fx = false;
      key = "fx";
    } else if (bi > 0) {
      s.bloom = 0;
      this.cap.bloom = 0;
      key = "bloom";
    } else if (i > 0) {
      s.dpr = this.ladder[i - 1];
      this.cap.dpr = s.dpr;
      key = "dpr";
    } else if (s.decor) {
      // last resort: props go (applied at the next room switch so nothing vanishes in view)
      s.decor = false;
      key = "decor";
    } else if (s.msaa) {
      s.msaa = false; // takes effect next visit
      key = "msaa";
    }
    if (!key) return;
    this.lastDown = performance.now();
    this.commit([key], `down: ${reason}`);
  }

  /** The next sharper rung the governor may take (within the device and this visit's cap), or null. */
  private nextDpr(): number | null {
    const i = this.ladder.indexOf(this.settings.dpr);
    const next = this.ladder[i + 1];
    if (next === undefined || next > Math.min(this.d.native, 2) + 1e-3) return null;
    if (this.cap.dpr !== undefined && next > this.cap.dpr) return null;
    return next;
  }

  private stepUp(unproven: boolean, reason: string, dprOk = true) {
    const s = this.settings;
    const prev = { ...s };
    const bi = BLOOM_LADDER.indexOf(s.bloom);
    let key: keyof QualitySettings | null = null;
    // order: sharpness first, then nicer bloom, then close-up detail, then effects back
    const nd = this.nextDpr();
    if (dprOk && nd !== null) {
      s.dpr = nd;
      key = "dpr";
    } else if (bi < BLOOM_LADDER.length - 1 && (this.cap.bloom === undefined || BLOOM_LADDER[bi + 1] <= this.cap.bloom)) {
      s.bloom = BLOOM_LADDER[bi + 1];
      key = "bloom";
    } else if (!s.fx && this.cap.fx !== false) {
      s.fx = true;
      key = "fx";
    } else if (!s.hiRes && this.cap.hiRes !== false && !this.d.mobile) {
      s.hiRes = true;
      key = "hiRes";
    } else if (!s.decor) {
      // props back (they appear at the next room switch, so this can't be judged as a trial now;
      // if they make it slow there, stepping down takes them away again the same way)
      s.decor = true;
      this.commit(["decor"], `up: ${reason}`);
      return;
    }
    if (!key) return;
    if (unproven) this.trial = { key, prev };
    this.commit([key], `up: ${reason}`);
  }

  private revert(t: { key: keyof QualitySettings; prev: QualitySettings }, reason: string) {
    Object.assign(this.settings, t.prev);
    if (t.key === "dpr") this.cap.dpr = t.prev.dpr;
    if (t.key === "bloom") this.cap.bloom = t.prev.bloom;
    if (t.key === "fx") this.cap.fx = false;
    if (t.key === "hiRes") this.cap.hiRes = false;
    this.lastDown = performance.now();
    this.commit([t.key], `revert: ${reason}`);
  }

  private commit(changed: (keyof QualitySettings)[], reason: string, save = true) {
    this.log.push({ t: Math.round(performance.now()), change: changed.map((k) => `${k}=${this.settings[k]}`).join(","), reason });
    if (this.log.length > 60) this.log.shift();
    this.quietUntil = performance.now() + 2000;
    this.win = [];
    this.hooks.apply({ ...this.settings }, changed);
    if (save) saveSettings(this.d, this.settings);
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * High-refresh displays (120/144/165 Hz) would render 2-3x more frames than the 60 we aim for.
 * Returns N: render every Nth animation frame (1 on 60 Hz screens).
 */
/** Refresh rates displays actually run at; a measured rate snaps to the nearest (within 6 %). */
const STANDARD_HZ = [50, 60, 75, 90, 100, 120, 144, 165, 170, 175, 180, 200, 240, 280, 300, 360];

/**
 * The display's refresh interval and how many of its frames each of ours lasts. Smoothness is
 * an even cadence: on a fixed-refresh screen a frame can only change on a refresh, so a rate
 * that isn't a whole fraction of it (60 fps on 144 Hz, or bouncing between 55 and 82 on
 * 165 Hz) shows as judder however high it is. So: the slowest whole fraction of the refresh
 * that's still ≥ ~54 fps, which leaves each frame the most time: 60 Hz → 60, 120 → 60,
 * 144 → 72, 165 → 55, 240 → 60. The measured interval snaps to a standard rate, so jitter in
 * the measurement doesn't flip the choice.
 */
export function frameCadence(intervals: number[]): { refreshMs: number; every: number } | null {
  if (intervals.length < 20) return null;
  // the display's interval: the main cluster round a low percentile (slow, busy frames are
  // multiples above it; the odd bunched pair of callbacks is below it), and its median
  const sorted = [...intervals].sort((a, b) => a - b);
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const cluster = sorted.filter((v) => v > p25 * 0.85 && v < p25 * 1.15);
  const base = cluster[Math.floor(cluster.length / 2)] ?? p25;
  if (!(base > 1)) return null;
  const hz = 1000 / base;
  const near = STANDARD_HZ.reduce((b, s) => (Math.abs(s - hz) < Math.abs(b - hz) ? s : b), STANDARD_HZ[0]);
  const refreshMs = 1000 / (Math.abs(near - hz) / near < 0.06 ? near : hz);
  let every = 1;
  while ((every + 1) * refreshMs <= 18.6) every++;
  return { refreshMs, every };
}

// ---- what the switches act on ---------------------------------------------------------------
// Optional content lives on its own camera layers, so one switch hides or shows it in every
// world at once (no per-object bookkeeping): ambient effects on layer 1, decor props on layer 2.
export const LAYER = { fx: 1, decor: 2 } as const;

/** Put an object (and everything under it) on a quality layer. */
export function tagQuality<T extends { traverse(fn: (o: any) => void): void }>(obj: T, kind: keyof typeof LAYER): T {
  obj.traverse((o) => o.layers.set(LAYER[kind]));
  return obj;
}

/** Live switches for code that does work rather than just drawing (portal views, bursts). */
export const live = { fx: true, decor: true, hiRes: false };
