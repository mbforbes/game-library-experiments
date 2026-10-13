// Art store: cover atlases (all games, low-res, always resident), procedural fallback covers
// for games without art, and on-demand hi-res covers / gameplay snaps with an LRU cache.

import * as THREE from "three/webgpu";
import type { Game } from "../../shared/types";
import { platformOf } from "../../shared/platforms";

type Rect5 = [number, number, number, number, number];
export interface ArtEntry {
  a?: Rect5; // box front in the cover atlas
  c?: string; // hi-res box front
  w?: number;
  h?: number;
  col?: string;
  s?: string[];
  t?: string;
  px?: 1;
  y?: number;
  src?: string;
  ka?: Rect5; // cartridge photo in the cover atlas
  k?: string; // hi-res cartridge photo
  kb?: string; // cartridge back
  sp?: Rect5; // real spine in the spine atlas
  spc?: string; // hi-res spine
  b?: string; // back cover
  l?: string; // clear logo
  d?: string; // disc
  r?: string; // ESRB short code
  pub?: string;
  pl?: number;
}
interface Manifest {
  version: string;
  atlas: { hi: string[]; lo: string[]; size: number };
  spines?: { hi: string[]; lo: string[]; size: number };
  games: Record<string, ArtEntry>;
}

export interface CoverRef {
  page: number; // texture index into `pages`
  rect: [number, number, number, number]; // u, v (from top), w, h in atlas UV
  aspect: number; // width / height of the cover image
}

const ART = "/art/";
const FB_SIZE = 2048, FB_W = 128, FB_H = 176;

export class ArtStore {
  manifest: Manifest = { version: "none", atlas: { hi: [], lo: [], size: 4096 }, games: {} };
  pages: THREE.Texture[] = [];
  /** real spine scans (build-time atlas); shader page index = i + 1 (0 = runtime spine canvas) */
  spinePages: THREE.Texture[] = [];
  private texCache = new Map<string, Promise<THREE.Texture | null>>();
  private fallbackCanvas = document.createElement("canvas");
  private fallbackTex!: THREE.CanvasTexture;
  private fallbackSlots = new Map<string, CoverRef>();
  private hiCache = new Map<string, Promise<THREE.Texture | null>>();
  private snapCache = new Map<string, Promise<THREE.Texture | null>>();
  private loader = { loadAsync: (url: string) => loadImage(url).then((img) => new THREE.Texture(img as any)) };
  maxAnisotropy = 8;
  /** resolves when the light atlases have arrived */
  ready: Promise<void> = Promise.resolve();

  constructor(private tier: "hi" | "lo") {}

