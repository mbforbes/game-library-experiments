// THE VAULT (hidden): what Cooper's collection is worth.
//
// Reached through the little safe in the den or /vault, behind a password the Worker checks.
// The numbers come only from /api/vault/data (needs the vault cookie): dated PriceCharting
// snapshots kept in Workers KV by scripts/vault/price.ts. Each game is valued in its recorded
// condition (the sheet's optional "Condition" column), loose when none is recorded.
//
//   back wall  : the big number, with the date it was valued (front and centre), deposit boxes
//   left wall  : value over time (one point per valuation snapshot), then the collection
//   right wall : the most valuable games + value by platform, then the collection
//   the walls  : every priced game on gold display shelves, most valuable first, in value bands,
//                each with a price tag (the camera rides round the walls, so scrolling shows
//                them all; the room is as long as it needs to be to fit them)
//   front wall : the vault door, cracked ajar, with shelves either side

import * as THREE from "three/webgpu";
import { texture } from "three/tsl";
import type { Condition, Game } from "../../../shared/types";
import { platformOf } from "../../../shared/platforms";
import { wallRail, type Rail } from "../../engine/rail";
import { MediaField, templateOf, type Placement } from "../../media/field";
import { neonEnvironment } from "../../world/kit/env";
import { canvas, canvasTexture } from "../../world/kit/common";
import { DecorBuilder, roundedRect, type Vec3 } from "../../world/kit/decorkit";
import type { Level, LevelCtx, Station } from "../types";

const W = 8, H = 3.6;
/** room depth: at least 12 m, longer when the collection needs more wall (see layoutCollection) */
let D = 12;
const GOLD = "#ffcc55";

export interface VaultItem {
  id: string;
  title: string;
  platform: string;
  status: string;
  physical: "yes" | "assumed";
  prices: Partial<Record<Condition, number | null>>;
  url?: string;
  matchedTitle?: string;
  recorded?: number;
}
export interface VaultSnapshot {
  date: string;
  generatedAt: string;
  source: string;
  currency: string;
  assumptions: string[];
  items: VaultItem[];
  unpriced: { id: string; title: string; platform: string; reason: string }[];
  excluded: Record<string, number>;
}
export interface VaultIndexEntry {
  date: string;
  generatedAt: string;
  source: string;
  totals: { loose: number; cib: number; new: number; asOwned: number };
  priced: number;
  unpriced: number;
}

const money = (v: number) => "$" + Math.round(v).toLocaleString("en-US");
const longDate = (iso: string) => new Date(iso + (iso.length === 10 ? "T12:00:00" : "")).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
const COND_LABEL: Record<Condition, string> = { loose: "loose", cib: "complete in box", new: "new / sealed", graded: "graded", box: "box only", manual: "manual only" };

type Valued = { it: VaultItem; g: Game | undefined; cond: Condition; condRecorded: boolean; price: number };

// the collection's display shelves: 8 rows, a game every 20 cm, value bands with a gap between
const ROWS = 8, COL = 0.2, ROW = 0.285, BASE = 0.42, GAP = 0.3;
const TOP = BASE + ROWS * ROW; // the shelves' top cap
const BANDS = [
  { min: 100, label: "$100 AND UP", short: "$100+" },
  { min: 50, label: "$50 – $99", short: "$50–99" },
  { min: 25, label: "$25 – $49", short: "$25–49" },
  { min: 10, label: "$10 – $24", short: "$10–24" },
  { min: 0, label: "UNDER $10", short: "Under $10" },
];
type Band = (typeof BANDS)[number];
/** a straight run of wall holding shelves: from `a` along `dir`, facing the room along `nrm` */
interface Run {
  a: THREE.Vector3;
  dir: THREE.Vector3;
  nrm: THREE.Vector3;
  len: number;
  rot: number;
}
interface Layout {
  runs: Run[];
  cols: { run: Run; at: number; items: Valued[] }[];
  bands: { band: Band; run: Run; at: number; n: number; value: number; width: number }[];
}

