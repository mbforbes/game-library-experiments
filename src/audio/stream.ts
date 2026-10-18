// Music played from memory: the MP3 is downloaded (progressively), decoded a stretch at a time,
// and the stretches are scheduled back to back on the audio clock, crossfaded over a few ms at
// each seam. (Streaming an <audio> element into Web Audio, which iPhones need for volume since
// they ignore an element's own, wavers in pitch in Safari: its resampler speeds up and slows
// down to keep the element in step with the audio clock.) Only ~3 stretches are decoded at once.

/** frames per stretch (~12 s at 44.1 kHz), decoded with a few extra on each side */
const STRETCH = 460, PRE = 8, POST = 4;
/** crossfade at each seam (s); decode the next stretch when less than this is left (s) */
const XF = 0.02, AHEAD = 6;

const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** An MPEG Layer III frame header at `o`, or null. */
function header(b: Uint8Array, o: number) {
  if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[o + 1] >> 3) & 3, layer = (b[o + 1] >> 1) & 3, bri = b[o + 2] >> 4, sri = (b[o + 2] >> 2) & 3;
  if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return null;
  const v1 = ver === 3, rate = RATES[ver][sri];
  const len = Math.floor(((v1 ? 144000 : 72000) * (v1 ? BR1 : BR2)[bri]) / rate) + ((b[o + 2] >> 1) & 1);
  return { ver, rate, spf: v1 ? 1152 : 576, len, mono: b[o + 3] >> 6 === 3 };
}

/** The frames of an MP3 (byte ranges), found as its bytes arrive. */
class Frames {
  at: number[] = [];
  end: number[] = [];
  rate = 44100;
  spf = 1152;
  private pos = -1;
  private ver = -1;

  scan(b: Uint8Array, len: number) {
    if (this.pos < 0) {
      if (len < 10) return;
      // skip an ID3v2 tag (cover art and all)
      const id3 = b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33;
      this.pos = id3 ? 10 + (((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127)) + (b[5] & 0x10 ? 10 : 0) : 0;
    }
    while (this.pos + 4 <= len) {
      const h = header(b, this.pos);
      if (!h || (this.ver >= 0 && (h.ver !== this.ver || h.rate !== this.rate))) {
        this.pos++; // not a frame: look for the next one
        continue;
      }
      if (this.pos + h.len > len) return; // the rest of it hasn't arrived
      if (this.ver < 0) {
        this.ver = h.ver;
        this.rate = h.rate;
        this.spf = h.spf;
        // a Xing / Info / VBRI header frame holds no audio
        const side = h.ver === 3 ? (h.mono ? 17 : 32) : h.mono ? 9 : 17;
        const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
        const t = tag(this.pos + 4 + side);
        if (t === "Xing" || t === "Info" || tag(this.pos + 36) === "VBRI") {
          this.pos += h.len;
          continue;
        }
      }
      this.at.push(this.pos);
      this.end.push(this.pos + h.len);
      this.pos += h.len;
    }
  }
}

export class MusicStream {
  private bytes = new Uint8Array(0);
  private len = 0;
  private loaded = false;
  private failed = false;
  private frames = new Frames();
  private decoder: OfflineAudioContext;
  private playing_ = false;
  private gen = 0;
  private timer = 0;
  private busy = false;
  /** next stretch to schedule, and the audio-clock time it starts at */
  private next = 0;
  private at = 0;
  /** what's scheduled: when each stretch starts on the clock and its position in the track */
  private parts: { src: AudioBufferSourceNode; when: number; pos: number }[] = [];
  /** called when the first stretch is scheduled */
  onStart?: () => void;

  constructor(private ctx: AudioContext, private out: AudioNode, readonly url: string) {
    this.decoder = new OfflineAudioContext(2, 1, ctx.sampleRate);
    this.load();
  }

  get playing() {
    return this.playing_ && !this.failed;
  }

