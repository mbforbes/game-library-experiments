// THE VAULT (hidden): what Cooper's collection is worth.
//
// Reached through the little safe in the den or /vault, behind a password the Worker checks.
// The numbers come only from /api/vault/data (needs the vault cookie): dated PriceCharting
// snapshots kept in Workers KV by scripts/vault/price.ts. Each game is valued in its recorded
// condition (the sheet's optional "Condition" column), loose when none is recorded.
//
//   back wall  : the big number, with the date it was valued (front and centre)
//   left wall  : value over time (one point per valuation snapshot)
//   right wall : the most valuable games + value by platform
//   centre     : the six most valuable games on lit pedestals, with price plaques
//   front wall : the vault door (open), deposit boxes, gold bars

import * as THREE from "three/webgpu";
import { texture } from "three/tsl";
import type { Condition, Game } from "../../../shared/types";
import { platformOf } from "../../../shared/platforms";
import { wallRail, type Rail } from "../../engine/rail";
import { MediaField, templateOf, type Placement } from "../../media/field";
import { neonEnvironment } from "../../world/kit/env";
import { canvas, canvasTexture } from "../../world/kit/common";
import { DecorBuilder, roundedRect } from "../../world/kit/decorkit";
import type { Level, LevelCtx, Station } from "../types";

const W = 8, D = 6.4, H = 3.6;
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