  async load(onProgress?: (f: number) => void): Promise<void> {
    try {
      const res = await fetch(ART + "manifest.json");
      if (res.ok) this.manifest = await res.json();
    } catch {}
    // The world is built immediately with placeholder atlas pages (spines are generated locally,
    // so shelves look complete); the light atlases stream in and swap into place. Desktop later
    // upgrades to the sharp atlases the same way.
    const files = this.manifest.atlas.lo;
    const spineFiles = this.manifest.spines?.lo ?? [];
    const mk = () => {
      const t = new THREE.Texture(placeholder());
      this.prep(t);
      return t;
    };
    this.pages = files.map(mk);
    this.spinePages = spineFiles.map(mk);
    let done = 0;
    const all = [...files.map((f, i) => [f, this.pages[i]] as const), ...spineFiles.map((f, i) => [f, this.spinePages[i]] as const)];
    this.ready = Promise.all(
      all.map(async ([f, tex]) => {
        try {
          swapImage(tex, await loadImage(ART + f));
        } catch {}
        onProgress?.(++done / all.length);
      }),
    ).then(() => {});
    this.fallbackCanvas.width = this.fallbackCanvas.height = FB_SIZE;
    const ctx = this.fallbackCanvas.getContext("2d")!;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, FB_SIZE, FB_SIZE);
    this.fallbackTex = new THREE.CanvasTexture(this.fallbackCanvas);
    this.prep(this.fallbackTex);
    this.pages.push(this.fallbackTex);
  }

  /** Desktop: replace the lo atlases with hi-res ones once the scene is up. */
  async upgrade() {
    if (this.tier !== "hi") return;
    const jobs = [...this.manifest.atlas.hi.map((f, i) => [f, this.pages[i]] as const), ...(this.manifest.spines?.hi ?? []).map((f, i) => [f, this.spinePages[i]] as const)];
    for (const [f, tex] of jobs) {
      try {
        swapImage(tex, await loadImage(ART + f));
      } catch {}
    }
  }

  private prep(t: THREE.Texture) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    t.anisotropy = this.maxAnisotropy;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
  }

  get fallbackPage() {
    return this.pages.length - 1;
  }

  entry(g: Game): ArtEntry | undefined {
    return this.manifest.games[g.artKey];
  }

  has(g: Game) {
    return !!this.entry(g)?.a;
  }

  /** Dominant colour of the cover art (or the platform shell colour). */
  color(g: Game): string {
    return this.entry(g)?.col ?? platformOf(g.platform).spine;
  }

  year(g: Game): number | undefined {
    return g.year ?? this.entry(g)?.y;
  }

  cover(g: Game): CoverRef {
    const e = this.entry(g);
    if (e?.a && e.a[0] < this.pages.length - 1) {
      const [page, u, v, w, h] = e.a;
      return { page, rect: [u, v, w, h], aspect: (w / h) * 1 };
    }
    return this.fallback(g);
  }

  /** Procedural cover drawn into the fallback atlas (title typography on platform colours). */
  private fallback(g: Game): CoverRef {
    const hit = this.fallbackSlots.get(g.artKey);
    if (hit) return hit;
    const i = this.fallbackSlots.size;
    const cols = Math.floor(FB_SIZE / FB_W);
    const x = (i % cols) * FB_W, y = Math.floor(i / cols) * FB_H;
    if (y + FB_H > FB_SIZE) return { page: this.fallbackPage, rect: [0, 0, FB_W / FB_SIZE, FB_H / FB_SIZE], aspect: FB_W / FB_H };
    drawProceduralCover(this.fallbackCanvas.getContext("2d")!, x, y, FB_W, FB_H, g);
    this.fallbackTex.needsUpdate = true;
    const ref: CoverRef = { page: this.fallbackPage, rect: [x / FB_SIZE, y / FB_SIZE, FB_W / FB_SIZE, FB_H / FB_SIZE], aspect: FB_W / FB_H };
    this.fallbackSlots.set(g.artKey, ref);
    // a game the art build hasn't seen yet (new sheet row): ask the Worker for real art
    if (!this.entry(g)) this.queueRuntime(g, x, y);
    return ref;
  }

  // ---- runtime art for new sheet rows ------------------------------------------------------
  private runtime = new Map<string, string>(); // artKey -> proxied cover URL
  private queue: (() => Promise<void>)[] = [];
  private active = 0;
  private queueRuntime(g: Game, x: number, y: number) {
    this.queue.push(async () => {
      const LS = "coopers-library-runtime-art";
      let known: Record<string, string | null> = {};
      try {
        known = JSON.parse(localStorage.getItem(LS) ?? "{}");
      } catch {}
      let cover = known[g.artKey];
      if (cover === undefined) {
        try {
          const q = new URLSearchParams({ platform: g.platform, title: g.title, ...(g.year ? { year: String(g.year) } : {}) });
          const r = await fetch(`/api/art?${q}`);
          cover = r.ok ? ((await r.json()).cover ?? null) : null;
          known[g.artKey] = cover ?? null;
          localStorage.setItem(LS, JSON.stringify(known));
        } catch {
          return;
        }
      }
      if (!cover) return;
      const proxied = `/api/img?u=${encodeURIComponent(cover)}`;
      const img = await loadImage(proxied).catch(() => null);
      if (!img) return;
      this.runtime.set(g.artKey, proxied);
      const ctx = this.fallbackCanvas.getContext("2d")!;
      const s = Math.max(FB_W / img.width, FB_H / img.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, FB_W, FB_H);
      ctx.clip();
      ctx.drawImage(img, x + (FB_W - img.width * s) / 2, y + (FB_H - img.height * s) / 2, img.width * s, img.height * s);
      ctx.restore();
      this.fallbackTex.needsUpdate = true;
    });
    this.pump();
  }
  private pump() {
    while (this.active < 3 && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      job().finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  /** Cartridge photo (alpha cut-out) in the cover atlas, if we have one. */
  cartPhoto(g: Game): CoverRef | null {
    const e = this.entry(g);
    if (!e?.ka || e.ka[0] >= this.pages.length - 1) return null;
    const [page, u, v, w, h] = e.ka;
    return { page, rect: [u, v, w, h], aspect: w / h };
  }

  /** Real spine scan in the spine atlas: shader page index (1-based) + rect. */
  realSpine(g: Game): { page: number; rect: [number, number, number, number] } | null {
    const e = this.entry(g);
    if (!e?.sp || e.sp[0] >= this.spinePages.length) return null;
    const [page, u, v, w, h] = e.sp;
    return { page: page + 1, rect: [u, v, w, h] };
  }

  esrb(g: Game) {
    return this.entry(g)?.r;
  }
  publisher(g: Game) {
    return this.entry(g)?.pub;
  }

  /** Any processed image under /art (backs, spines, carts, logos, discs), cached. */
  tex(path: string | undefined): Promise<THREE.Texture | null> {
    if (!path) return Promise.resolve(null);
    let p = this.texCache.get(path);
    if (!p) {
      p = this.loader.loadAsync(ART + path).then(
        (t) => {
          this.prep(t);
          return t;
        },
        () => null,
      );
      this.texCache.set(path, p);
      this.trim(this.texCache, 50);
    }
    return p;
  }

  /** Hi-res cover texture for close-ups (null if the game has no art). */
  hiRes(g: Game): Promise<THREE.Texture | null> {
    const e = this.entry(g);
    const src = e?.c ? ART + e.c : this.runtime.get(g.artKey);
    if (!src) return Promise.resolve(null);
    let p = this.hiCache.get(g.artKey);
    if (!p) {
      p = this.loader.loadAsync(src).then(
        (t) => {
          this.prep(t);
          return t;
        },
        () => null,
      );
      this.hiCache.set(g.artKey, p);
      this.trim(this.hiCache, 40);
    }
    return p;
  }

  snapUrls(g: Game): string[] {
    const e = this.entry(g);
    return [...(e?.s ?? []), ...(e?.t ? [e.t] : [])];
  }

  snap(path: string, pixel = false): Promise<THREE.Texture | null> {
    let p = this.snapCache.get(path);
    if (!p) {
      p = this.loader.loadAsync(ART + path).then(
        (t) => {
          this.prep(t);
          if (pixel) {
            t.magFilter = THREE.NearestFilter;
          }
          return t;
        },
        () => null,
      );
      this.snapCache.set(path, p);
      this.trim(this.snapCache, 60);
    }
    return p;
  }

  private trim(cache: Map<string, Promise<THREE.Texture | null>>, max: number) {
    while (cache.size > max) {
      const [k, v] = cache.entries().next().value!;
      cache.delete(k);
      v.then((t) => t?.dispose());
    }
  }
}

// ---------------------------------------------------------------------------------------

/**
 * Fetch + decode an image OFF the main thread (ImageBitmap). Plain <img> elements get decoded
 * synchronously the moment they're uploaded to the GPU, which showed up as 100+ ms hitches
 * whenever covers streamed in while you moved around.
 */
let bitmapOpts: ImageBitmapOptions | undefined | null = typeof createImageBitmap === "function" ? { imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "none" } : null;
export async function loadImage(url: string): Promise<ImageBitmap | HTMLImageElement> {
  if (bitmapOpts !== null) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const blob = await res.blob();
    try {
      return await createImageBitmap(blob, bitmapOpts);
    } catch (err) {
      if (bitmapOpts && err instanceof TypeError) {
        // older Safari: no options bag
        bitmapOpts = undefined;
        return createImageBitmap(blob);
      }
      throw err;
    }
  }
  const img = await new THREE.ImageLoader().loadAsync(url);
  await img.decode?.().catch(() => {});
  return img;
}