  /** Play from `pos` seconds into the track. */
  start(pos = 0) {
    this.stop();
    this.playing_ = true;
    const gen = ++this.gen;
    const stretchS = (STRETCH * this.frames.spf) / this.frames.rate;
    this.next = Math.floor(pos / stretchS);
    let skip = pos - this.next * stretchS;
    let started = false;
    this.at = 0;
    const tick = async () => {
      if (gen !== this.gen || this.busy || this.failed) return;
      const now = this.ctx.currentTime;
      if (this.at && this.at - now > AHEAD) return;
      const f = this.frames;
      const total = f.at.length;
      // looped back to the start once the whole track has played
      if (this.loaded && this.next * STRETCH >= total) this.next = 0;
      const first = this.next * STRETCH, last = Math.min(first + STRETCH, total);
      if (!this.loaded && total < last + POST) return; // still downloading
      if (last <= first) return;
      this.busy = true;
      try {
        const from = Math.max(0, first - PRE), to = Math.min(total, last + POST);
        const buf = await this.decoder.decodeAudioData(this.bytes.slice(f.at[from], f.end[to - 1]).buffer);
        if (gen !== this.gen) return;
        const spf = f.spf / f.rate;
        const into = Math.max(0, Math.min(skip, (last - first) * spf - 1));
        skip = 0;
        const lead = (first - from) * spf + into, dur = (last - first) * spf - into;
        // a seam starts XF/2 early and ends XF/2 late (where there's audio for it), fading across
        const pre = Math.min(XF / 2, lead), post = Math.min(XF / 2, Math.max(0, buf.duration - lead - dur));
        const t = this.ctx.currentTime;
        if (!this.at || this.at - pre < t + 0.03) this.at = t + 0.05 + pre; // first stretch, or running late
        const when = this.at - pre;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(1, when + pre + XF / 2);
        g.gain.setValueAtTime(1, this.at + dur - XF / 2);
        g.gain.linearRampToValueAtTime(0, this.at + dur + post);
        src.connect(g).connect(this.out);
        src.start(when, lead - pre, pre + dur + post);
        const part = { src, when: this.at, pos: first * spf + into };
        this.parts.push(part);
        src.onended = () => {
          g.disconnect();
          this.parts = this.parts.filter((p) => p !== part);
        };
        if (!started) {
          started = true;
          this.onStart?.();
        }
        this.at += dur;
        this.next++;
      } catch (e) {
        this.failed = true;
        console.warn("[music]", this.url, e);
      } finally {
        this.busy = false;
      }
      tick();
    };
    this.timer = window.setInterval(tick, 500);
    tick();
  }

  /** Stop (fading quickly); returns where it was, to start again from there. */
  stop(): number {
    const pos = this.position();
    this.gen++;
    this.playing_ = false;
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    for (const p of this.parts) {
      try {
        p.src.stop(t + 0.15);
      } catch {}
    }
    this.parts = [];
    return pos;
  }

  /** Seconds into the track right now. */
  position() {
    const now = this.ctx.currentTime;
    let pos = 0;
    for (const p of this.parts) if (p.when <= now) pos = p.pos + (now - p.when);
    return pos;
  }

  /** Stop and let go of the file. */
  dispose() {
    this.stop();
    this.failed = true;
    this.bytes = new Uint8Array(0);
  }

  private async load() {
    try {
      const res = await fetch(this.url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const size = +(res.headers.get("content-length") ?? 0);
      this.bytes = new Uint8Array(size > 0 ? size : 1 << 22);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.failed) return void reader.cancel();
        if (this.len + value.length > this.bytes.length) {
          const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.len + value.length));
          grown.set(this.bytes.subarray(0, this.len));
          this.bytes = grown;
        }
        this.bytes.set(value, this.len);
        this.len += value.length;
        this.frames.scan(this.bytes, this.len);
      }
      this.loaded = true;
    } catch (e) {
      this.failed = true;
      console.warn("[music]", this.url, e);
    }
  }
}
