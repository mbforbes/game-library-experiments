// Audio engine: Web Audio, everything synthesized (no files to license or download).
//  • one-shot SFX for every interaction (optionally positioned in 3D)
//  • positional ambient emitters that only run while you're near them
//  • a per-level room reverb (small den, cathedral-sized tower, tiled lab)
// Starts on the first user gesture (browser autoplay rules); remembers the mute choice.

import * as THREE from "three/webgpu";
import { SFX, type SfxName } from "./sfx";

export interface EmitterSpec {
  position: THREE.Vector3;
  /** start the loop within this distance (m); it fades out beyond */
  radius: number;
  /** reference distance for the inverse falloff */
  ref?: number;
  volume?: number;
  /** build the loop; connect to `out`; return a stop function */
  build(ctx: AudioContext, out: AudioNode, noise: AudioBuffer): () => void;
  /** non-positional (fills the room), still distance-gated */
  ambient?: boolean;
}

interface Emitter extends EmitterSpec {
  running: { stop: () => void; gain: GainNode; panner?: PannerNode } | null;
  scope: string;
}

const LS = "coopers-library-sound";

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private musicBus!: GainNode;
  private musicEl: HTMLAudioElement | null = null;
  private musicUrl: string | null = null;
  private musicSwap = 0;
  private emitters: Emitter[] = [];
  private noise!: AudioBuffer;
  private _enabled = true;
  private camPos = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private up = new THREE.Vector3();
  onChange?: (on: boolean) => void;
  /**
   * Worlds stay alive in the background, so emitters and room acoustics belong to a scope (the
   * world that was building when they were added); only the active scope's emitters play.
   */
  scope = "";
  private activeScope = "";
  private rooms = new Map<string, { seconds: number; decay: number; wet: number }>();

  constructor() {
    try {
      this._enabled = localStorage.getItem(LS) !== "off";
    } catch {}
    const unlock = () => {
      this.start();
      this.startMusic();
      if (this.ctx?.state === "running") {
        window.removeEventListener("pointerup", unlock);
        window.removeEventListener("keydown", unlock);
        window.removeEventListener("touchend", unlock);
      }
    };
    window.addEventListener("pointerup", unlock);
    window.addEventListener("keydown", unlock);
    window.addEventListener("touchend", unlock);
    // hush when the tab is hidden
    document.addEventListener("visibilitychange", () => {
      if (!this.ctx) return;
      if (document.hidden) {
        this.musicEl?.pause();
        this.ctx.suspend().catch(() => {});
      } else if (this._enabled) {
        this.ctx.resume().catch(() => {});
        if (this.musicEl) this.playMusic();
      }
    });
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(v: boolean) {
    this._enabled = v;
    try {
      localStorage.setItem(LS, v ? "on" : "off");
    } catch {}
    if (v) {
      this.start();
      this.startMusic();
    } else this.musicEl?.pause();
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v ? 0.9 : 0, this.ctx.currentTime, 0.08);
    this.onChange?.(v);
  }

  /**
   * Create the (suspended) audio graph ahead of time — creating an AudioContext takes ~150 ms,
   * which used to land on your first click. The first gesture then only has to resume it.
   */
  prepare() {
    if (this.ctx) return;
    this.start(false);
  }

  private start(resume = true) {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: "interactive" });
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this._enabled ? 0.9 : 0;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.ambBus = ctx.createGain();
      this.ambBus.gain.value = 0.7;
      this.reverb = ctx.createConvolver();
      this.reverbSend = ctx.createGain();
      this.reverbSend.gain.value = 0.35;
      this.sfxBus.connect(this.master);
      this.ambBus.connect(this.master);
      this.sfxBus.connect(this.reverbSend);
      this.ambBus.connect(this.reverbSend);
      this.reverbSend.connect(this.reverb).connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = 0;
      this.musicBus.connect(this.master);
      this.noise = makeNoise(ctx, 2);
      this.setRoom(this.room);
    }
    if (resume && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
  }

  private room: { seconds: number; decay: number; wet: number } = { seconds: 0.8, decay: 3, wet: 0.25 };
  /** Room acoustics: impulse length, decay curve, wet level. */
  setRoom(r: { seconds: number; decay: number; wet: number }) {
    this.rooms.set(this.scope, r);
    if (this.scope !== this.activeScope) return;
    this.room = r;
    if (!this.ctx) return;
    this.reverb.buffer = makeImpulse(this.ctx, r.seconds, r.decay);
    this.reverbSend.gain.value = r.wet;
  }

  /** One-shot sound effect, optionally placed in the world. */
  play(name: SfxName, opts: { at?: THREE.Vector3; volume?: number; pitch?: number; delay?: number } = {}) {
    if (!this.ctx || !this._enabled || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = opts.volume ?? 1;
    let dest: AudioNode = this.sfxBus;
    if (opts.at) {
      const p = this.panner(opts.at, 1.5, 1.2);
      p.connect(this.sfxBus);
      dest = p;
    }
    out.connect(dest);
    const t = ctx.currentTime + (opts.delay ?? 0) + 0.005;
    const dur = SFX[name](ctx, out, t, this.noise, opts.pitch ?? 1);
    setTimeout(() => out.disconnect(), (dur + (opts.delay ?? 0) + 1.5) * 1000);
  }

  private panner(at: THREE.Vector3, ref: number, rolloff: number) {
    const ctx = this.ctx!;
    const p = ctx.createPanner();
    p.panningModel = matchMedia("(pointer: coarse)").matches ? "equalpower" : "HRTF";
    p.distanceModel = "inverse";
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = 40;
    if (p.positionX) {
      p.positionX.value = at.x;
      p.positionY.value = at.y;
      p.positionZ.value = at.z;
    } else (p as any).setPosition(at.x, at.y, at.z);
    return p;
  }

  // ---- music ------------------------------------------------------------------------------

  /** Very soft background music. One media element for all tracks (iOS unlocks it once). */
  static MUSIC_LEVEL = 0.2;
  music(url: string | null) {
    if (url === this.musicUrl) return;
    this.musicUrl = url;
    if (!this.musicEl) return; // starts on the first gesture (startMusic)
    const swap = ++this.musicSwap;
    const ctx = this.ctx!;
    this.musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.35);
    setTimeout(() => {
      if (swap !== this.musicSwap || !this.musicEl) return;
      if (!url) {
        this.musicEl.pause();
        return;
      }
      this.musicEl.src = url;
      this.playMusic();
    }, 1200);
  }

  private startMusic() {
    if (!this.ctx || !this._enabled || !this.musicUrl) return;
    if (!this.musicEl) {
      const el = new Audio();
      el.loop = true;
      el.preload = "auto";
      el.src = this.musicUrl;
      this.ctx.createMediaElementSource(el).connect(this.musicBus);
      this.musicEl = el;
    }
    this.playMusic();
  }

  private playMusic() {
    const el = this.musicEl!;
    if (!this._enabled || document.hidden) return;
    el.play()
      .then(() => this.musicBus.gain.setTargetAtTime(AudioEngine.MUSIC_LEVEL, this.ctx!.currentTime, 1.2))
      .catch(() => {});
  }

  /** Make a scope (world) the audible one: its room + emitters; everything else fades out. */
  activate(scope: string) {
    this.activeScope = scope;
    const prev = this.scope;
    this.scope = scope;
    const r = this.rooms.get(scope);
    if (r) this.setRoom(r);
    this.scope = prev;
    for (const e of this.emitters) if (e.scope !== scope) this.stopEmitter(e, 0.4);
  }

  addEmitter(spec: EmitterSpec) {
    const e: Emitter = { ...spec, running: null, scope: this.scope };
    this.emitters.push(e);
    return {
      move: (p: THREE.Vector3) => {
        e.position.copy(p);
        const pn = e.running?.panner;
        if (pn?.positionX) {
          pn.positionX.value = p.x;
          pn.positionY.value = p.y;
          pn.positionZ.value = p.z;
        }
      },
      remove: () => {
        this.stopEmitter(e, 0.2);
        this.emitters = this.emitters.filter((x) => x !== e);
      },
    };
  }

  /** Remove every emitter (level change). */
  clearEmitters() {
    for (const e of this.emitters) this.stopEmitter(e, 0.4);
    this.emitters = [];
  }

  private stopEmitter(e: Emitter, fade: number) {
    if (!e.running || !this.ctx) return;
    const r = e.running;
    e.running = null;
    r.gain.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
    setTimeout(() => {
      r.stop();
      r.gain.disconnect();
      r.panner?.disconnect();
    }, fade * 1000 + 200);
  }

  update(camera: THREE.Camera) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    camera.getWorldPosition(this.camPos);
    this.fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const L = ctx.listener;
    if (L.positionX) {
      const t = ctx.currentTime;
      L.positionX.setTargetAtTime(this.camPos.x, t, 0.03);
      L.positionY.setTargetAtTime(this.camPos.y, t, 0.03);
      L.positionZ.setTargetAtTime(this.camPos.z, t, 0.03);
      L.forwardX.setTargetAtTime(this.fwd.x, t, 0.03);
      L.forwardY.setTargetAtTime(this.fwd.y, t, 0.03);
      L.forwardZ.setTargetAtTime(this.fwd.z, t, 0.03);
      L.upX.value = this.up.x;
      L.upY.value = this.up.y;
      L.upZ.value = this.up.z;
    } else {
      (L as any).setPosition(this.camPos.x, this.camPos.y, this.camPos.z);
      (L as any).setOrientation(this.fwd.x, this.fwd.y, this.fwd.z, this.up.x, this.up.y, this.up.z);
    }
    // start / stop emitters by proximity
    for (const e of this.emitters) {
      if (e.scope !== this.activeScope) continue;
      const d = e.position.distanceTo(this.camPos);
      if (!e.running && d < e.radius && this._enabled) {
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.gain.setTargetAtTime(e.volume ?? 1, ctx.currentTime, 0.4);
        let panner: PannerNode | undefined;
        if (e.ambient) gain.connect(this.ambBus);
        else {
          panner = this.panner(e.position, e.ref ?? 1, 1.3);
          gain.connect(panner).connect(this.ambBus);
        }
        const stop = e.build(ctx, gain, this.noise);
        e.running = { stop, gain, panner };
      } else if (e.running && (d > e.radius * 1.25 || !this._enabled)) {
        this.stopEmitter(e, 0.6);
      }
    }
  }
}

function makeNoise(ctx: AudioContext, seconds: number) {
  const b = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function makeImpulse(ctx: AudioContext, seconds: number, decay: number) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return b;
}
