// Synthesized sound effects + ambient loops. Each SFX schedules nodes at time `t` into `out`
// and returns its duration. Loops are EmitterSpec.build functions (return a stop function).

type Ctx = AudioContext;

const env = (g: GainNode, t: number, a: number, d: number, peak: number) => {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
};
const gainNode = (ctx: Ctx, v = 1) => {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
};
const osc = (ctx: Ctx, type: OscillatorType, f: number) => {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = f;
  return o;
};
const filt = (ctx: Ctx, type: BiquadFilterType, f: number, q = 1) => {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  return b;
};
const noiseSrc = (ctx: Ctx, noise: AudioBuffer, loop = false) => {
  const s = ctx.createBufferSource();
  s.buffer = noise;
  s.loop = loop;
  s.loopStart = 0;
  s.loopEnd = noise.duration;
  return s;
};

/** short filtered noise burst */
function burst(ctx: Ctx, out: AudioNode, t: number, noise: AudioBuffer, f: number, q: number, dur: number, peak: number, type: BiquadFilterType = "bandpass") {
  const s = noiseSrc(ctx, noise);
  const bf = filt(ctx, type, f, q);
  const g = gainNode(ctx, 0);
  env(g, t, 0.002, dur, peak);
  s.connect(bf).connect(g).connect(out);
  s.start(t, Math.random() * 1.5, dur + 0.05);
}

/** pitched blip */
function blip(ctx: Ctx, out: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, peak: number) {
  const o = osc(ctx, type, f0);
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = gainNode(ctx, 0);
  env(g, t, 0.004, dur, peak);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** noise swept through a band-pass (whooshes, slides) */
function sweep(ctx: Ctx, out: AudioNode, t: number, noise: AudioBuffer, f0: number, f1: number, dur: number, peak: number, q = 1.2) {
  const s = noiseSrc(ctx, noise);
  const bf = filt(ctx, "bandpass", f0, q);
  bf.frequency.setValueAtTime(f0, t);
  bf.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = gainNode(ctx, 0);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.45);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(bf).connect(g).connect(out);
  s.start(t, Math.random(), dur + 0.05);
}