export default function vault(): Level {
  let ctx: LevelCtx;
  const fields: MediaField[] = [];
  const stations: Station[] = [];
  const tickers: ((dt: number, t: number) => void)[] = [];
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
      scene.background = new THREE.Color(0x06070a);
      scene.fog = new THREE.FogExp2(0x07080b, 0.02);
      scene.environment = neonEnvironment(engine.renderer, [
        { color: "#ffd27a", pos: [0, 4, 0], size: [5, 0.1, 4], intensity: 2.4 },
        { color: "#ffb347", pos: [-4.5, 1.6, 0], size: [0.1, 1.6, 2], intensity: 1.2 },
        { color: "#9ab6ff", pos: [4.5, 1.6, 0], size: [0.1, 1.6, 2], intensity: 0.8 },
      ]);
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
      const valued = (snap?.items ?? []).map((it) => {
        const g = store.byId.get(it.id);
        const cond: Condition = g?.condition ?? "loose";
        return { it, g, cond, condRecorded: !!g?.condition, price: priceOf(it, cond) };
      });
      const total = valued.reduce((a, v) => a + v.price, 0);
      const recorded = valued.filter((v) => v.condRecorded).length;
      const assumed = valued.filter((v) => v.it.physical === "assumed").length;
      const sum = (k: Condition) => (snap?.items ?? []).reduce((a, it) => a + priceOf(it, k), 0);
      const top = [...valued].sort((a, b) => b.price - a.price);

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
      history.position.set(-W / 2 + 0.04, 1.7, -0.4);
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
      ranking.position.set(W / 2 - 0.04, 1.75, -1.2);
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
      platforms.position.set(W / 2 - 0.04, 1.6, 1.55);
      platforms.rotation.y = -Math.PI / 2;
      scene.add(platforms);

      // ---- centre: the six most valuable games on pedestals ----
      await progress("Opening the display cases…");
      const showcase = top.filter((v) => v.g).slice(0, 6);
      const placements: Placement[] = [];
      const plaques: THREE.Object3D[] = [];
      showcase.forEach((v, i) => {
        const [px, pz] = pedestalAt(i);
        const [w, hgt] = templateOf(v.g!, ctx.art).size;
        const sc = Math.min(1.9, 0.3 / Math.max(w, hgt));
        // standing on the pedestal, facing back into the room
        placements.push({ game: v.g!, position: new THREE.Vector3(px, 0.93, pz), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)), scale: sc });
        const pl = plaque(`${v.it.title}`, `${money(v.price)} · ${COND_LABEL[v.cond]}`);
        pl.position.set(px, 0.86, pz - 0.29);
        pl.rotation.set(0.55, Math.PI, 0);
        plaques.push(pl);
      });
      if (placements.length) {
        const f = new MediaField(ctx.kit, placements, { name: "vault" });
        scene.add(f.group);
        fields.push(f);
      }
      for (const p of plaques) scene.add(p);
      buildDecor(scene, showcase.length);

      // ---- rail: a loop round the walls ----
      rail = wallRail(
        [
          [W / 2 - 0.4, D / 2 - 0.4],
          [W / 2 - 0.4, -D / 2 + 0.4],
          [-W / 2 + 0.4, -D / 2 + 0.4],
          [-W / 2 + 0.4, D / 2 - 0.4],
        ],
        { closed: true, h: [0.6, 3.0], d: [0.5, 4.6], h0: 1.7, d0: 3.2, lift: 0.1, round: 0.8 },
      );
      const sBack = rail.project(new THREE.Vector3(0, 0, -D / 2));
      c.rig.setRail(rail, { s: sBack, h: 1.75, d: 2.7 });
      stations.push(
        { id: "value", label: "The Value", go: () => c.rig.goTo({ s: sBack, h: 1.75, d: 2.7 }) },
        { id: "history", label: "Over Time", go: () => c.rig.goTo({ s: rail.project(history.position), h: 1.7, d: 2.6 }) },
        { id: "top", label: "Most Valuable", go: () => c.rig.goTo({ s: rail.project(ranking.position), h: 1.75, d: 2.6 }) },
        { id: "platforms", label: "By Platform", go: () => c.rig.goTo({ s: rail.project(platforms.position), h: 1.6, d: 2.3 }) },
        { id: "showcase", label: "Showcase", go: () => c.rig.goFree(new THREE.Vector3(0, 1.85, -1.75), new THREE.Vector3(0.3, 0.95, 1.4)) },
        { id: "door", label: "The Door", go: () => c.rig.goTo({ s: rail.project(new THREE.Vector3(0, 0, D / 2)), h: 1.5, d: 3.6 }) },
      );
    },

    update(dt, t) {
      for (const fn of tickers) fn(dt, t);
    },

    focusGame(g) {
      for (const f of fields) {
        const p = f.centerOf(g.id);
        if (!p) continue;
        ctx.rig.goFree(p.clone().add(new THREE.Vector3(0, 0.25, 0.75)), p);
        return;
      }
    },

    dispose() {
      for (const f of fields) f.dispose();
    },
  };

  /** Showcase pedestals: two rows in the front half of the room, in front of the vault door. */
  function pedestalAt(i: number): [number, number] {
    const col = i % 3, row = Math.floor(i / 3);
    return [(col - 1) * 1.2 + (row ? 0.6 : 0), 0.85 + row * 1.0];
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

  function plaque(title: string, line: string) {
    const [cv, x] = canvas(640, 160);
    x.fillStyle = "#1a1408";
    x.fillRect(0, 0, 640, 160);
    x.strokeStyle = "#b8903f";
    x.lineWidth = 6;
    x.strokeRect(6, 6, 628, 148);
    x.textAlign = "center";
    x.fillStyle = "#f3e2b4";
    x.font = `600 44px "Cinzel", serif`;
    x.fillText(title, 320, 70, 600);
    x.fillStyle = GOLD;
    x.font = `600 40px "Oswald", sans-serif`;
    x.fillText(line, 320, 125, 600);
    const tex = canvasTexture(cv);
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.4 });
    m.colorNode = texture(tex).rgb;
    m.emissiveNode = texture(tex).rgb.mul(0.35);
    return new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.105), m);
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
    for (let k = -2; k <= 2; k++) d.box([W, 0.004, 0.025], [0, 0.002, k * 1.2], "#a07c35", { metal: 1, rough: 0.3 });
    d.plane([W, D], [0, H, 0], "#0e0f12", { rot: [Math.PI / 2, 0, 0], rough: 0.8 });
    for (let k = -3; k <= 3; k++) d.box([0.08, 0.12, D], [k * 1.15, H - 0.06, 0], "#22252b", { metal: 0.6, rough: 0.5 });
    // warm ceiling lamps
    for (const [x, z] of [
      [-2, -1.2],
      [2, -1.2],
      [0, 1.4],
    ]) {
      d.cyl(0.25, 0.32, 0.12, [x, H - 0.1, z], "#2a2520", { metal: 0.8, rough: 0.4 });
      d.cyl(0.22, 0.22, 0.02, [x, H - 0.17, z], "#ffe2a8", { glow: 2.2 });
    }
    scene.add(d.build("vault-room", { essential: true }));
  }

  function buildDecor(scene: THREE.Scene, pedestals: number) {
    const d = new DecorBuilder({ atlasSize: 1024 });
    // pedestals with glass-case frames
    for (let i = 0; i < pedestals; i++) {
      const [px, pz] = pedestalAt(i);
      d.box([0.5, 0.88, 0.5], [px, 0.44, pz], "#1d1a15", { rough: 0.35, metal: 0.2 });
      d.box([0.56, 0.05, 0.56], [px, 0.9, pz], "#8a6a2c", { metal: 1, rough: 0.3 });
      d.box([0.56, 0.05, 0.56], [px, 0.025, pz], "#8a6a2c", { metal: 1, rough: 0.3 });
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ])
        d.box([0.015, 0.62, 0.015], [px + sx * 0.25, 1.23, pz + sz * 0.25], "#c9a45c", { metal: 1, rough: 0.25 });
      d.box([0.52, 0.015, 0.52], [px, 1.545, pz], "#c9a45c", { metal: 1, rough: 0.25 });
      d.cyl(0.04, 0.05, 0.02, [px, 1.53, pz], "#fff1c9", { glow: 2 });
    }
    // the vault door (open, swung against the front wall) + its round frame
    const doorR = 1.25;
    d.at([0, 1.45, D / 2 - 0.05], [0, Math.PI, 0], () => {
      d.torus(doorR + 0.08, 0.1, [0, 0, 0], "#5c616a", { metal: 0.9, rough: 0.35, seg: 48 });
      d.plane([doorR * 2, doorR * 2], [0, 0, 0.02], "#050505", { rough: 1 });
    });
    d.at([-doorR - 0.55, 1.45, D / 2 - 0.6], [0, -1.25, 0], () => {
      d.cyl(doorR, doorR, 0.45, [0, 0, 0], "#6f747d", { rot: [Math.PI / 2, 0, 0], metal: 0.95, rough: 0.3, seg: 48 });
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        d.box([0.05, doorR * 0.8, 0.05], [Math.cos(a) * doorR * 0.45, Math.sin(a) * doorR * 0.45, -0.26], "#c9a45c", { rot: [0, 0, a + Math.PI / 2], metal: 1, rough: 0.25 });
      }
      d.cyl(0.18, 0.18, 0.12, [0, 0, -0.28], "#c9a45c", { rot: [Math.PI / 2, 0, 0], metal: 1, rough: 0.2 });
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        d.cyl(0.07, 0.07, 0.5, [Math.cos(a) * (doorR - 0.12), Math.sin(a) * (doorR - 0.12), 0.05], "#9aa0a8", { rot: [Math.PI / 2, 0, 0], metal: 1, rough: 0.3, seg: 10 });
      }
    });
    // safe-deposit boxes along the front-right wall
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
    for (let r = 0; r < 7; r++)
      for (let cI = 0; cI < 5; cI++) d.box([0.3, 0.16, 0.05], [W / 2 - 0.5 - cI * 0.32, 0.35 + r * 0.18, D / 2 - 0.05], "#ffffff", { tex: box, face: "back", metal: 0.6, rough: 0.35 });
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
