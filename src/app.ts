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
import { LEVELS, DEFAULT_LEVEL } from "./levels";
import type { Level, LevelCtx } from "./levels/types";

export class App {
  engine!: Engine;
  rig!: CameraRig;
  input!: Input;
  store = new LibraryStore();
  art!: ArtStore;
  spines!: SpineAtlas;
  kit!: MediaKit;
  hud!: Hud;
  inspector!: Inspector;
  level: Level | null = null;
  private pickables: { obj: THREE.Object3D; onTap: (hit: THREE.Intersection) => void }[] = [];
  private tickers: ((dt: number, t: number) => void)[] = [];
  private raycaster = new THREE.Raycaster();
  private debug = new URLSearchParams(location.search).has("debug");
  private frames: number[] = [];
  private loadingLevel = false;

  async start(canvas: HTMLCanvasElement) {
    const t0 = performance.now();
    this.hud = new Hud(this.store, this.callbacks(), Object.entries(LEVELS).filter(([, l]) => !l.hidden).map(([id, l]) => ({ id, name: l.name, tagline: l.tagline })));
    try {
      this.hud.setProgress("Booting renderer…", 0.05);
      this.engine = await createEngine(canvas);
      this.art = new ArtStore(this.engine.quality.tier === "high" ? "hi" : "lo");
      this.hud.art = this.art;
      this.hud.setProgress("Reading Cooper's spreadsheet…", 0.15);
      const fontsReady = loadFonts();
      await Promise.all([this.store.load(), this.art.load(), fontsReady]);
      this.hud.setProgress("Printing spines…", 0.75);
      await nextFrame();
      this.spines = new SpineAtlas(this.engine.quality.mobile);
      this.spines.build(this.store.games, this.art);
      this.kit = makeMediaKit(this.art, this.spines);
      this.rig = new CameraRig(this.engine.camera);
      this.inspector = new Inspector(this.engine.scene, this.engine.camera, this.art);
      this.input = new Input(canvas);
      this.bindInput();
      this.store.on("filter", () => this.applyFilter());

      const params = new URLSearchParams(location.search);
      const id = params.get("level") ?? DEFAULT_LEVEL;
      await this.loadLevel(LEVELS[id] ? id : DEFAULT_LEVEL);
      console.info(`[library] ready in ${Math.round(performance.now() - t0)}ms (${this.engine.backend}, ${this.store.source})`);
      (window as any).__ready = performance.now() - t0;
      this.hud.hideLoading();
      this.engine.renderer.setAnimationLoop(this.frame);
      this.art.ready.then(() => setTimeout(() => this.art.upgrade(), 1000));
    } catch (err) {
      console.error(err);
      this.hud.showError(String((err as Error)?.message ?? err));
    }
  }

  private ctx(): LevelCtx {
    return {
      engine: this.engine,
      scene: this.engine.scene,
      camera: this.engine.camera,
      rig: this.rig,
      store: this.store,
      art: this.art,
      kit: this.kit,
      pickable: (obj, onTap) => this.pickables.push({ obj, onTap }),
      inspect: (g) => this.openGame(g),
      toast: (t, ms) => this.hud.toast(t, ms),
      onUpdate: (fn) => this.tickers.push(fn),
    };
  }

  async loadLevel(id: string) {
    if (this.loadingLevel) return;
    this.loadingLevel = true;
    const post = this.engine.post;
    // fade out
    if (this.level) {
      await tween(300, (k) => (post.fade.value = k));
      this.closeGame(true);
      this.level.dispose();
      this.pickables = [];
      this.tickers = [];
      this.engine.scene.clear();
      this.engine.scene.add(this.inspector["dimmer"]);
    }
    const factory = LEVELS[id];
    const level = (await factory.load())();
    this.level = level;
    await level.build(this.ctx(), (m) => this.hud.setProgress(m));
    this.hud.setLevel(level.name, factory.accent, level.stations);
    this.applyFilter();
    const url = new URL(location.href);
    url.searchParams.set("level", id);
    history.replaceState(null, "", url);
    // compile shaders before showing the frame to avoid hitches
    await this.engine.renderer.compileAsync(this.engine.scene, this.engine.camera).catch(() => {});
    await tween(450, (k) => (post.fade.value = 1 - k));
    this.loadingLevel = false;
  }

  private callbacks() {
    return {
      onSearchPick: (g: Game) => {
        this.level?.focusGame(g);
        setTimeout(() => this.openGame(g), 650);
      },
      onFilter: (f: any) => this.store.setFilter(f),
      onLevel: (id: string) => this.loadLevel(id),
      onClose: () => this.closeGame(),
      onFlip: () => this.inspector.flip(),
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
    this.inspector.layout = this.hud.isSide ? "side" : "top";
    this.inspector.open(g, this.fieldOf(g));
    this.store.select(g);
    this.hud.showGame(g);
    this.level?.onSelect?.(g);
  }

  closeGame(immediate = false) {
    if (!this.inspector.active) return;
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
    this.input.handlers = {
      pan: (dx, dy, dt) => {
        if (this.inspector.active) {
          dragHero = true;
          this.inspector.drag(dx, dy);
          return;
        }
        this.rig.pan(dx, dy, dt);
      },
      panEnd: () => {
        if (dragHero) {
          this.inspector.release();
          dragHero = false;
        }
        this.rig.endPan();
      },
      zoom: (f) => {
        if (!this.inspector.active) this.rig.zoom(f);
      },
      scroll: (dx, dy) => {
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
  }

  private tap(x: number, y: number) {
    if (this.inspector.active) {
      // tapping the hero flips it; tapping elsewhere closes
      const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.engine.camera);
      const hero = this.inspector.hero!;
      if (this.raycaster.intersectObject(hero.mesh, false).length) this.inspector.flip();
      else this.closeGame();
      return;
    }
    const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.engine.camera);
    let best: { d: number; run: () => void } | null = null;
    for (const f of this.level?.fields ?? []) {
      const hit = f.raycast(this.raycaster.ray);
      if (hit && (!best || hit.distance < best.d)) best = { d: hit.distance, run: () => this.openGame(hit.game) };
    }
    for (const p of this.pickables) {
      if (!p.obj.visible) continue;
      const [hit] = this.raycaster.intersectObject(p.obj, true);
      if (hit && (!best || hit.distance < best.d)) best = { d: hit.distance, run: () => p.onTap(hit) };
    }
    best?.run();
  }

  private last = performance.now();
  private frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const t = now / 1000;
    if (this.rig.idle > 75 && !this.inspector.active) this.rig.scroll(dt * 22); // attract-mode drift
    this.rig.update(dt);
    this.level?.update(dt, t);
    for (const f of this.level?.fields ?? []) {
      f.update(dt);
      f.detail(this.engine.camera, dt, this.engine.quality.mobile ? 12 : 24);
    }
    for (const fn of this.tickers) fn(dt, t);
    this.inspector.update(dt, t);
    this.engine.render();
    this.engine.adapt(dt);
    if (this.debug) this.debugStats(dt);
  };

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