export const SFX = {
  tick(ctx: Ctx, out: AudioNode, t: number, _n: AudioBuffer, p: number) {
    blip(ctx, out, t, "sine", 2300 * p, 1900 * p, 0.035, 0.12);
    return 0.05;
  },
  hover(ctx: Ctx, out: AudioNode, t: number, _n: AudioBuffer, p: number) {
    blip(ctx, out, t, "sine", 1600 * p, 1500 * p, 0.02, 0.025);
    return 0.03;
  },
  /** pulling a case off the shelf: plastic slide + clack */
  pull(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer, p: number) {
    sweep(ctx, out, t, n, 900 * p, 2600 * p, 0.14, 0.18, 2);
    burst(ctx, out, t + 0.12, n, 1900 * p, 2.5, 0.03, 0.35);
    blip(ctx, out, t + 0.12, "sine", 180 * p, 90, 0.07, 0.25);
    return 0.25;
  },
  /** sliding it back in */
  putback(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer, p: number) {
    sweep(ctx, out, t, n, 2400 * p, 800 * p, 0.16, 0.15, 2);
    burst(ctx, out, t + 0.15, n, 1400 * p, 2, 0.04, 0.4);
    blip(ctx, out, t + 0.15, "sine", 140 * p, 70, 0.09, 0.3);
    return 0.3;
  },
  flip(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer, p: number) {
    sweep(ctx, out, t, n, 350 * p, 2200 * p, 0.3, 0.22, 0.9);
    return 0.32;
  },
  travel(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer, p: number) {
    sweep(ctx, out, t, n, 180 * p, 900 * p, 0.5, 0.08, 0.7);
    sweep(ctx, out, t + 0.45, n, 900 * p, 220 * p, 0.5, 0.06, 0.7);
    return 1;
  },
  coin(ctx: Ctx, out: AudioNode, t: number, _n: AudioBuffer, p: number) {
    blip(ctx, out, t, "square", 988 * p, 988 * p, 0.08, 0.06);
    blip(ctx, out, t + 0.08, "square", 1319 * p, 1319 * p, 0.35, 0.06);
    return 0.45;
  },
  vend(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer, p: number) {
    const o = osc(ctx, "sawtooth", 62 * p);
    const lfo = osc(ctx, "sine", 9);
    const lg = gainNode(ctx, 8);
    lfo.connect(lg).connect(o.frequency);
    const lp = filt(ctx, "lowpass", 420, 1);
    const g = gainNode(ctx, 0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.08);
    g.gain.setValueAtTime(0.12, t + 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    o.connect(lp).connect(g).connect(out);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.9);
    lfo.stop(t + 0.9);
    burst(ctx, out, t + 0.86, n, 300, 1, 0.12, 0.5, "lowpass");
    blip(ctx, out, t + 0.86, "sine", 110, 60, 0.15, 0.3);
    return 1.1;
  },
  /** split-flap clatter */
  flap(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer, p: number) {
    for (let i = 0; i < 34; i++) burst(ctx, out, t + Math.random() * 0.9, n, 3200 * p * (0.8 + Math.random() * 0.4), 3, 0.006, 0.12 + Math.random() * 0.1);
    return 1;
  },
  channel(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer) {
    burst(ctx, out, t, n, 2600, 0.6, 0.28, 0.25);
    blip(ctx, out, t, "sine", 15000, 14000, 0.2, 0.02);
    return 0.35;
  },
  zap(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer, p: number) {
    blip(ctx, out, t, "sine", 1600 * p, 120 * p, 0.45, 0.2);
    blip(ctx, out, t, "triangle", 2400 * p, 300 * p, 0.3, 0.06);
    sweep(ctx, out, t, n, 4000, 600, 0.4, 0.08, 1);
    return 0.5;
  },
  /** a distant rumble only (a crack up front read as a loud click) */
  thunder(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer) {
    const s = noiseSrc(ctx, n, true);
    const lp = filt(ctx, "lowpass", 160, 0.8);
    const g = gainNode(ctx, 0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    const trem = osc(ctx, "sine", 5);
    const tg = gainNode(ctx, 0.3);
    trem.connect(tg).connect(g.gain);
    s.connect(lp).connect(g).connect(out);
    s.start(t);
    trem.start(t);
    s.stop(t + 3.3);
    trem.stop(t + 3.3);
    return 3.4;
  },
  /** an original little power-up jingle (Konami code) */
  jingle(ctx: Ctx, out: AudioNode, t: number) {
    const notes = [523, 659, 784, 1047, 784, 1047, 1319, 1568];
    notes.forEach((f, i) => blip(ctx, out, t + i * 0.075, "square", f, f, 0.07, 0.07));
    blip(ctx, out, t + notes.length * 0.075, "square", 2093, 2093, 0.4, 0.07);
    blip(ctx, out, t + notes.length * 0.075, "triangle", 523, 523, 0.45, 0.12);
    return 1.1;
  },
  /** a cat's "mrrp" */
  meow(ctx: Ctx, out: AudioNode, t: number, _n: AudioBuffer, p: number) {
    const o = osc(ctx, "sawtooth", 520 * p);
    o.frequency.setValueAtTime(480 * p, t);
    o.frequency.linearRampToValueAtTime(820 * p, t + 0.12);
    o.frequency.linearRampToValueAtTime(560 * p, t + 0.38);
    const vib = osc(ctx, "sine", 28);
    const vg = gainNode(ctx, 14);
    vib.connect(vg).connect(o.frequency);
    const f1 = filt(ctx, "bandpass", 1100, 5), f2 = filt(ctx, "bandpass", 2700, 7);
    const g = gainNode(ctx, 0);
    env(g, t, 0.03, 0.36, 0.25);
    o.connect(f1).connect(g);
    o.connect(f2).connect(g);
    g.connect(out);
    o.start(t);
    vib.start(t);
    o.stop(t + 0.45);
    vib.stop(t + 0.45);
    return 0.5;
  },
  portal(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer, p: number) {
    sweep(ctx, out, t, n, 200 * p, 3000 * p, 0.6, 0.18, 1.5);
    [110, 165].forEach((f) => blip(ctx, out, t, "sine", f * p, f * 2 * p, 0.7, 0.18));
    return 0.8;
  },
  boop(ctx: Ctx, out: AudioNode, t: number, _n: AudioBuffer, p: number) {
    blip(ctx, out, t, "sine", 680 * p, 430 * p, 0.16, 0.18);
    return 0.2;
  },
  /** the Archivist "speaking" */
  chatter(ctx: Ctx, out: AudioNode, t: number, _n: AudioBuffer, p: number) {
    const lp = filt(ctx, "lowpass", 2400, 1);
    lp.connect(out);
    for (let i = 0; i < 9; i++) {
      const f = (380 + Math.random() * 820) * p;
      blip(ctx, lp, t + i * 0.055, "square", f, f * (0.9 + Math.random() * 0.2), 0.045, 0.05);
    }
    return 0.6;
  },
  page(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer) {
    sweep(ctx, out, t, n, 1200, 4800, 0.22, 0.12, 1.4);
    burst(ctx, out, t + 0.2, n, 5200, 2, 0.05, 0.08);
    return 0.3;
  },
  /** CRT power-off between worlds */
  crtoff(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer) {
    blip(ctx, out, t, "sine", 90, 40, 0.45, 0.35);
    blip(ctx, out, t, "sawtooth", 7000, 300, 0.22, 0.02);
    burst(ctx, out, t, n, 6000, 1, 0.1, 0.05, "highpass");
    return 0.5;
  },
  /** CRT power-on: degauss thump + rising whine */
  crton(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer) {
    blip(ctx, out, t, "sine", 50, 120, 0.25, 0.3);
    blip(ctx, out, t + 0.05, "sine", 9000, 15600, 0.6, 0.012);
    burst(ctx, out, t, n, 300, 0.8, 0.3, 0.2, "lowpass");
    return 0.7;
  },
  /** a neon tube striking */
  neon(ctx: Ctx, out: AudioNode, t: number, n: AudioBuffer, p: number) {
    for (let i = 0; i < 4; i++) burst(ctx, out, t + i * 0.05 + Math.random() * 0.04, n, 4500 * p, 2, 0.012, 0.06);
    blip(ctx, out, t + 0.2, "sawtooth", 120, 120, 0.25, 0.015);
    return 0.5;
  },
  materialize(ctx: Ctx, out: AudioNode, t: number, _n: AudioBuffer, p: number) {
    for (let i = 0; i < 6; i++) blip(ctx, out, t + i * 0.04, "sine", (900 + i * 220) * p, (1000 + i * 260) * p, 0.08, 0.025);
    return 0.4;
  },
};
export type SfxName = keyof typeof SFX;

// ---------------------------------------------------------------------------------------------
// Ambient loops (EmitterSpec.build). Each returns a stop() function.

type Build = (ctx: Ctx, out: AudioNode, noise: AudioBuffer) => () => void;

/** Decoded recordings, shared by every emitter that loops them. */
const samples = new Map<string, Promise<AudioBuffer | null>>();
function loadSample(ctx: Ctx, url: string) {
  let p = samples.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
      .then((b) => ctx.decodeAudioData(b))
      .catch(() => null);
    samples.set(url, p);
  }
  return p;
}