/** Replace a texture's image with one of a different size (GPU texture is re-created). */
function swapImage(t: THREE.Texture, img: HTMLImageElement | ImageBitmap) {
  t.dispose();
  t.image = img;
  t.needsUpdate = true;
}

function placeholder() {
  const c = document.createElement("canvas");
  c.width = c.height = 4;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#1a1a22";
  ctx.fillRect(0, 0, 4, 4);
  return c;
}

export function drawProceduralCover(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, g: Game) {
  const p = platformOf(g.platform);
  ctx.save();
  ctx.translate(x, y);
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, p.shell);
  grad.addColorStop(1, "#0b0b10");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // platform band
  ctx.fillStyle = p.band;
  ctx.fillRect(0, 0, w, h * 0.12);
  ctx.fillStyle = p.bandText;
  ctx.font = `bold ${Math.round(h * 0.07)}px "Barlow Condensed", sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(p.short, w * 0.06, h * 0.065);
  // title, word-wrapped
  ctx.fillStyle = "#fff";
  ctx.shadowColor = p.neon;
  ctx.shadowBlur = 8;
  let size = Math.round(h * 0.11);
  const words = g.title.toUpperCase().split(/\s+/);
  let lines: string[] = [];
  for (; size > 8; size--) {
    ctx.font = `${size}px "Oswald", "Barlow Condensed", sans-serif`;
    lines = wrap(ctx, words, w * 0.86);
    if (lines.length * size * 1.1 < h * 0.7) break;
  }
  lines.forEach((l, i) => ctx.fillText(l, w * 0.07, h * 0.2 + size * 0.6 + i * size * 1.1));
  ctx.restore();
}

export function wrap(ctx: CanvasRenderingContext2D, words: string[], maxW: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
