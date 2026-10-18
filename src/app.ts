// App: wires data, art, renderer, camera rig, input, HUD, inspect mode and the active level.

import * as THREE from "three/webgpu";
import type { Game } from "../shared/types";
import { createEngine, type Engine } from "./engine/renderer";
import { CameraRig } from "./engine/rig";
import { Input } from "./engine/input";
import { Inspector } from "./engine/inspect";
import { LibraryStore } from "./library/store";
import { ArtStore } from "./library/art";
import { SpineAtlas } from "./media/spines";
import { makeMediaKit, type MediaField, type MediaKit } from "./media/field";
import { Hud } from "./ui/hud";
import { LEVELS, DEFAULT_LEVEL, type LevelEntry } from "./levels";
import { Hero } from "./media/hero";
import { AudioEngine } from "./audio/audio";
import { neonFx } from "./world/kit/common";
import { Bursts } from "./world/kit/particles";
import { off } from "./engine/flags";
import { detectDevice, initialSettings, Governor, frameCadence, LAYER, live, type DeviceInfo, type QualitySettings } from "./engine/quality";
import { FpsMeter } from "./ui/fps";
import { newGames } from "./library/store";
import { setNewIds } from "./media/stickers";
import type { Level, LevelCtx } from "./levels/types";

/** A built world, kept alive so switching back is instant: own scene, rig, tickers, post look. */
interface Slot {
  id: string;
  entry: LevelEntry;
  level: Level;
  scene: THREE.Scene;
  rig: CameraRig;
  post: Record<"bloomStrength" | "bloomRadius" | "bloomThreshold" | "vignette" | "grain" | "exposure", { value: number }>;
  pickables: { obj: THREE.Object3D; onTap: (hit: THREE.Intersection) => void }[];
  tickers: ((dt: number, t: number) => void)[];
  ready: Promise<void>;
  /** everything (not just the opening view) compiled */
  full: Promise<void>;
  compiled: boolean;
  /** building quietly in the background (yields generously between phases) */
  background: boolean;
  onProgress?: (k: number, msg: string) => void;
}

export class App {
  engine!: Engine;
  input!: Input;
  store = new LibraryStore();
  audio = new AudioEngine();
  art!: ArtStore;
  spines!: SpineAtlas;
  kit!: MediaKit;
  hud!: Hud;
  inspector!: Inspector;
  private slots = new Map<string, Slot>();
  private active: Slot | null = null;
  get level(): Level | null {
    return this.active?.level ?? null;
  }
  get rig(): CameraRig {
    return this.active!.rig;
  }
  private raycaster = new THREE.Raycaster();
  private debug = new URLSearchParams(location.search).has("debug");
  device!: DeviceInfo;
  governor!: Governor;
  fps!: FpsMeter;
  /** render every Nth animation frame (high-refresh screens: an even ~60, see frameCadence) */
  private every = 1;
  private refreshMs = 1000 / 60;
  /** a new cadence is only taken once two measurements in a row agree on it */
  private cadenceSeen = "";
  private tick = 0;
  private intervals: number[] = [];
  private lastRaf = 0;
  private lastRender = 0;
  /** per rendered frame: dt, cpu work, gpu time (the profiler reads these) */
  readonly samples: { t: number; dt: number; cpu: number; gpu: number }[] = [];
  private frames: number[] = [];
  loadingLevel = false;
  /** resolves when the other worlds have been prebuilt in the background */
  prebuilt: Promise<void> = Promise.resolve();
  private profiling = new URLSearchParams(location.search).has("profile") || location.pathname.replace(/\/$/, "") === "/profile";
  /** time of the last pointer / wheel / key / touch input */
  private lastInput = 0;