/** Loop a recording (fades in once it has loaded). */
function sampleLoop(ctx: Ctx, out: AudioNode, url: string, level: number) {
  const g = gainNode(ctx, 0);
  g.connect(out);
  let src: AudioBufferSourceNode | null = null;
  let stopped = false;
  loadSample(ctx, url).then((buf) => {
    if (!buf || stopped) return;
    src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(g);
    src.start(ctx.currentTime, Math.random() * buf.duration);
    g.gain.setTargetAtTime(level, ctx.currentTime, 0.8);
  });
  return () => {
    stopped = true;
    try {
      src?.stop();
    } catch {}
  };
}

const stopAll = (nodes: (AudioScheduledSourceNode | null)[], timers: number[] = []) => () => {
  for (const n of nodes) {
    try {
      n?.stop();
    } catch {}
  }
  timers.forEach((id) => clearInterval(id));
};

export const LOOPS = {
  /** mains hum of a neon sign / tube */
  neonHum: ((ctx, out, noise) => {
    const g = gainNode(ctx, 1);
    g.connect(out);
    const os = [60, 120, 180].map((f, i) => {
      const o = osc(ctx, "sine", f);
      const og = gainNode(ctx, [0.03, 0.012, 0.004][i]);
      o.connect(og).connect(g);
      o.start();
      return o;
    });
    void noise;
    return stopAll(os);
  }) as Build,

  /** room-tone fluorescent buzz */
  fluorescent: ((ctx, out) => {
    const os = [120, 240, 360].map((f, i) => {
      const o = osc(ctx, i === 0 ? "sawtooth" : "sine", f);
      const lp = filt(ctx, "lowpass", 900, 0.7);
      const og = gainNode(ctx, [0.006, 0.003, 0.0015][i]);
      o.connect(lp).connect(og).connect(out);
      o.start();
      return o;
    });
    return stopAll(os);
  }) as Build,

  /** rain on the window: a real (public domain) recording, looped seamlessly */
  rain: ((ctx, out) => sampleLoop(ctx, out, "/audio/rain-v1.mp3", 0.9)) as Build,

  /** vending machine compressor */
  compressor: ((ctx, out, noise) => {
    const o = osc(ctx, "sine", 55);
    const o2 = osc(ctx, "triangle", 110);
    const og = gainNode(ctx, 0.08);
    const og2 = gainNode(ctx, 0.02);
    o.connect(og).connect(out);
    o2.connect(og2).connect(out);
    const s = noiseSrc(ctx, noise, true);
    const lp = filt(ctx, "lowpass", 280, 0.8);
    const ng = gainNode(ctx, 0.05);
    s.connect(lp).connect(ng).connect(out);
    [o, o2, s].forEach((n) => n.start());
    return stopAll([o, o2, s]);
  }) as Build,

  /** PC tower: fan whoosh + occasional hard-drive seeks */
  pc: ((ctx, out, noise) => {
    const s = noiseSrc(ctx, noise, true);
    const lp = filt(ctx, "lowpass", 600, 0.7);
    const g = gainNode(ctx, 0.05);
    s.connect(lp).connect(g).connect(out);
    s.start();
    const id = window.setInterval(() => {
      if (Math.random() < 0.35) {
        const t = ctx.currentTime;
        for (let i = 0; i < 4 + Math.random() * 6; i++) burst(ctx, out, t + i * 0.03, noise, 2400, 4, 0.008, 0.06);
      }
    }, 900);
    return stopAll([s], [id]);
  }) as Build,

  /** hologram: a soft airy hush with the odd faint sparkle (no steady tones: they rang) */
  holo: ((ctx, out, noise) => {
    const s = noiseSrc(ctx, noise, true);
    const bp = filt(ctx, "bandpass", 900, 0.5);
    const lfo = osc(ctx, "sine", 0.13);
    const lg = gainNode(ctx, 300);
    lfo.connect(lg).connect(bp.frequency);
    const g = gainNode(ctx, 0.012);
    s.connect(bp).connect(g).connect(out);
    s.start();
    lfo.start();
    const id = window.setInterval(() => {
      if (Math.random() < 0.12) blip(ctx, out, ctx.currentTime, "sine", 1800 + Math.random() * 1200, 2200 + Math.random() * 1200, 0.08, 0.004);
    }, 600);
    return stopAll([s, lfo], [id]);
  }) as Build,

  /** muffled TV game audio */
  tv: ((ctx, out, noise) => {
    const lp = filt(ctx, "lowpass", 1100, 0.8);
    lp.connect(out);
    const stop = chiptune(ctx, lp, 7, 0.35);
    void noise;
    return stop;
  }) as Build,

  /** tower wind */
  wind: ((ctx, out, noise) => {
    const s = noiseSrc(ctx, noise, true);
    const bp = filt(ctx, "bandpass", 400, 0.6);
    const lfo = osc(ctx, "sine", 0.07);
    const lg = gainNode(ctx, 250);
    lfo.connect(lg).connect(bp.frequency);
    const g = gainNode(ctx, 0.09);
    const lfo2 = osc(ctx, "sine", 0.11);
    const lg2 = gainNode(ctx, 0.05);
    lfo2.connect(lg2).connect(g.gain);
    s.connect(bp).connect(g).connect(out);
    [s, lfo, lfo2].forEach((n) => n.start());
    return stopAll([s, lfo, lfo2]);
  }) as Build,

  /** candle crackle */
  candles: ((ctx, out, noise) => {
    const id = window.setInterval(() => {
      const t = ctx.currentTime;
      if (Math.random() < 0.7) burst(ctx, out, t + Math.random() * 0.1, noise, 1500 + Math.random() * 2500, 3, 0.01 + Math.random() * 0.02, 0.05 + Math.random() * 0.08);
    }, 120);
    return stopAll([], [id]);
  }) as Build,

  /** a quiet choir-ish drone around the Codex */
  drone: ((ctx, out) => {
    const g = gainNode(ctx, 0.022);
    const lfo = osc(ctx, "sine", 0.2);
    const lg = gainNode(ctx, 0.008);
    lfo.connect(lg).connect(g.gain);
    g.connect(out);
    const os = [110, 164.8, 220, 277.2, 330].flatMap((f) =>
      [-2, 2].map((det) => {
        const o = osc(ctx, "triangle", f);
        o.detune.value = det * 4;
        o.connect(g);
        o.start();
        return o;
      }),
    );
    lfo.start();
    return stopAll([...os, lfo]);
  }) as Build,

  /** wing-flaps of the flying wish-books */
  flutter: ((ctx, out, noise) => {
    const id = window.setInterval(() => {
      if (Math.random() < 0.5) {
        const t = ctx.currentTime;
        for (let i = 0; i < 3; i++) burst(ctx, out, t + i * 0.08, noise, 700 + Math.random() * 500, 1.5, 0.05, 0.05);
      }
    }, 400);
    return stopAll([], [id]);
  }) as Build,

  /** portal drone */
  portalHum: ((ctx, out, noise) => {
    const g = gainNode(ctx, 0.07);
    g.connect(out);
    const lfo = osc(ctx, "sine", 0.6);
    const lg = gainNode(ctx, 0.025);
    lfo.connect(lg).connect(g.gain);
    const os = [55, 82.5, 110.7].map((f) => {
      const o = osc(ctx, "sine", f);
      o.connect(g);
      o.start();
      return o;
    });
    const s = noiseSrc(ctx, noise, true);
    const lp = filt(ctx, "lowpass", 260, 0.7);
    const ng = gainNode(ctx, 0.04);
    s.connect(lp).connect(ng).connect(out);
    s.start();
    lfo.start();
    return stopAll([...os, s, lfo]);
  }) as Build,

  /** pneumatic tubes: periodic whooshes */
  tubes: ((ctx, out, noise) => {
    const id = window.setInterval(() => {
      if (Math.random() < 0.5) sweep(ctx, out, ctx.currentTime, noise, 300, 2500, 0.7, 0.1, 1.2);
    }, 2200);
    return stopAll([], [id]);
  }) as Build,

  /** arcade attract-mode music (seeded original chiptune) */
  arcade: (seed: number) =>
    ((ctx, out) => {
      return chiptune(ctx, out, seed, 1);
    }) as Build,
};