export default function vault(): Level {
  let ctx: LevelCtx;
  const fields: MediaField[] = [];
  const stations: Station[] = [];
  const tickers: ((dt: number, t: number) => void)[] = [];
  const lamps: THREE.PointLight[] = [];
  /** priced games by id, with their rank (for the info panel) */
  const byId = new Map<string, { v: Valued; rank: number }>();
  let ranked = 0;
  let snapDate = "";
  let rail: Rail;

  const level: Level = {
    id: "vault",
    name: "The Vault",
    tagline: "What it's all worth.",
    stations,
    fields,

    async build(c, progress) {
      ctx = c;
      const { scene, engine, store } = c;
      engine.post.bloomStrength.value = 0.45;
      engine.post.bloomRadius.value = 0.4;
      engine.post.vignette.value = 0.55;
      engine.post.exposure.value = 1.0;
      D = 12;
      scene.background = new THREE.Color(0x06070a);
      scene.fog = new THREE.FogExp2(0x07080b, 0.02);
      scene.environmentIntensity = 0.7;
      scene.add(new THREE.HemisphereLight(0xfff0d8, 0x2a2018, 1.5));
      for (const [x, z] of [
        [-2, -1.2],
        [2, -1.2],
        [-0.9, 1.3],
        [0.9, 1.3],
      ]) {
        const l = new THREE.PointLight(0xffd59a, 11, 8, 1.4);
        l.position.set(x, H - 0.3, z);
        scene.add(l);
        lamps.push(l);
      }
      await progress("Spinning the dial…");

      // ---- the numbers (only with the vault cookie) ----
      let index: VaultIndexEntry[] = [];
      let snap: VaultSnapshot | null = null;
      try {
        const res = await fetch("/api/vault/data", { credentials: "same-origin" });
        if (res.ok) {
          const d = (await res.json()) as { index: VaultIndexEntry[]; snapshot: VaultSnapshot | null };
          index = d.index ?? [];
          snap = d.snapshot;
        }
      } catch {}
      // local layout testing only: ?vaultdemo fills in made-up prices (never on the live site)
      if (location.hostname === "localhost" && new URLSearchParams(location.search).has("vaultdemo")) ({ index, snap } = demoData(store.games));
      // each game in its recorded condition (from the live sheet), loose otherwise
      // (no price for that condition: the cheapest known price, same rule as the pricing script)
      const fallback = (it: VaultItem) => Math.min(...(["loose", "cib", "new"] as const).map((k) => it.prices[k] ?? Infinity));
      const priceOf = (it: VaultItem, cond: Condition) => {
        const p = it.prices[cond] ?? fallback(it);
        return isFinite(p) ? p : 0;
      };
      const valued: Valued[] = (snap?.items ?? []).map((it) => {
        const g = store.byId.get(it.id);
        const cond: Condition = g?.condition ?? "loose";
        return { it, g, cond, condRecorded: !!g?.condition, price: priceOf(it, cond) };
      });
      const total = valued.reduce((a, v) => a + v.price, 0);
      const recorded = valued.filter((v) => v.condRecorded).length;
      const assumed = valued.filter((v) => v.it.physical === "assumed").length;
      const sum = (k: Condition) => (snap?.items ?? []).reduce((a, it) => a + priceOf(it, k), 0);
      const top = [...valued].sort((a, b) => b.price - a.price);
      top.forEach((v, i) => byId.set(v.it.id, { v, rank: i + 1 }));
      ranked = top.length;
      snapDate = snap?.date ?? "";

      // every priced game that's still in the sheet goes on the walls: make the room long enough
      const shown = top.filter((v) => v.g);
      let lay = layoutCollection(shown);
      while (!lay && D < 40) {
        D += 1;
        lay = layoutCollection(shown);
      }
      scene.environment = neonEnvironment(engine.renderer, [
        { color: "#ffd27a", pos: [0, 4, 0], size: [6, 0.1, D - 2], intensity: 2.4 },
        { color: "#ffb347", pos: [-4.5, 1.6, 0], size: [0.1, 1.6, D / 2], intensity: 1.2 },
        { color: "#9ab6ff", pos: [4.5, 1.6, 0], size: [0.1, 1.6, D / 2], intensity: 0.8 },
      ]);
      for (const l of lamps) {
        l.position.z = l.position.z < 0 ? -D / 2 + 2.4 : D / 2 - 2.2;
        l.position.x = Math.sign(l.position.x) * 1.73; // under the lamps, between the ceiling beams
      }

      buildRoom(scene);
      await progress("Polishing the gold…");

      // ---- back wall: the big number + its date ----
      const value = board(3.6, 1.9, (x, w, h) => {
        x.textAlign = "center";
        x.fillStyle = "#c9a45c";
        x.font = `600 ${h * 0.055}px "Cinzel", serif`;
        x.fillText("THE COLLECTION OF COOPER", w / 2, h * 0.13);
        if (!snap) {
          x.fillStyle = GOLD;
          x.font = `700 ${h * 0.16}px "Cinzel", serif`;
          x.fillText("Not yet valued", w / 2, h * 0.5);
          x.fillStyle = "#b9b2a4";
          x.font = `400 ${h * 0.05}px "Inter", sans-serif`;
          x.fillText("The first valuation hasn't been recorded yet.", w / 2, h * 0.65);
          return;
        }
        x.fillStyle = GOLD;
        x.shadowColor = "#ffcf6a";
        x.shadowBlur = h * 0.03;
        x.font = `700 ${h * 0.25}px "Cinzel", serif`;
        x.fillText(money(total), w / 2, h * 0.42);
        x.shadowBlur = 0;
        x.fillStyle = "#e9e1cf";
        x.font = `500 ${h * 0.06}px "Inter", sans-serif`;
        x.fillText("estimated market value", w / 2, h * 0.53);
        // the date, very clearly
        x.fillStyle = "#14110b";
        const dateText = `VALUED ON ${longDate(snap.date).toUpperCase()}`;
        x.font = `700 ${h * 0.068}px "Oswald", sans-serif`;
        const tw = x.measureText(dateText).width + h * 0.12;
        x.fillStyle = GOLD;
        x.beginPath();
        x.roundRect(w / 2 - tw / 2, h * 0.6, tw, h * 0.11, h * 0.02);
        x.fill();
        x.fillStyle = "#14110b";
        x.fillText(dateText, w / 2, h * 0.68);
        x.fillStyle = "#b9b2a4";
        x.font = `400 ${h * 0.037}px "Inter", sans-serif`;
        const notes = [
          `${valued.length} physical games priced · ${snap.unpriced.length} couldn't be matched · digital copies not counted`,
          assumed ? `${assumed} of them are backlog games assumed to be physical copies (the sheet doesn't say) · marked * on the list` : "",
          recorded ? `${recorded} games in their recorded condition, the rest valued loose (cartridge/disc only)` : "Valued loose (cartridge/disc only, good condition): the sheet doesn't record condition yet",
          `Complete in box would be ~${money(sum("cib"))} · new/sealed ~${money(sum("new"))} · prices: ${snap.source}`,
        ].filter(Boolean);
        notes.forEach((n, i) => x.fillText(n, w / 2, h * (0.785 + i * (notes.length > 3 ? 0.048 : 0.058)), w * 0.92));
      });
      value.position.set(0, 1.75, -D / 2 + 0.04);
      scene.add(value);

      // ---- left wall: value over time ----
      const history = board(2.8, 1.6, (x, w, h) => {
        header(x, w, h, "VALUE OVER TIME", "one point per valuation");
        const pts = index.map((e) => ({ d: Date.parse(e.date), v: e.totals.asOwned }));
        const px0 = w * 0.12, px1 = w * 0.94, py0 = h * 0.86, py1 = h * 0.3;
        x.strokeStyle = "#5a4a2c";
        x.lineWidth = 2;
        x.beginPath();
        x.moveTo(px0, py1);
        x.lineTo(px0, py0);
        x.lineTo(px1, py0);
        x.stroke();
        if (!pts.length) {
          x.fillStyle = "#b9b2a4";
          x.font = `400 ${h * 0.05}px "Inter", sans-serif`;
          x.textAlign = "center";
          x.fillText("No valuations yet", w / 2, h * 0.6);
          return;
        }
        const vmax = Math.max(...pts.map((p) => p.v)) * 1.15, vmin = 0;
        const dmin = Math.min(...pts.map((p) => p.d)), dmax = Math.max(...pts.map((p) => p.d));
        const span = Math.max(dmax - dmin, 30 * 864e5);
        const X = (d: number) => (pts.length === 1 ? (px0 + px1) / 2 : px0 + ((d - dmin) / span) * (px1 - px0));
        const Y = (v: number) => py0 - ((v - vmin) / (vmax - vmin)) * (py0 - py1);
        // gridlines + labels
        x.font = `400 ${h * 0.035}px "Inter", sans-serif`;
        x.textAlign = "right";
        for (let k = 1; k <= 3; k++) {
          const v = (vmax * k) / 3;
          x.strokeStyle = "#2b2418";
          x.beginPath();
          x.moveTo(px0, Y(v));
          x.lineTo(px1, Y(v));
          x.stroke();
          x.fillStyle = "#8d826e";
          x.fillText(money(v), px0 - 8, Y(v) + 6);
        }
        x.strokeStyle = GOLD;
        x.lineWidth = 5;
        x.beginPath();
        pts.forEach((p, i) => (i ? x.lineTo(X(p.d), Y(p.v)) : x.moveTo(X(p.d), Y(p.v))));
        x.stroke();
        x.textAlign = "center";
        for (const p of pts) {
          x.fillStyle = GOLD;
          x.beginPath();
          x.arc(X(p.d), Y(p.v), 9, 0, Math.PI * 2);
          x.fill();
          x.fillStyle = "#e9e1cf";
          x.font = `600 ${h * 0.04}px "Inter", sans-serif`;
          x.fillText(money(p.v), X(p.d), Y(p.v) - 18);
          x.fillStyle = "#8d826e";
          x.font = `400 ${h * 0.034}px "Inter", sans-serif`;
          x.fillText(new Date(p.d).toLocaleDateString("en-US", { month: "short", year: "numeric" }), X(p.d), py0 + h * 0.05);
        }
        if (pts.length === 1) {
          x.fillStyle = "#8d826e";
          x.font = `italic 400 ${h * 0.034}px "Inter", sans-serif`;
          x.fillText("the first valuation: later ones extend this line", w / 2, h * 0.97);
        }
      });
      history.position.set(-W / 2 + 0.04, 1.7, -D / 2 + 2.1);
      history.rotation.y = Math.PI / 2;
      scene.add(history);

      // ---- right wall: most valuable + by platform ----
      const ranking = board(2.6, 1.7, (x, w, h) => {
        header(x, w, h, "MOST VALUABLE", `each in its recorded condition (loose if none)${assumed ? " · * assumed physical" : ""}`);
        x.textAlign = "left";
        top.slice(0, 10).forEach((v, i) => {
          const y = h * (0.31 + i * 0.065);
          x.fillStyle = "#8d826e";
          x.font = `600 ${h * 0.04}px "Oswald", sans-serif`;
          x.fillText(String(i + 1).padStart(2, " "), w * 0.05, y);
          x.fillStyle = "#e9e1cf";
          x.font = `500 ${h * 0.042}px "Inter", sans-serif`;
          x.fillText(`${v.it.title}${v.it.physical === "assumed" ? " *" : ""}`, w * 0.11, y, w * 0.55);
          x.fillStyle = "#8d826e";
          x.font = `400 ${h * 0.032}px "Inter", sans-serif`;
          x.fillText(`${platformOf(v.it.platform).short} · ${COND_LABEL[v.cond]}`, w * 0.68, y, w * 0.14);
          x.fillStyle = GOLD;
          x.font = `700 ${h * 0.045}px "Oswald", sans-serif`;
          x.textAlign = "right";
          x.fillText(money(v.price), w * 0.95, y);
          x.textAlign = "left";
        });
      });
      ranking.position.set(W / 2 - 0.04, 1.75, -D / 2 + 1.75);
      ranking.rotation.y = -Math.PI / 2;
      scene.add(ranking);

      const byPlat = new Map<string, number>();
      for (const v of valued) byPlat.set(v.it.platform, (byPlat.get(v.it.platform) ?? 0) + v.price);
      const plats = [...byPlat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9);
      const platforms = board(2.2, 1.5, (x, w, h) => {
        header(x, w, h, "BY PLATFORM", "");
        const max = Math.max(1, ...plats.map((p) => p[1]));
        plats.forEach(([p, v], i) => {
          const y = h * (0.27 + i * 0.075);
          x.textAlign = "left";
          x.fillStyle = "#e9e1cf";
          x.font = `500 ${h * 0.045}px "Oswald", sans-serif`;
          x.fillText(platformOf(p).short, w * 0.05, y + h * 0.035);
          x.fillStyle = "#2b2418";
          x.fillRect(w * 0.27, y, w * 0.5, h * 0.045);
          x.fillStyle = platformOf(p).neon;
          x.fillRect(w * 0.27, y, (w * 0.5 * v) / max, h * 0.045);
          x.fillStyle = GOLD;
          x.textAlign = "right";
          x.font = `600 ${h * 0.042}px "Oswald", sans-serif`;
          x.fillText(money(v), w * 0.95, y + h * 0.037);
        });
      });
      platforms.position.set(W / 2 - 0.04, 1.6, -D / 2 + 4.45);
      platforms.rotation.y = -Math.PI / 2;
      scene.add(platforms);

      // ---- the walls: the whole collection ----
      await progress("Stocking the shelves…");
      if (lay) buildCollection(scene, lay);

      buildDecor(scene);

      // ---- rail: a loop round the walls ----
      rail = wallRail(
        [
          [W / 2 - 0.4, D / 2 - 0.4],
          [W / 2 - 0.4, -D / 2 + 0.4],
          [-W / 2 + 0.4, -D / 2 + 0.4],
          [-W / 2 + 0.4, D / 2 - 0.4],
        ],
        // (never closer than 0.75 m to a wall: the ajar door reaches ~1.05 m into the room)
        { closed: true, h: [0.6, 3.0], d: [0.75, 4.6], h0: 1.7, d0: 3.2, lift: 0.1, round: 0.8 },
      );
      const sBack = rail.project(new THREE.Vector3(0, 0, -D / 2));
      // the opening view: back far enough to see the board in its room (narrow screens: as far as
      // the rail allows, the board is wide)
      const valueD = () => Math.min(4.6, Math.max(3.9, 4.6 / (2 * Math.tan(THREE.MathUtils.degToRad(c.rig.camera.fov / 2)) * (innerWidth / innerHeight))));
      // (portrait screens: the 3.6 m board needs more room than the rail has, so look at it from
      // down the room, far enough to fit its width)
      const valueView = (snap = false) => {
        const aspect = innerWidth / innerHeight;
        if (aspect >= 1) return c.rig.goTo({ s: sBack, h: 1.7, d: valueD() });
        const dist = Math.min(D - 1.5, 3.9 / (2 * Math.tan(THREE.MathUtils.degToRad(c.rig.camera.fov / 2)) * aspect));
        c.rig.goFree(new THREE.Vector3(0, 1.75, -D / 2 + dist), new THREE.Vector3(0, 1.75, -D / 2), snap);
      };
      c.rig.setRail(rail, { s: sBack, h: 1.7, d: valueD() });
      if (innerWidth < innerHeight) valueView(true);
      stations.push(
        { id: "value", label: "The Value", go: () => valueView() },
        { id: "history", label: "Over Time", go: () => c.rig.goTo({ s: rail.project(history.position), h: 1.7, d: 2.6 }) },
        { id: "top", label: "Most Valuable", go: () => c.rig.goTo({ s: rail.project(ranking.position), h: 1.75, d: 2.6 }) },
        { id: "platforms", label: "By Platform", go: () => c.rig.goTo({ s: rail.project(platforms.position), h: 1.6, d: 2.3 }) },
        // the collection, band by band: far enough back for all the shelves and the band's plate,
        // with the band's first games near the left edge of the screen (whatever its shape)
        ...(lay?.bands ?? []).map((b) => ({
          id: `band-${b.band.min}`,
          label: b.band.short,
          go: () => {
            const dd = 2.9;
            const seen = 2 * dd * Math.tan(THREE.MathUtils.degToRad(c.rig.camera.fov / 2)) * (innerWidth / innerHeight);
            const into = Math.max(0.2, Math.min(b.width / 2, seen / 2 - 0.25));
            c.rig.goTo({ s: rail.project(b.run.a.clone().addScaledVector(b.run.dir, b.at + into)), h: 1.68, d: dd });
          },
        })),
        { id: "door", label: "The Door", go: () => c.rig.goTo({ s: rail.project(new THREE.Vector3(0, 0, D / 2)), h: 1.6, d: 3.7 }) },
      );
    },

    update(dt, t) {
      for (const fn of tickers) fn(dt, t);
    },

    focusGame(g) {
      for (const f of fields) {
        const p = f.centerOf(g.id);
        if (!p) continue;
        // ride the rail round the walls to it
        ctx.rig.goTo({ s: rail.project(p), h: p.y, d: 0.85 });
        return;
      }
    },

    facts(g) {
      const e = byId.get(g.id);
      if (!e) return [];
      const { v, rank } = e;
      const f: [string, string][] = [
        ["Value", `${money(v.price)} · ${COND_LABEL[v.cond]}${v.condRecorded ? "" : " (assumed)"}`],
        ["Rank", `#${rank} of ${ranked}`],
      ];
      if (v.it.prices.cib != null && v.cond !== "cib") f.push(["Complete in box", money(v.it.prices.cib)]);
      if (v.it.prices.new != null && v.cond !== "new") f.push(["New / sealed", money(v.it.prices.new)]);
      if (v.it.physical === "assumed") f.push(["Physical copy", "assumed (the sheet doesn't say)"]);
      if (snapDate) f.push(["Valued", `${longDate(snapDate)} · PriceCharting`]);
      return f;
    },

    dispose() {
      for (const f of fields) f.dispose();
    },
  };

  // ---- the collection on the walls ---------------------------------------------------------------

  /**
   * Wall runs that hold the collection, each running left to right as you face it: from just
   * after "By Platform" on the right wall, along the front wall either side of the door, then the
   * left wall back to "Over Time". (The camera faces the wall, so its rail runs the other way.)
   */
  function wallRuns(): Run[] {
    const run = (x0: number, z0: number, x1: number, z1: number, nx: number, nz: number): Run => {
      const a = new THREE.Vector3(x0, 0, z0);
      const dir = new THREE.Vector3(x1 - x0, 0, z1 - z0);
      const len = dir.length();
      dir.normalize();
      return { a, dir, nrm: new THREE.Vector3(nx, 0, nz), len, rot: Math.atan2(nx, nz) };
    };
    return [
      run(W / 2, -D / 2 + 5.9, W / 2, D / 2 - 0.3, -1, 0), // right wall
      run(W / 2 - 0.3, D / 2, 1.8, D / 2, 0, -1), // front wall, right of the door (as you face it; clear of its hinge)
      run(-1.8, D / 2, -W / 2 + 0.3, D / 2, 0, -1), // front wall, left of the door (clear of its frame)
      run(-W / 2, D / 2 - 0.3, -W / 2, -D / 2 + 3.85, 1, 0), // left wall
    ];
  }

  /** Columns of ROWS games, band by band, most valuable first; null if they don't fit. */
  function layoutCollection(items: Valued[]): Layout | null {
    const runs = wallRuns();
    let ri = 0, off = 0;
    const next = () => {
      while (ri < runs.length && off + COL > runs[ri].len + 1e-6) {
        ri++;
        off = 0;
      }
      if (ri >= runs.length) return null;
      const c = { run: runs[ri], at: off + COL / 2 };
      off += COL;
      return c;
    };
    const lay: Layout = { runs, cols: [], bands: [] };
    for (const [bi, band] of BANDS.entries()) {
      const hi = bi ? BANDS[bi - 1].min : Infinity;
      const inBand = items.filter((v) => v.price >= band.min && v.price < hi);
      if (!inBand.length) continue;
      if (lay.bands.length && off > 0) off += GAP;
      // don't start a band in the last few columns of a wall: it starts on the next one
      if (ri < runs.length - 1 && runs[ri].len - off < 4 * COL && inBand.length > ROWS * Math.floor((runs[ri].len - off) / COL)) {
        ri++;
        off = 0;
      }
      for (let k = 0; k < inBand.length; k += ROWS) {
        const c = next();
        if (!c) return null;
        if (k === 0) lay.bands.push({ band, run: c.run, at: c.at - COL / 2, n: inBand.length, value: inBand.reduce((a, v) => a + v.price, 0), width: Math.ceil(inBand.length / ROWS) * COL });
        lay.cols.push({ ...c, items: inBand.slice(k, k + ROWS) });
      }
    }
    return lay;
  }

  /** Shelves (one merged mesh), the games (one field) and their price tags. */
  function buildCollection(scene: THREE.Scene, lay: Layout) {
    const at = (r: Run, along: number, y: number, out: number): Vec3 => {
      const p = r.a.clone().addScaledVector(r.dir, along).addScaledVector(r.nrm, out);
      return [p.x, y, p.z];
    };
    const d = new DecorBuilder({ atlasSize: 1024 });
    for (const r of lay.runs) {
      const cols = lay.cols.filter((c) => c.run === r);
      if (!cols.length) continue;
      const a0 = cols[0].at - COL / 2 - 0.05, a1 = cols[cols.length - 1].at + COL / 2 + 0.05;
      const len = a1 - a0, mid = (a0 + a1) / 2;
      const rot: Vec3 = [0, r.rot, 0];
      const put = (along: number, y: number, out: number, fn: () => void) => d.at(at(r, along, y, out), rot, fn);
      // velvet back, a closed base, gold-trimmed shelves with a light under each, a top cap
      put(mid, (BASE - 0.03 + TOP) / 2, 0.012, () => d.plane([len, TOP - BASE + 0.03], [0, 0, 0], "#4a1018", { rough: 0.95 }));
      put(mid, BASE / 2, 0.11, () => d.box([len, BASE, 0.2], [0, 0, 0], "#1d1a15", { rough: 0.4, metal: 0.2 }));
      for (let k = 0; k <= ROWS; k++) {
        const y = BASE + k * ROW;
        put(mid, y - 0.01, 0.1, () => d.box([len, 0.02, 0.18], [0, 0, 0], k === ROWS ? "#8a6a2c" : "#2a241b", { rough: 0.35, metal: k === ROWS ? 1 : 0.3 }));
        put(mid, y - 0.0225, 0.193, () => d.box([len, 0.045, 0.008], [0, 0, 0], "#8a6a2c", { metal: 1, rough: 0.3 }));
        if (k > 0) put(mid, y - 0.023, 0.16, () => d.box([len, 0.006, 0.012], [0, 0, 0], "#fff1c9", { glow: 1.6 })); // under the shelf above
      }
      for (const e of [a0, a1]) put(e, TOP / 2, 0.1, () => d.box([0.04, TOP, 0.2], [0, 0, 0], "#8a6a2c", { metal: 1, rough: 0.3 }));
    }
    // a gold plate above the start of each band
    for (const b of lay.bands) {
      const w = Math.max(0.6, Math.min(1.4, b.width));
      const tex = d.canvas(Math.round(w * 400), 72, (x, cw, ch) => {
        x.fillStyle = "#2a2010";
        x.fillRect(0, 0, cw, ch);
        x.strokeStyle = "#c9a45c";
        x.lineWidth = 3;
        x.strokeRect(2, 2, cw - 4, ch - 4);
        x.textBaseline = "middle";
        x.textAlign = "left";
        x.fillStyle = GOLD;
        x.font = `700 30px "Cinzel", serif`;
        x.fillText(b.band.label, 12, ch * 0.38, cw - 24);
        x.fillStyle = "#b9a983";
        x.font = `500 18px "Oswald", sans-serif`;
        x.fillText(`${b.n} game${b.n > 1 ? "s" : ""} · ${money(b.value)}`, 12, ch * 0.76, cw - 24);
      });
      // (a plate on the wall, not a sign floating in front of it)
      d.at(at(b.run, b.at + w / 2, TOP + 0.13, 0.015), [0, b.run.rot, 0], () => d.box([w, 0.18, 0.03], [0, 0, 0], "#ffffff", { tex, face: "front", glow: 0.45 }));
    }
    scene.add(d.build("vault-shelves", { essential: true }));

    // the games, standing on the shelves facing the room, and a tag on the shelf edge under each
    const placements: Placement[] = [];
    const UP = new THREE.Vector3(0, 1, 0);
    let tags = new DecorBuilder({ atlasSize: 2048 }), nTags = 0;
    for (const c of lay.cols)
      c.items.forEach((v, row) => {
        const y = BASE + (ROWS - 1 - row) * ROW;
        const [w, h, dep] = templateOf(v.g!, ctx.art).size;
        const sc = Math.min(1.1, 0.17 / w, 0.215 / h);
        const [px, , pz] = at(c.run, c.at, 0, 0.04 + (dep * sc) / 2);
        placements.push({ game: v.g!, position: new THREE.Vector3(px, y, pz), quaternion: new THREE.Quaternion().setFromAxisAngle(UP, c.run.rot), scale: sc });
        if (nTags === 750) {
          scene.add(tags.build("vault-tags", { essential: true }));
          tags = new DecorBuilder({ atlasSize: 2048 });
          nTags = 0;
        }
        const rank = byId.get(v.it.id)?.rank ?? 0;
        const uv = tags.canvas(132, 34, (x, tw, th) => drawTag(x, tw, th, v, rank));
        tags.at(at(c.run, c.at, y - 0.0225, 0.198), [0, c.run.rot, 0], () => tags.plane([0.17, 0.042], [0, 0, 0], "#ffffff", { tex: uv, glow: 0.35 }));
        nTags++;
      });
    if (nTags) scene.add(tags.build("vault-tags", { essential: true }));
    if (placements.length) {
      const f = new MediaField(ctx.kit, placements, { name: "collection" });
      scene.add(f.group);
      fields.push(f);
    }
  }

  /** A brass price tag: rank on the left, price on the right (* = assumed to be a physical copy). */
  function drawTag(x: CanvasRenderingContext2D, w: number, h: number, v: Valued, rank: number) {
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#3a2c12");
    g.addColorStop(1, "#1e160a");
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.strokeStyle = "#c9a45c";
    x.lineWidth = 2;
    x.strokeRect(1, 1, w - 2, h - 2);
    x.textBaseline = "middle";
    x.textAlign = "left";
    x.fillStyle = "#a8956b";
    x.font = `500 14px "Oswald", sans-serif`;
    x.fillText(`#${rank}`, 7, h / 2 + 1);
    x.textAlign = "right";
    x.fillStyle = GOLD;
    x.font = `600 22px "Oswald", sans-serif`;
    const price = v.price < 100 ? `$${v.price.toFixed(2)}` : money(v.price);
    x.fillText(price + (v.it.physical === "assumed" ? "*" : ""), w - 7, h / 2 + 1, w - 48);
  }

  // ---- drawing helpers --------------------------------------------------------------------------

  /** A dark board with a gold rim, drawn on a canvas. */
  function board(w: number, h: number, draw: (x: CanvasRenderingContext2D, W: number, H: number) => void) {
    const PX = 820;
    const [cv, x] = canvas(Math.round(w * PX), Math.round(h * PX));
    const CW = cv.width, CH = cv.height;
    const grad = x.createLinearGradient(0, 0, 0, CH);
    grad.addColorStop(0, "#15120c");
    grad.addColorStop(1, "#0b0907");
    x.fillStyle = grad;
    x.fillRect(0, 0, CW, CH);
    x.strokeStyle = "#8a6a2c";
    x.lineWidth = 8;
    x.strokeRect(14, 14, CW - 28, CH - 28);
    x.strokeStyle = "#3d2f15";
    x.lineWidth = 2;
    x.strokeRect(30, 30, CW - 60, CH - 60);
    x.textBaseline = "alphabetic";
    draw(x, CW, CH);
    const tex = canvasTexture(cv);
    tex.anisotropy = 8;
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.1 });
    m.colorNode = texture(tex).rgb;
    m.emissiveNode = texture(tex).rgb.mul(0.5);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    const back = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.04), new THREE.MeshStandardNodeMaterial({ color: 0x6b5324, roughness: 0.35, metalness: 0.9 }));
    back.position.z = -0.025;
    mesh.add(back);
    return mesh;
  }

  function header(x: CanvasRenderingContext2D, w: number, h: number, title: string, sub: string) {
    x.textAlign = "left";
    x.fillStyle = GOLD;
    x.font = `700 ${h * 0.085}px "Cinzel", serif`;
    x.fillText(title, w * 0.05, h * 0.15);
    if (sub) {
      x.fillStyle = "#8d826e";
      x.font = `400 ${h * 0.036}px "Inter", sans-serif`;
      x.fillText(sub, w * 0.05, h * 0.21);
    }
  }

  // ---- the room ---------------------------------------------------------------------------------

  function buildRoom(scene: THREE.Scene) {
    const d = new DecorBuilder({ atlasSize: 1024 });
    // brushed steel panels with rivets
    const steel = d.canvas(256, 256, (x, w, h) => {
      const g = x.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "#5a606a");
      g.addColorStop(1, "#3c414a");
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
      for (let i = 0; i < 120; i++) {
        x.fillStyle = `rgba(255,255,255,${0.02 + Math.random() * 0.03})`;
        x.fillRect(0, Math.random() * h, w, 1);
      }
      x.strokeStyle = "#16181c";
      x.lineWidth = 6;
      x.strokeRect(0, 0, w, h);
      x.fillStyle = "#8b929c";
      for (const [rx, ry] of [
        [14, 14],
        [w - 14, 14],
        [14, h - 14],
        [w - 14, h - 14],
        [w / 2, 14],
        [w / 2, h - 14],
      ]) {
        x.beginPath();
        x.arc(rx, ry, 5, 0, Math.PI * 2);
        x.fill();
      }
    });
    const tile = 1.2;
    const wall = (cx: number, cz: number, ry: number, len: number) => {
      for (let a = -len / 2 + tile / 2; a < len / 2; a += tile)
        for (let y = tile / 2; y < H; y += tile)
          d.at([cx + Math.cos(ry) * a, y, cz - Math.sin(ry) * a], [0, ry, 0], () => d.plane([tile, tile], [0, 0, 0], "#ffffff", { tex: steel, rough: 0.45, metal: 0.7 }));
    };
    wall(0, -D / 2, 0, W);
    wall(-W / 2, 0, Math.PI / 2, D);
    wall(W / 2, 0, -Math.PI / 2, D);
    wall(0, D / 2, Math.PI, W);
    // floor: dark polished stone with gold inlay lines; ceiling: coffered dark steel
    d.plane([W, D], [0, 0, 0], "#141210", { rot: [-Math.PI / 2, 0, 0], rough: 0.25, metal: 0.2 });
    for (let z = -D / 2 + 1.2; z < D / 2 - 0.1; z += 1.2) d.box([W, 0.004, 0.025], [0, 0.002, z], "#a07c35", { metal: 1, rough: 0.3 });
    d.plane([W, D], [0, H, 0], "#0e0f12", { rot: [Math.PI / 2, 0, 0], rough: 0.8 });
    for (let k = -3; k <= 3; k++) d.box([0.08, 0.12, D], [k * 1.15, H - 0.06, 0], "#22252b", { metal: 0.6, rough: 0.5 });
    // warm ceiling lamps
    for (const [x, z] of [
      [-1.73, -D / 2 + 2.4],
      [1.73, -D / 2 + 2.4],
      [-1.73, D / 2 - 2.2],
      [1.73, D / 2 - 2.2],
    ]) {
      d.cyl(0.25, 0.32, 0.12, [x, H - 0.1, z], "#2a2520", { metal: 0.8, rough: 0.4 });
      d.cyl(0.22, 0.22, 0.02, [x, H - 0.17, z], "#ffe2a8", { glow: 2.2 });
    }
    scene.add(d.build("vault-room", { essential: true }));
  }

  function buildDecor(scene: THREE.Scene) {
    const d = new DecorBuilder({ atlasSize: 1024 });
    buildDoor(d);
    // safe-deposit boxes on the back wall, either side of the big number
    const box = d.canvas(128, 64, (x, w, h) => {
      x.fillStyle = "#7a5f2a";
      x.fillRect(0, 0, w, h);
      x.strokeStyle = "#3e2f12";
      x.lineWidth = 4;
      x.strokeRect(2, 2, w - 4, h - 4);
      x.fillStyle = "#e6c77c";
      x.beginPath();
      x.arc(w * 0.82, h / 2, 6, 0, Math.PI * 2);
      x.fill();
      x.font = "600 16px Oswald, sans-serif";
      x.fillStyle = "#2a1f0a";
      x.fillText(String(100 + Math.floor(Math.random() * 800)), 10, h / 2 + 6);
    });
    for (const side of [-1, 1])
      for (let r = 0; r < 7; r++)
        for (let cI = 0; cI < 5; cI++) d.box([0.3, 0.16, 0.05], [side * (W / 2 - 0.5 - cI * 0.32), 0.35 + r * 0.18, -D / 2 + 0.05], "#ffffff", { tex: box, face: "front", metal: 0.6, rough: 0.35 });
    // gold bar stacks in the back corners
    const bars = (cx: number, cz: number) => {
      for (let l = 0; l < 5; l++)
        for (let i = 0; i < 5 - l; i++)
          d.extrude(roundedRect(0.2, 0.06, 0.01), 0.09, [cx + (i - (4 - l) / 2) * 0.21, 0.035 + l * 0.065, cz], "#e7b847", { metal: 1, rough: 0.22, rot: [0, 0, 0] });
    };
    bars(-W / 2 + 0.9, -D / 2 + 0.45);
    bars(W / 2 - 0.9, -D / 2 + 0.45);
    scene.add(d.build("vault-decor"));
  }

  /**
   * The vault door, cracked ajar: a riveted frame plate and a thick ring round the doorway, warm
   * light from outside showing through the gap, and the door hung on a two-knuckle hinge (left,
   * as you face it) with its bolt-work facing the room: locking bolts out of the rim, brass
   * linkages to a central gear, a chrome hand wheel, a time lock with pipes, a maker's plate.
   */
  function buildDoor(d: DecorBuilder) {
    const R = 1.2; // the door's radius (the doorway ring is a little bigger)
    const steel = { metal: 0.7, rough: 0.33 };
    const brass = { metal: 1, rough: 0.28, glow: 0.12 };
    const chrome = { metal: 1, rough: 0.16 };
    // (in this frame +z points into the room and +x is right as you face the door)
    d.at([0, 1.55, D / 2], [0, Math.PI, 0], () => {
      d.box([2.9, 2.9, 0.06], [0, 0, 0.03], "#4c5159", { metal: 0.6, rough: 0.45 }); // (from the floor up)
      for (let k = 0; k < 6; k++)
        for (const [sx, sy] of [
          [1, 0],
          [0, 1],
        ]) {
          const t = -1.25 + k * 0.5;
          for (const e of [-1.36, 1.36]) d.cyl(0.025, 0.025, 0.03, [sx ? e : t, sy ? e : t, 0.07], "#9aa0a8", { rot: [Math.PI / 2, 0, 0], ...chrome, seg: 8 });
        }
      d.torus(R + 0.13, 0.12, [0, 0, 0.12], "#8d929b", { ...steel, seg: 64 });
      d.torus(R + 0.3, 0.014, [0, 0, 0.07], "#ffd28a", { glow: 1.6, seg: 64 });
      // daylight from the corridor outside, seen through the gap
      d.cyl(R + 0.02, R + 0.02, 0.01, [0, 0, 0.065], "#ffe2b0", { rot: [Math.PI / 2, 0, 0], glow: 2.4, seg: 48 });
      // the hinge: two knuckles on the frame, the pin through them
      const hx = -(R + 0.22), hz = 0.2;
      for (const y of [-0.62, 0.62]) {
        d.box([0.26, 0.36, 0.2], [hx - 0.06, y, 0.13], "#5c616a", steel);
        d.cyl(0.1, 0.1, 0.36, [hx, y, hz], "#7a7f88", { ...steel, seg: 20 });
        d.cyl(0.06, 0.06, 0.05, [hx, y + 0.205, hz], "#c9a45c", { ...brass, seg: 14 });
      }
      d.cyl(0.035, 0.035, 1.66, [hx, 0, hz], "#c7ccd3", { ...chrome, seg: 10 });
      // the door, swung 14° into the room about the hinge
      d.at([hx, 0, hz], [0, -0.244, 0], () => {
        for (const y of [-0.62, 0.62]) d.box([0.46, 0.22, 0.09], [0.26, y, 0], "#6c7179", steel); // hinge arms
        d.at([R + 0.22, 0, 0], null, () => {
          d.cyl(R, R, 0.42, [0, 0, 0], "#8a9099", { rot: [Math.PI / 2, 0, 0], ...steel, seg: 64 });
          d.torus(R, 0.035, [0, 0, 0.21], "#b3b9c1", { ...chrome, seg: 64 });
          d.cyl(1.0, 1.0, 0.04, [0, 0, 0.23], "#666b73", { rot: [Math.PI / 2, 0, 0], ...steel, seg: 48 });
          // locking bolts (retracted, as the door's open: just their ends at the rim) and the
          // linkages that throw them
          for (let k = 0; k < 12; k++) {
            const a = (k / 12) * Math.PI * 2 + Math.PI / 12;
            const [c, sn] = [Math.cos(a), Math.sin(a)];
            d.cyl(0.05, 0.05, 0.24, [c * (R - 0.1), sn * (R - 0.1), 0], "#c7ccd3", { rot: [0, 0, a - Math.PI / 2], ...chrome, seg: 10 });
            d.box([0.56, 0.05, 0.03], [c * 0.66, sn * 0.66, 0.27], "#c9a45c", { rot: [0, 0, a], ...brass });
            d.cyl(0.035, 0.035, 0.04, [c * 0.93, sn * 0.93, 0.28], "#9aa0a8", { rot: [Math.PI / 2, 0, 0], ...chrome, seg: 8 });
          }
          d.torus(0.95, 0.025, [0, 0, 0.27], "#c9a45c", { ...brass, seg: 48 });
          // the central gear
          d.cyl(0.34, 0.34, 0.06, [0, 0, 0.28], "#a08c5a", { rot: [Math.PI / 2, 0, 0], ...brass, seg: 32 });
          for (let k = 0; k < 20; k++) {
            const a = (k / 20) * Math.PI * 2;
            d.box([0.06, 0.07, 0.06], [Math.cos(a) * 0.37, Math.sin(a) * 0.37, 0.28], "#a08c5a", { rot: [0, 0, a], ...brass });
          }
          // the hand wheel on its hub
          d.cyl(0.07, 0.07, 0.18, [0, 0, 0.37], "#d5d9de", { rot: [Math.PI / 2, 0, 0], ...chrome, seg: 14 });
          d.torus(0.3, 0.026, [0, 0, 0.46], "#d5d9de", { ...chrome, seg: 40 });
          for (let k = 0; k < 4; k++) {
            const a = (k / 4) * Math.PI + Math.PI / 8;
            d.box([0.6, 0.03, 0.03], [0, 0, 0.46], "#d5d9de", { rot: [0, 0, a], ...chrome });
            for (const sgn of [-1, 1]) d.cyl(0.035, 0.035, 0.07, [Math.cos(a) * 0.3 * sgn, Math.sin(a) * 0.3 * sgn, 0.5], "#c9a45c", { rot: [Math.PI / 2, 0, 0], ...brass, seg: 10 });
          }
          // the time lock (three movements) and its pipes down to the gear housing
          d.box([0.5, 0.22, 0.08], [0, 0.7, 0.28], "#34373c", { metal: 0.5, rough: 0.4 });
          for (const x of [-0.15, 0, 0.15]) d.cyl(0.055, 0.055, 0.02, [x, 0.7, 0.33], "#f3e2b4", { rot: [Math.PI / 2, 0, 0], glow: 0.5, seg: 16 });
          for (const sgn of [-1, 1])
            d.tube(
              [
                [sgn * 0.25, 0.68, 0.3],
                [sgn * 0.45, 0.58, 0.31],
                [sgn * 0.5, 0.3, 0.31],
                [sgn * 0.36, 0.08, 0.3],
              ],
              0.022,
              "#b08f4a",
              { ...brass, seg: 16 },
            );
          // the maker's plate
          const plate = d.canvas(256, 64, (x, w, h) => {
            x.fillStyle = "#2a2010";
            x.fillRect(0, 0, w, h);
            x.strokeStyle = "#c9a45c";
            x.lineWidth = 3;
            x.strokeRect(2, 2, w - 4, h - 4);
            x.textAlign = "center";
            x.textBaseline = "middle";
            x.fillStyle = GOLD;
            x.font = `700 22px "Cinzel", serif`;
            x.fillText("BACKLOG SAFE CO.", w / 2, h * 0.4, w - 16);
            x.fillStyle = "#b9a983";
            x.font = `500 13px "Oswald", sans-serif`;
            x.fillText("TIME LOCK · EST. 1971", w / 2, h * 0.76);
          });
          d.plane([0.42, 0.105], [0, -0.66, 0.305], "#ffffff", { tex: plate, glow: 0.3 }); // (in front of the linkages)
        });
      });
    });
  }

  return level;
}