  async start(canvas: HTMLCanvasElement) {
    const t0 = performance.now();
    this.hud = new Hud(this.store, this.callbacks(), Object.entries(LEVELS).filter(([, l]) => !l.hidden).map(([id, l]) => ({ id, name: l.name, tagline: l.tagline })));
    try {
      this.hud.setProgress("Booting renderer…", 0.05);
      // fast by default: start from what this device settled on last time, or a safe setting
      const params = new URLSearchParams(location.search);
      this.device = await detectDevice();
      const { s: q0, remembered } = initialSettings(this.device, params);
      this.engine = await createEngine(canvas, { msaa: q0.msaa, dpr: q0.dpr, bloom: q0.bloom, timestamps: true, coldTag: params.get("cold") ?? undefined });
      this.governor = new Governor(this.device, q0, {
        apply: (s, changed) => this.applyQuality(s, changed),
        // (and not while shaders compile at full speed: that measures the compile, not the device)
        busy: () => this.loadingLevel || document.hidden || !this.active || this.engine.compilingUnpaced,
      });
      if (params.has("nogov")) this.governor.enabled = false;
      try {
        // background main-thread work (long tasks outside our frames) shouldn't cost resolution
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) if (e.duration > 50) this.governor.noteLongTask(e.duration);
        }).observe({ type: "longtask", buffered: false });
      } catch {}
      this.applyQuality(q0, ["dpr", "bloom", "fx", "decor", "hiRes"]);
      console.info(`[quality] ${remembered ? "remembered" : "first visit"}: ${JSON.stringify(q0)} · ${this.device.gpu.api} ${this.device.gpu.description || this.device.gpu.renderer || ""}`);
      this.fps = new FpsMeter(this.device.mobile);
      document.body.appendChild(this.fps.el);
      this.applyQuality(q0, []); // (sets the meter's note)
      this.hud.bindFps(() => this.fps.on, (on) => (this.fps.on = on));
      this.hud.factsHook = (g) => this.level?.facts?.(g) ?? [];
      const tEngine = performance.now();
      this.art = new ArtStore(this.device.mobile ? "lo" : "hi");
      this.hud.art = this.art;
      this.hud.setProgress("Reading Cooper's spreadsheet…", 0.15);
      const fontsReady = loadFonts();
      await Promise.all([this.store.load(), this.art.load(), fontsReady]);
      const tData = performance.now();
      this.audio.prepare();
      this.hud.setProgress("Printing spines…", 0.75);
      await nextFrame();
      this.spines = new SpineAtlas(this.engine.quality.mobile, this.art);
      this.spines.build(this.store.games);
      const tSpines = performance.now();
      console.info(`[boot] renderer ${Math.round(tEngine - t0)}ms, data ${Math.round(tData - tEngine)}ms, spines ${Math.round(tSpines - tData)}ms`);
      (window as any).__boot = { renderer: Math.round(tEngine - t0), data: Math.round(tData - tEngine), spines: Math.round(tSpines - tData) };
      this.kit = makeMediaKit(this.art, this.spines);
      this.inspector = new Inspector(this.engine.scene, this.engine.camera, this.art);
      this.input = new Input(canvas);
      this.bindInput();
      for (const ev of ["pointermove", "pointerdown", "wheel", "keydown", "touchstart"]) addEventListener(ev, () => (this.lastInput = performance.now()), { passive: true, capture: true });
      this.store.on("filter", () => this.applyFilter());
      // recently added games: badge them in every world (also ones built later)
      this.store.on("new", () => {
        setNewIds(newGames.ids);
        for (const slot of this.slots.values()) if (slot.compiled) this.markNew(slot);
        this.hud.setNewCount(newGames.ids.size);
      });
      this.store.loadNew();

      const wantVault = params.get("level") === "vault" || location.pathname.replace(/\/$/, "") === "/vault";
      let id = params.get("level") ?? DEFAULT_LEVEL;
      if (id === "vault") id = DEFAULT_LEVEL; // the vault opens after the password (below)
      this.engine.renderer.setAnimationLoop(this.frame);
      await this.loadLevel(LEVELS[id] ? id : DEFAULT_LEVEL, (k, msg) => this.hud.setProgress(msg, 0.8 + k * 0.2));
      console.info(`[library] ready in ${Math.round(performance.now() - t0)}ms (${this.engine.backend}, ${this.store.source})`);
      (window as any).__ready = performance.now() - t0;
      this.hud.hideLoading();
      if (!off("upgrade") && this.governor.settings.hiRes) this.art.ready.then(() => setTimeout(() => this.art.upgrade(), 1000));
      if (!off("prebuild")) this.prebuilt = this.prebuildOthers();
      if (wantVault) this.openVault();
      // the performance test: /profile or ?profile
      if (this.profiling) import("./profile/profiler").then((m) => m.runProfile(this));
      // the shader-cache test: ?loadtest (with ?cold=N for shaders never compiled before)
      if (params.has("loadtest")) this.loadTest(params.get("cold") ?? "");
    } catch (err) {
      console.error(err);
      this.hud.showError(String((err as Error)?.message ?? err));
    }
  }

  private ctx(slot: Pick<Slot, "scene" | "rig" | "pickables" | "tickers" | "post">): LevelCtx {
    // levels set their look on ctx.engine.post (bloom, vignette, exposure…): give each level its
    // own copy so a world building in the background can't change the one on screen
    const engine = Object.create(this.engine) as Engine;
    Object.defineProperty(engine, "post", { value: { ...this.engine.post, ...slot.post } });
    return {
      engine,
      scene: slot.scene,
      camera: this.engine.camera,
      rig: slot.rig,
      store: this.store,
      art: this.art,
      kit: this.kit,
      audio: this.audio,
      pickable: (obj, onTap) => slot.pickables.push({ obj, onTap }),
      inspect: (g) => this.openGame(g),
      toast: (t, ms) => this.hud.toast(t, ms),
      onUpdate: (fn) => slot.tickers.push(fn),
      openVault: () => this.openVault(),
    };
  }

  /** Build a world (once) into its own scene and precompile all its shaders. */
  private ensureSlot(id: string, background = false): Slot {
    const have = this.slots.get(id);
    if (have) return have;
    const entry = LEVELS[id];
    const p = this.engine.post;
    const slot = {
      id,
      entry,
      scene: new THREE.Scene(),
      rig: new CameraRig(this.engine.camera),
      post: {
        bloomStrength: { value: p.bloomStrength.value },
        bloomRadius: { value: p.bloomRadius.value },
        bloomThreshold: { value: p.bloomThreshold.value },
        vignette: { value: p.vignette.value },
        grain: { value: p.grain.value },
        exposure: { value: 1 },
      },
      pickables: [],
      tickers: [],
      compiled: false,
      background,
    } as unknown as Slot;
    this.slots.set(id, slot);
    slot.ready = (async () => {
      const report = (k: number, msg: string) => slot.onProgress?.(k, msg);
      report(0, `Loading ${entry.name}…`);
      const tb = performance.now();
      const level = (await entry.load())();
      slot.level = level;
      let phase = 0;
      this.audio.scope = id;
      await level.build(this.ctx(slot), async (msg) => {
        report(Math.min(0.6, 0.08 * ++phase), msg);
        this.audio.scope = "";
        // background builds give the frame loop room to breathe between phases, and wait while
        // you're interacting
        if (slot.background) while (!this.quiet()) await wait(250);
        await (slot.background ? idle(120) : nextFrame());
        this.audio.scope = id;
      });
      this.audio.scope = "";
      slot.scene.add(Hero.warmup(this.art), this.inspector.warmup());
      const tc = performance.now();
      if (slot.background) {
        // prebuilding a world nobody is looking at yet: everything, one shader at a time
        report(0.62, "Compiling shaders…");
        // (paced to idle time between frames, and only while you're not interacting and frames
        // have time to spare; see quiet())
        await this.engine.precompile(slot.scene, (k) => report(0.62 + 0.38 * k, "Compiling shaders…"), { parallel: 1, gate: () => this.quiet() });
        slot.full = Promise.resolve();
      } else {
        // On screen next: compile the whole room before it's shown, so nothing compiles while
        // you use it (compiling as things first came into view was a stutter each time). A first
        // visit compiles every shader from scratch; repeat visits mostly hit the browser's shader
        // cache. The cap only keeps an extremely slow device from waiting forever.
        report(0.62, "Compiling shaders…");
        slot.rig.update(0); // put the camera at this world's opening view
        slot.full = this.engine.precompile(slot.scene, (k) => report(0.62 + 0.38 * k, "Compiling shaders…"), { parallel: 4 });
        await Promise.race([slot.full, wait(20000)]);
      }
      slot.compiled = true;
      this.markNew(slot);
      console.info(`[level] ${id}: built ${Math.round(tc - tb)}ms, compiled ${Math.round(performance.now() - tc)}ms${slot.background ? " (background)" : ""}`);
      const lt = ((window as any).__levelTimes ??= {});
      lt[id] = { built: Math.round(tc - tb), compiled: Math.round(performance.now() - tc), background: slot.background };
      slot.full.then(() => console.info(`[level] ${id}: all shaders ready at ${Math.round(performance.now() - tb)}ms`));
      report(1, "Ready");
    })();
    return slot;
  }

  /**
   * ?loadtest: how long compiling took on this load (the room you opened, then the others as they
   * prebuild), shown on screen and sent with the performance-test results. With ?cold=N, the
   * first load of a new N compiles every shader from scratch; reloads show what's cached.
   */
  private async loadTest(tag: string) {
    const key = `the-backlog-loadtest-${tag || "plain"}`;
    let visit = 1;
    try {
      visit = +(localStorage.getItem(key) ?? 0) + 1;
      localStorage.setItem(key, String(visit));
    } catch {}
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:12px;right:12px;bottom:84px;z-index:50;padding:12px 14px;border-radius:10px;background:rgba(8,9,14,.9);color:#e8eaf0;font:13px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap";
    document.body.appendChild(box);
    const r = this.engine.renderer as any;
    const lines = () => {
      const lt = (window as any).__levelTimes ?? {};
      return Object.entries(lt).map(([id, v]: [string, any]) => `${id.padEnd(7)} built ${v.built} ms, compiled ${v.compiled} ms${v.background ? " (background)" : ""}`);
    };
    const head = `Load test ${tag ? `cold=${tag}` : "(no cold tag)"} · visit ${visit} on this device\nready in ${Math.round((window as any).__ready ?? 0)} ms`;
    box.textContent = `${head}\n${lines().join("\n")}\n(waiting for the other rooms; leave the screen alone)`;
    // (until the other rooms are built, or prebuilding switched itself off, or 90 s)
    for (let t = 0; t < 90 && !this.bgOff && !allRoomsBuilt(this); t++) await Promise.race([this.prebuilt, wait(1000)]);
    const report = { v: 1, kind: "loadtest", at: new Date().toISOString(), tag, visit, device: this.device, ua: navigator.userAgent, backend: this.engine.backend, boot: (window as any).__boot ?? null, ready: (window as any).__ready ?? null, levelTimes: (window as any).__levelTimes ?? null, pipelines: r._pipelines?.caches?.size ?? null, bgOff: this.bgOff };
    let sent = "not sent";
    try {
      const res = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
      if (res.ok) sent = "sent ✓";
    } catch {}
    box.textContent = `${head}\n${lines().join("\n")}\n${report.pipelines} pipelines · results ${sent}`;
  }

  /** After the first world is up, quietly build + compile the others so switching is instant. */
  private async prebuildOthers() {
    // let the first room have the stage: wait until its own compiles are done and you've had a
    // few seconds in it, then build the others only while you're not moving around
    await this.active?.full;
    await wait(6000);
    for (const id of Object.keys(LEVELS)) {
      if (LEVELS[id].hidden || this.slots.has(id)) continue;
      while (this.loadingLevel || !this.active || !this.quiet()) await wait(400);
      await this.ensureSlot(id, true).ready.catch((e) => console.warn("[prebuild]", id, e));
    }
  }

  /**
   * May background work (compiling the rest of this room, prebuilding the others) run right now?
   * Only while you're not moving, hovering or holding a game, and while recent frames have been
   * on time: once the site is up, using it has to stay smooth. A world you're waiting for
   * (switching to it) always may. If background compiling still costs frames on this device,
   * prebuilding stops for the visit (`bgOff`): the other rooms compile when you switch to them.
   */
  private quiet() {
    if (this.loadingLevel) return true;
    return !this.bgOff && this.userIdle();
  }

  /** Not moving, hovering or holding a game for a moment, and frames on time. */
  private userIdle() {
    const rig = this.active?.rig;
    return performance.now() - this.lastInput > 1500 && (!rig || (rig.idle >= 1.5 && rig.settled)) && !this.inspector.active && this.framesOnTime();
  }

  /** Have the last ~30 frames kept to the cadence (at most one late)? */
  private framesOnTime() {
    const n = this.samples.length;
    if (n < 30) return false;
    const budget = this.governor.frameBudget * 1.3;
    let late = 0;
    for (let i = n - 30; i < n; i++) if (this.samples[i].dt > budget) late++;
    return late <= 1 && performance.now() - this.samples[n - 1].t < 500;
  }
  /** background prebuilding switched off for this visit (it cost frames here) */
  bgOff = false;
  private bgLate: number[] = [];

  async loadLevel(id: string, onProgress?: (k: number, msg: string) => void) {
    if (this.loadingLevel || this.active?.id === id) return;
    this.loadingLevel = true;
    this.unhover();
    this.hud.tooltip(null, 0, 0);
    const post = this.engine.post;
    const first = !this.active;
    // switch off the current world
    if (this.active) {
      this.audio.play("crtoff");
      this.closeGame(true);
      await tween(380, (k) => (post.crt.value = k * k));
    }
    const slot = this.ensureSlot(id);
    if (slot.background) this.engine.boostCompile();
    slot.background = false;
    if (!slot.compiled) {
      const name = slot.entry.name;
      slot.onProgress = (k: number, msg: string) => (onProgress ? onProgress(k, msg) : this.hud.switching(name, k));
      if (!onProgress) this.hud.switching(name, 0.02);
      await slot.ready;
      slot.onProgress = undefined;
      this.hud.switching(null);
    }
    this.activate(slot);
    const url = new URL(location.href);
    url.searchParams.set("level", id);
    history.replaceState(null, "", url);
    post.crt.value = 1;
    post.fade.value = 0;
    this.levelStart = performance.now();
    if (!first) this.audio.play("crton");
    await tween(first ? 600 : 460, (k) => (post.crt.value = (1 - k) * (1 - k)));
    this.loadingLevel = false;
  }

  /** The vault: unlocked by a password the Worker checks (it sets an HttpOnly cookie). */
  async openVault() {
    if (this.loadingLevel || this.active?.id === "vault") return;
    let ok = false;
    try {
      ok = (await fetch("/api/vault/data", { credentials: "same-origin" })).ok;
    } catch {}
    if (!ok) {
      this.audio.play("tick");
      ok = await this.hud.askVaultPassword(async (pw) => {
        const r = await fetch("/api/vault/unlock", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
        return r.ok;
      });
    }
    if (!ok) return;
    this.audio.play("jingle");
    this.audio.revive();
    this.loadLevel("vault");
  }

  private markNew(slot: Slot) {
    if (!newGames.ids.size && !slot.level) return;
    for (const f of slot.level?.fields ?? []) f.setNew(newGames.ids, slot.entry.newColor ?? slot.entry.accent);
  }

  private activate(slot: Slot) {
    if (this.governor && live.decor !== this.governor.settings.decor) this.applyDecor(this.governor.settings.decor);
    this.active = slot;
    this.engine.setScene(slot.scene);
    this.inspector.setScene(slot.scene);
    slot.scene.add(this.bursts.mesh);
    this.burstColor = slot.entry.accent;
    this.audio.activate(slot.id);
    this.audio.music(slot.entry.music?.url ?? null);
    this.hud.setCredits(slot.entry.music ?? null);
    this.hud.setLevel(slot.level.name, slot.entry.accent, slot.level.stations);
    this.applyFilter();
    slot.level.enter?.();
  }

  private callbacks() {
    return {
      onSearchPick: (g: Game) => {
        this.level?.focusGame(g);
        setTimeout(() => this.openGame(g), 650);
      },
      onFilter: (f: any) => this.store.setFilter(f),
      onLevel: (id: string) => {
        // (inside the tap: the one moment iOS lets us restart sound that it had stopped)
        this.audio.revive();
        this.loadLevel(id);
      },
      onSound: () => (this.audio.enabled = !this.audio.enabled),
      soundOn: () => this.audio.enabled,
      onUi: (kind: "tick" | "travel") => this.audio.play(kind, { volume: kind === "tick" ? 0.7 : 0.8 }),
      onClose: () => this.closeGame(),
      onFlip: () => {
        this.audio.play("flip");
        this.inspector.flip();
      },
      onSpine: () => this.inspector.showSpine(),
      onPrev: () => this.step(-1),
      onNext: () => this.step(1),
    };
  }

  private applyFilter() {
    for (const f of this.level?.fields ?? []) f.applyFilter((g) => this.store.matches(g), this.store.filtering);
  }

  private fieldOf(g: Game): MediaField | null {
    return this.level?.fields.find((f) => f.has(g.id)) ?? null;
  }

  openGame(g: Game) {
    this.unhover();
    this.inspector.layout = this.hud.isSide ? "side" : "top";
    const field = this.fieldOf(g);
    const at = field?.centerOf(g.id) ?? undefined;
    this.audio.play("pull", { at, pitch: 0.9 + Math.random() * 0.2 });
    if (at) this.bursts.emit(at, this.burstColor, 22, 0.14, 0.2);
    this.inspector.open(g, field);
    this.store.select(g);
    this.hud.showGame(g);
    this.level?.onSelect?.(g);
  }

  closeGame(immediate = false) {
    if (!this.inspector.active) return;
    if (!immediate) {
      const g = this.inspector.hero?.game;
      const at = g ? this.fieldOf(g)?.centerOf(g.id) ?? undefined : undefined;
      this.audio.play("putback", { at, delay: 0.45, pitch: 0.9 + Math.random() * 0.2 });
    }
    this.inspector.close(immediate);
    this.store.select(null);
    this.hud.showGame(null);
    this.level?.onSelect?.(null);
  }

  private step(dir: number) {
    const cur = this.store.selected;
    if (!cur) return;
    const field = this.fieldOf(cur);
    const list = field ? field.order : this.store.games;
    const i = list.findIndex((g) => g.id === cur.id);
    const next = list[(i + dir + list.length) % list.length];
    this.inspector.close(true);
    this.level?.focusGame(next);
    this.openGame(next);
  }

  private bindInput() {
    let dragHero = false;
    const handlers: Input["handlers"] = {
      pan: (dx, dy, dt) => {
        if (!this.inspector.active && this.level?.onGesture?.({ type: "pan", dx, dy })) return;
        if (this.inspector.active) {
          dragHero = true;
          this.inspector.drag(dx, dy);
          return;
        }
        this.rig.pan(dx, dy, dt);
      },
      panEnd: () => {
        if (!dragHero && this.level?.onGesture?.({ type: "panEnd" })) return;
        if (dragHero) {
          this.inspector.release();
          dragHero = false;
        }
        this.rig.endPan();
      },
      zoom: (f) => {
        if (this.inspector.active || this.level?.onGesture?.({ type: "zoom", factor: f })) return;
        this.rig.zoom(f);
      },
      scroll: (dx, dy) => {
        if (!this.inspector.active && this.level?.onGesture?.({ type: "scroll", dx, dy })) return;
        if (this.inspector.active) {
          this.inspector.drag(-dy * 0.3, 0);
          return;
        }
        this.rig.scroll(Math.abs(dx) > Math.abs(dy) ? dx : dy);
      },
      tap: (x, y) => this.tap(x, y),
      hover: (x, y) => {
        this.rig.look.yawGoal = -(x / window.innerWidth - 0.5) * 0.05;
        this.rig.look.pitchGoal = -(y / window.innerHeight - 0.5) * 0.035;
        this.hoverAt(x, y);
      },
      key: (e) => {
        if (this.level?.onKey?.(e)) return;
        const step = 60;
        if (e.key === "Escape") this.closeGame();
        else if (this.inspector.active && (e.key === "ArrowRight" || e.key === "ArrowLeft")) this.step(e.key === "ArrowRight" ? 1 : -1);
        else if (this.inspector.active && e.key === "f") this.inspector.flip();
        else if (e.key === "ArrowRight") this.rig.pan(-step, 0);
        else if (e.key === "ArrowLeft") this.rig.pan(step, 0);
        else if (e.key === "ArrowUp") this.rig.pan(0, step);
        else if (e.key === "ArrowDown") this.rig.pan(0, -step);
        else if (e.key === "+" || e.key === "=") this.rig.zoom(0.85);
        else if (e.key === "-") this.rig.zoom(1.18);
        else return;
        if (e.key.startsWith("Arrow")) setTimeout(() => this.rig.endPan(), 0);
      },
    };
    // ignore input while a world switches (and before the first one is up)
    this.input.handlers = Object.fromEntries(
      Object.entries(handlers).map(([k, fn]) => [k, (...a: any[]) => (this.loadingLevel || !this.active ? undefined : (fn as any)(...a))]),
    ) as Input["handlers"];
  }

  // ---- desktop hover: lift the game under the pointer + show its title ----------------------
  private hovered: { id: string; field: MediaField; base: THREE.Matrix4 } | null = null;
  private hoverT = 0;
  private hoverAt(x: number, y: number) {
    const now = performance.now();
    if (now - this.hoverT < 50 || this.inspector.active || off("hover")) return;
    this.hoverT = now;
    const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.engine.camera);
    let best: { d: number; game: Game; field: MediaField } | null = null;
    for (const f of this.level?.fields ?? []) {
      if (f.holo && f.group.parent === null) continue;
      const hit = f.raycast(this.raycaster.ray);
      if (hit && hit.distance < 6 && (!best || hit.distance < best.d)) best = { d: hit.distance, game: hit.game, field: f };
    }
    const id = best?.game.id;
    if (id === this.hovered?.id) {
      this.hud.tooltip(best ? best.game : null, x, y);
      return;
    }
    this.unhover();
    if (best) {
      const m = best.field.matrixOf(best.game.id)!;
      const local = best.field.group.matrixWorld.clone().invert().multiply(m);
      this.hovered = { id: best.game.id, field: best.field, base: local };
      // nudge it 1.5 cm towards the viewer
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      const pos = new THREE.Vector3().setFromMatrixPosition(m);
      const toCam = this.engine.camera.position.clone().sub(pos).normalize();
      const axes = [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1)].map((a) => a.applyQuaternion(q));
      const out = axes.reduce((b, a) => (a.dot(toCam) > b.dot(toCam) ? a : b));
      const nudge = new THREE.Matrix4().makeTranslation(out.x * 0.015, 0.003, out.z * 0.015);
      best.field.setMatrix(best.game.id, local.clone().premultiply(nudge));
      best.field.setState(best.game.id, { highlight: 0.7 });
      this.engine.renderer.domElement.style.cursor = "pointer";
      this.audio.play("hover", { volume: 0.6 });
    }
    this.hud.tooltip(best ? best.game : null, x, y);
  }
  private unhover() {
    if (!this.hovered) return;
    const { id, field, base } = this.hovered;
    field.setMatrix(id, base);
    field.setState(id, { highlight: this.store.filtering && this.store.matches(this.store.byId.get(id)!) ? 0.35 : 0 });
    this.hovered = null;
    this.engine.renderer.domElement.style.cursor = "";
  }

  private tap(x: number, y: number) {
    this.unhover();
    this.hud.tooltip(null, 0, 0);
    if (this.inspector.active) {
      // tapping the hero flips it; tapping elsewhere closes
      const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.engine.camera);
      const hero = this.inspector.hero!;
      if (this.raycaster.intersectObject(hero.mesh, false).length) {
        this.audio.play("flip");
        this.inspector.flip();
      } else this.closeGame();
      return;
    }
    const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.engine.camera);
    let best: { d: number; run: () => void } | null = null;
    for (const f of this.level?.fields ?? []) {
      const hit = f.raycast(this.raycaster.ray);
      if (hit && (!best || hit.distance < best.d)) best = { d: hit.distance, run: () => this.openGame(hit.game) };
    }
    for (const p of this.active?.pickables ?? []) {
      if (!p.obj.visible) continue;
      const [hit] = this.raycaster.intersectObject(p.obj, true);
      if (hit && (!best || hit.distance < best.d)) best = { d: hit.distance, run: () => p.onTap(hit) };
    }
    best?.run();
  }

  private last = performance.now();
  private levelStart = performance.now();
  private loaded = false;
  private bursts = new Bursts();
  private burstColor = "#ffffff";
  private frame = () => {
    // high-refresh screens: render every Nth animation frame so we aim for ~60 fps, not 144
    const rafNow = performance.now();
    if (this.lastRaf) {
      // keep re-measuring: busy loading frames would hide a 120/144 Hz screen's real interval
      this.intervals.push(rafNow - this.lastRaf);
      if (this.intervals.length >= 120) {
        const c = frameCadence(this.intervals);
        this.intervals.length = 0;
        const key = c ? `${c.every}@${Math.round(1000 / c.refreshMs)}` : "";
        // (the first measurement is taken at once; later changes need two in a row to agree)
        if (c && (key === this.cadenceSeen || !this.cadenceSeen) && (c.every !== this.every || Math.abs(c.refreshMs - this.refreshMs) / this.refreshMs > 0.03)) {
          this.every = c.every;
          this.refreshMs = c.refreshMs;
          this.governor?.setBudget(c.every * c.refreshMs);
          this.fps?.setTarget(c.every * c.refreshMs);
        }
        this.cadenceSeen = key;
      }
    }
    this.lastRaf = rafNow;
    if (++this.tick % this.every) return;
    if (!this.active) {
      this.engine.render();
      return;
    }
    const work0 = performance.now();
    const sp = this.active.post, ep = this.engine.post;
    ep.bloomStrength.value = sp.bloomStrength.value;
    ep.bloomRadius.value = sp.bloomRadius.value;
    ep.bloomThreshold.value = sp.bloomThreshold.value;
    ep.vignette.value = sp.vignette.value;
    ep.grain.value = sp.grain.value;
    this.engine.renderer.toneMappingExposure = sp.exposure.value;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const t = now / 1000;
    neonFx.since.value = (now - this.levelStart) / 1000;
    if (this.rig.idle > 75 && !this.inspector.active) this.rig.scroll(dt * 22); // attract-mode drift
    this.rig.update(dt);
    this.level?.update(dt, t);
    for (const f of this.level?.fields ?? []) {
      f.update(dt);
      if (!off("overlays")) f.detail(this.engine.camera, dt, this.engine.quality.mobile ? 12 : 24);
    }
    for (const fn of this.active?.tickers ?? []) fn(dt, t);
    this.inspector.update(dt, t);
    this.bursts.update(dt);
    if (!off("audio")) this.audio.update(this.engine.camera);
    this.engine.render();
    // timing for the governor, the FPS meter and the profiler
    const cpu = performance.now() - work0;
    const fdt = this.lastRender ? work0 - this.lastRender : 16.7;
    this.lastRender = work0;
    const gpu = this.engine.gpuMs;
    this.samples.push({ t: work0, dt: fdt, cpu, gpu });
    if (this.samples.length > 4000) this.samples.splice(0, 1000);
    this.governor.frame(fdt, cpu, gpu);
    this.fps.push(fdt);
    // a late frame within a second of a background shader build: if that keeps happening (6 in
    // 10 s), background prebuilding isn't free on this device, so it stops for the visit
    if (!this.bgOff && work0 - this.engine.backgroundBuild.at < 1000 && fdt > this.governor.frameBudget * 1.5) {
      this.bgLate.push(work0);
      while (this.bgLate.length && work0 - this.bgLate[0] > 10000) this.bgLate.shift();
      if (this.bgLate.length >= 6) {
        this.bgOff = true;
        console.info("[prebuild] background compiling cost frames on this device: the other rooms compile when you switch to them");
      }
    }
    if (this.debug) this.debugStats(dt);
  };

  /** Apply quality settings (from the governor, the profiler, or at startup). */
  applyQuality(s: QualitySettings, changed: (keyof QualitySettings)[]) {
    const cam = this.engine.camera;
    if (changed.includes("dpr")) this.engine.setDpr(s.dpr);
    if (changed.includes("bloom")) this.engine.setBloom(s.bloom);
    if (changed.includes("fx")) {
      live.fx = s.fx;
      if (s.fx) cam.layers.enable(LAYER.fx);
      else cam.layers.disable(LAYER.fx);
    }
    // props only come or go between rooms (or on the first apply), never in plain view
    if (changed.includes("decor") && (!this.active || changed.length > 1)) this.applyDecor(s.decor);
    if (changed.includes("hiRes")) {
      live.hiRes = s.hiRes;
      if (s.hiRes && this.art && !off("upgrade")) this.art.ready.then(() => this.art.upgrade());
    }
    if (this.fps) this.fps.note = `${s.dpr}x${s.bloom ? "" : " nb"}${s.fx ? "" : " nf"}${s.msaa ? "" : " fx"}`;
  }

  private applyDecor(on: boolean) {
    live.decor = on;
    if (on) this.engine.camera.layers.enable(LAYER.decor);
    else this.engine.camera.layers.disable(LAYER.decor);
  }

  private debugStats(dt: number) {
    this.frames.push(dt);
    if (this.frames.length < 30) return;
    const avg = this.frames.reduce((a, b) => a + b, 0) / this.frames.length;
    const worst = Math.max(...this.frames);
    this.frames = [];
    const info = this.engine.renderer.info;
    const stats = {
      fps: Math.round(1 / avg),
      ms: +(avg * 1000).toFixed(1),
      worstMs: +(worst * 1000).toFixed(1),
      dpr: +this.engine.dpr.toFixed(2),
      backend: this.engine.backend,
      calls: info.render.drawCalls,
      tris: info.render.triangles,
    };
    (window as any).__perf = stats;
    this.hud.debug(`${stats.fps} fps  ${stats.ms}ms (worst ${stats.worstMs})\n${stats.backend}  dpr ${stats.dpr}\ncalls ${stats.calls}  tris ${(stats.tris / 1000).toFixed(0)}k`);
  }
}

function loadFonts() {
  const fams = ['"Press Start 2P"', '"VT323"', '"Oswald"', '"Barlow Condensed"', '"Inter"', '"Silkscreen"', '"Monoton"', '"Tilt Neon"', '"Cinzel"', '"IM Fell English"'];
  return Promise.all(fams.flatMap((f) => [document.fonts.load(`400 24px ${f}`), document.fonts.load(`700 24px ${f}`)])).catch(() => {});
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Resolve when the browser is idle (or after `ms` at the latest). */
const idle = (ms: number) =>
  new Promise<void>((r) => {
    const w = window as any;
    if (w.requestIdleCallback) w.requestIdleCallback(() => r(), { timeout: ms });
    else setTimeout(r, Math.min(ms, 50));
  });
function tween(ms: number, fn: (k: number) => void) {
  return new Promise<void>((resolve) => {
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      fn(k);
      if (k < 1) requestAnimationFrame(step);
      else resolve();
    };
    step();
  });
}

/** Are all the visible worlds built (the load test waits for this)? */
function allRoomsBuilt(app: App) {
  return Object.keys(LEVELS).every((id) => LEVELS[id].hidden || (app as any).slots.get(id)?.compiled);
}