/** A tiny sequencer: lead (square), bass (triangle), hats (noise). Original seeded melodies. */
function chiptune(ctx: Ctx, out: AudioNode, seed: number, level: number) {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const scale = [0, 3, 5, 7, 10, 12, 15, 17, 19];
  const root = [220, 196, 247, 262, 233][seed % 5];
  const steps = 32;
  const lead: (number | null)[] = [];
  let idx = 3;
  for (let i = 0; i < steps; i++) {
    if (rnd() < 0.28) lead.push(null);
    else {
      idx = Math.max(0, Math.min(scale.length - 1, idx + Math.round((rnd() - 0.5) * 4)));
      lead.push(root * 2 * Math.pow(2, scale[idx] / 12));
    }
  }
  const bassPat = [0, 0, 7, 0, 5, 5, 3, 7];
  const bpm = 120 + (seed % 4) * 12;
  const step = 60 / bpm / 2;
  const noise = (() => {
    const b = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  })();
  let next = ctx.currentTime + 0.1;
  let i = 0;
  const tick = () => {
    while (next < ctx.currentTime + 0.25) {
      const f = lead[i % steps];
      if (f) blip(ctx, out, next, "square", f, f, step * 0.85, 0.035 * level);
      if (i % 2 === 0) {
        const bf = (root / 2) * Math.pow(2, bassPat[(i / 2) % 8] / 12);
        blip(ctx, out, next, "triangle", bf, bf, step * 1.7, 0.08 * level);
      }
      if (i % 2 === 1) {
        const src = ctx.createBufferSource();
        src.buffer = noise;
        const hp = filt(ctx, "highpass", 7000, 0.7);
        const g = gainNode(ctx, 0);
        env(g, next, 0.001, 0.03, 0.03 * level);
        src.connect(hp).connect(g).connect(out);
        src.start(next);
      }
      next += step;
      i++;
    }
  };
  const id = window.setInterval(tick, 60);
  tick();
  return () => clearInterval(id);
}
