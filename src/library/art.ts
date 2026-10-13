// Art store: cover atlases (all games, low-res, always resident), procedural fallback covers
// for games without art, and on-demand hi-res covers / gameplay snaps with an LRU cache.

import * as THREE from "three/webgpu";
import type { Game } from "../../shared/types";
import { platformOf } from "../../shared/platforms";

export interface ArtEntry {
  a?: [number, number, number, number, number];
  c?: string;
  w?: number;
  h?: number;
  col?: string;
  s?: string[];
  t?: string;
  px?: 1;
  y?: number;
  src?: string;
}
interface Manifest {
  version: string;
  atlas: { hi: string[]; lo: string[]; size: number };
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
  private fallbackCanvas = document.createElement("canvas");
  private fallbackTex!: THREE.CanvasTexture;
  private fallbackSlots = new Map<string, CoverRef>();
  private hiCache = new Map<string, Promise<THREE.Texture | null>>();
  private snapCache = new Map<string, Promise<THREE.Texture | null>>();
  private loader = new THREE.TextureLoader();
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
    this.pages = files.map(() => {
      const t = new THREE.Texture(placeholder());
      this.prep(t);
      return t;
    });
    let done = 0;
    this.ready = Promise.all(
      files.map(async (f, i) => {
        try {
          const img = await new THREE.ImageLoader().loadAsync(ART + f);
          swapImage(this.pages[i], img);
        } catch {}
        onProgress?.(++done / files.length);
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
    const hi = this.manifest.atlas.hi;
    for (let i = 0; i < hi.length; i++) {
      try {
        const img = await new THREE.ImageLoader().loadAsync(ART + hi[i]);
        swapImage(this.pages[i], img);
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
    return ref;
  }

  /** Hi-res cover texture for close-ups (null if the game has no art). */
  hiRes(g: Game): Promise<THREE.Texture | null> {
    const e = this.entry(g);
    if (!e?.c) return Promise.resolve(null);
    let p = this.hiCache.get(g.artKey);
    if (!p) {
      p = this.loader.loadAsync(ART + e.c).then(
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

/** Replace a texture's image with one of a different size (GPU texture is re-created). */
function swapImage(t: THREE.Texture, img: HTMLImageElement) {
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