/** Made-up numbers for laying out the boards on localhost (?vaultdemo). */
function demoData(games: Game[]): { index: VaultIndexEntry[]; snap: VaultSnapshot } {
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const items: VaultItem[] = games
    .filter((g) => g.status !== "wishlist" && !/windows|pc|steam/i.test(g.platform))
    .slice(0, 600)
    .map((g) => {
      const loose = Math.round((5 + rnd() ** 3 * 300) * 100) / 100;
      return { id: g.id, title: g.title, platform: g.platform, status: g.status, physical: "assumed", prices: { loose, cib: loose * 2.1, new: loose * 5 } };
    });
  const tot = (k: "loose" | "cib" | "new") => items.reduce((a, i) => a + (i.prices[k] ?? 0), 0);
  const date = new Date().toISOString().slice(0, 10);
  const snap: VaultSnapshot = { date, generatedAt: new Date().toISOString(), source: "DEMO (made-up numbers)", currency: "USD", assumptions: [], items, unpriced: [], excluded: {} };
  const index: VaultIndexEntry[] = [
    { date: "2026-04-15", generatedAt: "", source: "", totals: { loose: tot("loose") * 0.9, cib: 0, new: 0, asOwned: tot("loose") * 0.9 }, priced: 580, unpriced: 20 },
    { date, generatedAt: "", source: "", totals: { loose: tot("loose"), cib: tot("cib"), new: tot("new"), asOwned: tot("loose") }, priced: 600, unpriced: 0 },
  ];
  return { index, snap };
}

export type { Game };
