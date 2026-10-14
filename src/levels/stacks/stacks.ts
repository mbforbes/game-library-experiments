// THE INFINITE STACKS — a stone tower library (think Oblivion's Arcane University by way of
// Borges' Library of Babel). The whole collection spirals up the inner wall in release order:
// climbing the tower is travelling through time, 1971 at the bottom, today at the top.
//
//  • every year gets its own bay(s), marked with a brass plaque
//  • below the first game: endless dusty tomes of "pre-history"; above today: ghostly
//    unwritten volumes of games not yet released, fading into the clouds
//  • the wishlist circles overhead as a flock of spectral flying books
//  • the Codex floats at the centre and shows Cooper's reviews in calligraphy
//  • you carry a lantern (the only warm light); candles float; moonlight falls from above

import * as THREE from "three/webgpu";
import type { Game } from "../../../shared/types";
import { platformOf } from "../../../shared/platforms";
import { Rail } from "../../engine/rail";
import { MediaField, kindOf, type Placement } from "../../media/field";
import { packShelves, runLength, faceOut, type Shelf } from "../../world/shelving";
import { stoneMaterial, woodMaterial, candles, bobCandles, dust, lightShaft, tomes, Codex } from "../../world/kit/medieval";
import { canvas, canvasTexture, neonFx } from "../../world/kit/common";
import { GRADE_COLORS } from "../../media/spines";
import { boxes } from "../../world/kit/common";
import type { Level, LevelCtx, Station } from "../types";
import { texture, vec3 } from "three/tsl";
import { decorateStacks } from "./decor";

const R = 3.0; // radius of the shelf fronts (roomy: zooming out keeps you clear of the light shafts)
const DEPTH = 0.32;
const ROWS = [0.25, 0.25, 0.25];
const BOARD = 0.025;
const BAND = ROWS.reduce((a, b) => a + b + BOARD, 0) + 0.06;
const PITCH = BAND + 0.42; // rise per full turn
const BAY_W = 0.8;
const UP = new THREE.Vector3(0, 1, 0);

const sortTitle = (t: string) => t.toLowerCase().replace(/^(the|a)\s+/, "");

export default function stacks(): Level {
  let ctx: LevelCtx;
  let rail: Rail;
  const fields: MediaField[] = [];
  const stations: Station[] = [];
  const tickers: ((dt: number, t: number) => void)[] = [];
  let codex: Codex;
  let lantern: THREE.PointLight;
  let flock: { field: MediaField; orbits: { r: number; y: number; speed: number; phase: number; tilt: number }[] } | null = null;
  const yearAt = new Map<number, number>(); // year -> theta of its first bay

  const thetaY = (theta: number) => (theta / (Math.PI * 2)) * PITCH;
  const inward = (theta: number) => new THREE.Vector3(-Math.cos(theta), 0, -Math.sin(theta));
  const onWall = (theta: number, y: number, r = R) => new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r);

  const level: Level = {
    id: "stacks",
    name: "The Infinite Stacks",
    tagline: "Stone tower, chronological spiral",
    stations,
    fields,

    async build(c, progress) {
      ctx = c;
      const { scene, art, store, engine } = c;
      engine.post.bloomStrength.value = 0.5;
      engine.post.bloomRadius.value = 0.45;
      engine.post.vignette.value = 0.6;
      engine.post.exposure.value = 1.0;
      scene.background = new THREE.Color(0x07080d);
      scene.fog = new THREE.FogExp2(0x0a0705, 0.07);
      scene.environment = null;
      // a tall stone tower: long, dark reverb; wind and candle crackle everywhere
      c.audio.setRoom({ seconds: 4.5, decay: 2.2, wet: 0.42 });
      // (no ambient loops in the stacks: wind and crackle read as static. Music + SFX only.)

      await progress("Ordering the ages…");
      const owned = store.games.filter((g) => g.status !== "wishlist");
      const yearOf = (g: Game) => art.year(g) ?? 9999;
      const byYear = new Map<number, Game[]>();
      for (const g of owned) {
        const y = yearOf(g);
        if (!byYear.has(y)) byYear.set(y, []);
        byYear.get(y)!.push(g);
      }
      const years = [...byYear.keys()].sort((a, b) => a - b);
      for (const y of years) byYear.get(y)!.sort((a, b) => platformOf(a.platform).released.localeCompare(platformOf(b.platform).released) || sortTitle(a.title).localeCompare(sortTitle(b.title)));

      // ---- one continuous chronological run along the helix; brass tags mark each new year ----
      await progress("Raising the shelves…");
      const theta0 = 0;
      let theta = theta0;
      const ordered = years.flatMap((y) => byYear.get(y)!);
      const isFace = (g: Game) => {
        const k = kindOf(g, art);
        return k.includes("cart") || k === "hucard" || k === "cabinet" || g.grade === "A+";
      };
      const need = runLength(ordered, art, (g) => (isFace(g) ? "face" : "spine")) + years.length * 0.03;
      const nBays = Math.ceil(need / (ROWS.length * (BAY_W - 0.04) * 0.86));
      const bays: { theta: number; width: number; y: number }[] = [];
      const shelves: Shelf[] = [];
      for (let b = 0; b < nBays; b++) {
        const bayTheta = theta + BAY_W / 2 / R;
        const by = thetaY(bayTheta);
        bays.push({ theta: bayTheta, width: BAY_W, y: by });
        shelves.push(...bayShelves(bayTheta, by, BAY_W));
        theta += (BAY_W + 0.05) / R;
      }
      const pack = packShelves(ordered, shelves, art, {
        mode: (g) => (isFace(g) ? "face" : "spine"),
        section: (g) => String(yearOf(g)),
        newShelfBelow: 0.06,
        sectionGap: 0.03,
      });
      const placements: Placement[] = pack.placements;
      if (pack.overflow.length) console.warn(`[stacks] overflow ${pack.overflow.length}`);
      // year tags on the shelf edge where each year begins; bay plaques show the years inside
      const plaques: { year: number; theta: number; y: number; label: string }[] = [];
      const seenYear = new Set<string>();
      const bayYears = new Map<number, number[]>();
      for (const sec of pack.sections) {
        const bay = Math.floor(sec.shelf / ROWS.length);
        const yr = +sec.key;
        if (!bayYears.has(bay)) bayYears.set(bay, []);
        bayYears.get(bay)!.push(yr);
        if (seenYear.has(sec.key) || yr === 9999) continue;
        seenYear.add(sec.key);
        yearAt.set(yr, bays[bay].theta);
        yearTag(scene, sec.start, shelves[sec.shelf], yr);
      }
      bays.forEach((b, i) => {
        const ys = (bayYears.get(i) ?? []).filter((y) => y !== 9999);
        if (!ys.length) return;
        const lo = Math.min(...ys), hi = Math.max(...ys);
        plaques.push({ year: lo, theta: b.theta, y: b.y, label: lo === hi ? String(lo) : `${lo}–${String(hi).slice(2)}` });
      });
      const thetaEnd = theta;
      const field = new MediaField(c.kit, placements, { name: "stacks" });
      scene.add(field.group);
      fields.push(field);
      console.info(`[stacks] ${owned.length} games in ${bays.length} bays (fill ${(pack.fill * 100).toFixed(0)}%) over ${((thetaEnd - theta0) / (Math.PI * 2)).toFixed(2)} turns`);

      // ---- architecture ----
      await progress("Carving stone…");
      const before = Math.PI * 2 * 1.2; // decorative turns below and above
      const after = Math.PI * 2 * 1.5;
      buildTower(scene, theta0 - before, thetaEnd + after);
      buildShelving(scene, bays, theta0 - before, thetaEnd + after, thetaEnd);
      buildPlaques(scene, plaques);

      // ---- light: lantern + moon + candles + shafts + dust ----
      await progress("Lighting candles…");
      const yTop = thetaY(thetaEnd + after) + 2;
      const yBot = thetaY(theta0 - before) - 1;
      scene.add(new THREE.HemisphereLight(0x3a3448, 0x140a04, 0.32));
      const moon = new THREE.DirectionalLight(0x9fb4ff, 0.35);
      moon.position.set(0.5, 10, 0.3);
      scene.add(moon);
      lantern = new THREE.PointLight(0xffa860, 11, 7.5, 1.3);
      scene.add(lantern);
      const candlePos: THREE.Vector3[] = [];
      for (let k = 0; k < 70; k++) {
        const a = k * 2.399;
        const r = 0.5 + ((k * 37) % 100) / 100 * (R - 1.0);
        candlePos.push(new THREE.Vector3(Math.cos(a) * r, yBot + 1 + ((k * 0.618) % 1) * (yTop - yBot - 2), Math.sin(a) * r));
      }
      const cs = candles(candlePos);
      scene.add(cs.group);
      tickers.push((_, t) => bobCandles(cs, t));
      scene.add(lightShaft(new THREE.Vector3(0.4, yTop + 4, 0.15), new THREE.Vector3(-0.2, yBot, 0.1), 0.6, "#a8c4ff", 0.1));
      scene.add(lightShaft(new THREE.Vector3(-0.5, yTop + 4, -0.3), new THREE.Vector3(0.3, yBot + 2, -0.15), 0.42, "#c8b4ff", 0.07));
      scene.add(dust(engine.quality.mobile ? 250 : 600, R - 0.3, yBot, yTop));

      // ---- the Codex at the centre ----
      await progress("Opening the Codex…");
      codex = new Codex(1.5);
      scene.add(codex.group);
      showChronicle();
      const codexTarget = new THREE.Vector3();
      tickers.push((dt, t) => {
        codex.update(t, dt);
        // floats on the tower's axis at the viewer's height, turning to face them (the camera
        // never crosses the axis, so it's behind you while you browse the shelves)
        const cam = c.camera.position;
        updateCodexView(dt);
        codexTarget.set(0, (codexView ? codexView.y : cam.y) - 0.15 + Math.sin(t * 0.7) * 0.05, 0);
        codex.group.position.lerp(codexTarget, Math.min(1, dt * 2));
        const want = Math.atan2(cam.x - codex.group.position.x, cam.z - codex.group.position.z);
        let d = want - codex.group.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        codex.group.rotation.y += d * Math.min(1, dt * 2);
        codex.group.rotation.x = -0.18;
      });
      c.pickable(codex.group, () => {
        const g = store.selected;
        if (!g) showChronicle(true);
      });

      // ---- the wishlist flock ----
      await progress("Releasing the wishes…");
      const wish = store.games.filter((g) => g.status === "wishlist");
      const yWish = thetaY(thetaEnd) + 1.6;
      const orbits = wish.map((_, k) => ({ r: 0.7 + ((k * 0.381) % 1) * (R - 1.2), y: yWish + ((k * 0.7071) % 1) * 3.2, speed: 0.08 + ((k * 0.13) % 1) * 0.12, phase: k * 2.399, tilt: ((k * 0.29) % 1) * 0.6 - 0.3 }));
      const wf = new MediaField(c.kit, wish.map((g, k) => ({ game: g, position: new THREE.Vector3(0, orbits[k].y, 0), quaternion: new THREE.Quaternion(), scale: 0.8 })), { holo: true, name: "wishes" });
      scene.add(wf.group);
      fields.push(wf);
      flock = { field: wf, orbits };

      // ---- rail: a helix hugging the shelf fronts ----
      const pts: THREE.Vector3[] = [], nrm: THREE.Vector3[] = [];
      const tStart = theta0 - Math.PI * 0.8, tEnd = thetaEnd + Math.PI * 2.2;
      for (let a = tStart; a <= tEnd; a += 0.06) {
        pts.push(onWall(a, thetaY(a)));
        nrm.push(inward(a));
      }
      rail = new Rail(pts, nrm, { h: [-0.4, BAND + 1.6], d: [0.4, R - 0.8], h0: BAND * 0.55, d0: 1.5, lift: 0.1 });
      const sOf = (th: number) => (th - tStart) * R; // arc length ≈ theta * R (helix rise is small)
      const lastYear = years.filter((y) => y < 9999).pop() ?? 2026;
      c.rig.setRail(rail, { s: sOf(yearAt.get(lastYear) ?? thetaEnd), h: BAND * 0.5, d: 1.6 });
      const era = (label: string, y: number) => {
        const yy = years.find((x) => x >= y) ?? years[years.length - 1];
        const th = yearAt.get(yy);
        if (th !== undefined) stations.push({ id: `y${y}`, label, go: () => c.rig.goTo({ s: sOf(th) + 0.4, h: BAND * 0.5, d: 1.5 }, 1.8) });
      };
      era("Dawn (1971)", 1970);
      era("'80s", 1980);
      era("'90s", 1990);
      era("2000s", 2000);
      era("2010s", 2010);
      era("2020s", 2020);
      stations.push(
        { id: "now", label: "Today", go: () => c.rig.goTo({ s: sOf(yearAt.get(lastYear) ?? thetaEnd) + 0.5, h: BAND * 0.5, d: 1.4 }, 1.8) },
        {
          id: "codex",
          label: "The Codex",
          // turn around from wherever you are on the stair and face the book on the axis
          go: () => enterCodex(),
        },
        {
          id: "wishes",
          label: "The Wishes",
          go: () => c.rig.goFree(new THREE.Vector3(1.2, yWish - 0.6, 0.9), new THREE.Vector3(-0.2, yWish + 1.6, -0.1)),
        },
        { id: "future", label: "The Unwritten", go: () => c.rig.goTo({ s: sOf(thetaEnd + Math.PI * 1.2), h: BAND * 0.5, d: 1.6 }, 2.4) },
      );
      // any other station leaves the Codex close-up
      for (const st of stations) {
        if (st.id === "codex") continue;
        const go = st.go;
        st.go = () => {
          leaveCodex();
          go();
        };
      }

      // ---- furnishings: candles, curios, arches, the gallery, the vault (see decor.ts) ----
      await decorateStacks(c, { R, DEPTH, BAND, PITCH, bays, a0: theta0 - before, a1: thetaEnd + after, libEnd: thetaEnd }, progress);
    },

    update(dt, t) {
      for (const fn of tickers) fn(dt, t);
      // lantern rides just in front of / above the camera
      if (lantern) {
        const cam = ctx.camera;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        // carried a little ahead of you, but never past the shelf fronts when you lean in close
        // (it used to end up behind the spines and light them from the back: all dark)
        const ahead = codexView ? 0.5 : Math.min(0.5, ctx.rig.state.d * 0.4);
        lantern.position.copy(cam.position).addScaledVector(fwd, ahead).add(new THREE.Vector3(0, 0.35, 0));
        lantern.intensity = 9 + Math.sin(t * 9) * 0.25 + Math.sin(t * 23) * 0.15;
      }
      // the wishlist flock circles
      if (flock) {
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(0.8, 0.8, 0.8);
        flock.field.games.forEach((g, k) => {
          const o = flock!.orbits[flock!.field.order.indexOf(g)] ?? flock!.orbits[k];
          const a = o.phase + t * o.speed;
          p.set(Math.cos(a) * o.r, o.y + Math.sin(t * 0.6 + o.phase) * 0.15, Math.sin(a) * o.r);
          q.setFromEuler(new THREE.Euler(o.tilt + Math.sin(t + o.phase) * 0.2, -a, Math.sin(t * 1.3 + o.phase) * 0.25));
          m.compose(p, q, s);
          flock!.field.setMatrix(g.id, m);
        });
      }
    },

    focusGame(g) {
      leaveCodex();
      for (const f of fields) {
        const p = f.centerOf(g.id);
        if (!p) continue;
        if (f === flock?.field) {
          ctx.rig.goTo({ s: rail.project(p), h: p.y - thetaY(Math.atan2(p.z, p.x)), d: 2.2 }, 1.5);
          return;
        }
        const s = rail.project(p);
        const base = rail.at(s).p.y;
        ctx.rig.goTo({ s, h: p.y - base, d: 0.7 }, 1.6);
        return;
      }
    },

    onSelect(g) {
      ctx.audio.play("page", { at: codex.group.position, delay: 0.2 });
      if (!g) {
        showChronicle();
        return;
      }
      drawPage(g);
    },

    onGesture(gs) {
      if (!codexView) return false;
      const v = codexView;
      if (gs.type === "pan") {
        // sideways: turn pages (game by game, in shelf order); up/down: look along the page
        v.acc += gs.dx;
        if (Math.abs(v.acc) > 70) {
          turnPage(v.acc < 0 ? 1 : -1);
          v.acc = 0;
        }
        v.dy = Math.max(-0.35, Math.min(0.35, v.dy + gs.dy * 0.0025));
      } else if (gs.type === "panEnd") v.acc = 0;
      else if (gs.type === "zoom") v.zoom = Math.max(0.4, Math.min(1, v.zoom * gs.factor));
      else if (gs.type === "scroll") {
        v.acc += Math.abs(gs.dx) > Math.abs(gs.dy) ? -gs.dx : -gs.dy;
        if (Math.abs(v.acc) > 120) {
          turnPage(v.acc < 0 ? 1 : -1);
          v.acc = 0;
        }
      }
      return true;
    },

    dispose() {
      for (const f of fields) f.dispose();
      neonFx.rainbow.value = 0;
    },
  };

  // ---- the Codex close-up -----------------------------------------------------------------
  // Framed to fit the whole open book on any screen (backing up as far as the tower allows and
  // shrinking the book if a narrow phone needs more); drags/pinches/wheel read the book
  // instead of leaving it; any other station leaves.
  let codexView: { angle: number; y: number; zoom: number; dy: number; acc: number; page: number } | null = null;
  const BOOK_W = 1.5, BOOK_H = (1.5 / 2) * (1400 / 1024);

  function codexFit() {
    const cam = ctx.camera;
    const tv = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const need = Math.max((BOOK_H / 2 + 0.08) / (tv * 0.8), (BOOK_W / 2 + 0.06) / (tv * cam.aspect * 0.96));
    const maxD = R - 0.4;
    return { dist: Math.min(need, maxD), scale: Math.min(1, maxD / need) };
  }

  function enterCodex() {
    const cam = ctx.camera.position;
    codexView = { angle: Math.atan2(cam.z, cam.x), y: cam.y, zoom: 1, dy: 0, acc: 0, page: -1 };
  }

  function leaveCodex() {
    codexView = null;
  }

  function updateCodexView(dt: number) {
    const fit = codexFit();
    const want = codexView ? fit.scale : 1;
    const sc = codex.group.scale.x + (want - codex.group.scale.x) * Math.min(1, dt * 4);
    codex.group.scale.setScalar(sc);
    if (!codexView) return;
    const v = codexView;
    const d = Math.max(0.55, fit.dist * v.zoom);
    const yc = v.y - 0.15 + v.dy * sc;
    ctx.rig.goFree(new THREE.Vector3(Math.cos(v.angle) * d, yc + 0.12, Math.sin(v.angle) * d), new THREE.Vector3(0, yc, 0));
  }

  function turnPage(dir: number) {
    const v = codexView!;
    const order = fields[0]?.order ?? [];
    if (!order.length) return;
    v.page = v.page < 0 ? (dir > 0 ? 0 : order.length - 1) : (v.page + dir + order.length) % order.length;
    ctx.audio.play("page", { at: codex.group.position });
    drawPage(order[v.page]);
  }

  function drawPage(g: Game) {
      const p = platformOf(g.platform);
      const year = ctx.art.year(g);
      const facts = [
        `${p.name}${year ? ", " + year : ""}`,
        g.developer ? `by ${g.developer}` : "",
        g.genre,
        g.status === "completed" ? `Vanquished ${g.completedOn ?? ""}` : g.status === "playing" ? "A quest in progress" : g.status === "wishlist" ? `Sought for $${g.looseValue ?? "?"}` : "Awaits its hero",
        g.hours ? `About ${g.hours} hours of toil` : "",
      ].filter(Boolean);
      codex.draw({
        title: g.title,
        subtitle: g.status === "completed" ? "as recorded by Cooper" : undefined,
        facts,
        body: g.review ?? (g.status === "wishlist" ? "A wish, not yet granted. The scribes keep watch for a fair price." : "These pages remain blank. The tale is yet to be written."),
        badge: g.grade ? { text: g.grade, color: GRADE_COLORS[g.grade] } : undefined,
      });
  }

  function showChronicle(full = false) {
    const s = ctx.store.stats;
    const roman = (n: number) => {
      const map: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
      let out = "";
      for (const [v, r] of map) while (n >= v) {
        out += r;
        n -= v;
      }
      return out;
    };
    codex.draw({
      title: "The Chronicle of Cooper",
      subtitle: `Being a record of ${s.total} games`,
      facts: [
        `${s.completed} conquered (${Math.round(s.pct * 100)} parts in a hundred)`,
        `${s.playing} quests underway`,
        `${s.backlogHours.toLocaleString()} hours yet to be spent`,
        s.clearYear ? `Prophecy: the backlog falls in ${roman(s.clearYear)}` : "",
        `${s.grades["A+"]} deeds of legend (A+)`,
      ].filter(Boolean),
      body:
        `Herein lie the games of Cooper, shelved by the year of their making, from the first age of ${s.oldest?.title ?? "the arcade"} to the present day of ${s.newest?.title ?? "now"}. ` +
        `Climb the stair and you climb through time. Of the makers, ${s.topDeveloper?.name ?? "Konami"} is most prolific, with ${s.topDeveloper?.count ?? 0} works upon these shelves. ` +
        `Above, ${s.wishlist} wishes circle like restless birds, waiting to be caught. ` +
        (full ? `Most recently vanquished: ${s.recentlyCompleted.slice(0, 4).map((g) => g.title).join("; ")}. ` : "") +
        `Touch any tome to read its page.`,
    });
  }

  /** A small brass tag on the shelf's front edge where a new year begins. */
  function yearTag(scene: THREE.Scene, at: THREE.Vector3, shelf: Shelf, year: number) {
    const [cv, cx] = canvas(160, 56);
    const g = cx.createLinearGradient(0, 0, 0, 56);
    g.addColorStop(0, "#e4c069");
    g.addColorStop(1, "#8a6220");
    cx.fillStyle = g;
    cx.fillRect(0, 0, 160, 56);
    cx.fillStyle = "#2a1a06";
    cx.font = `40px "Cinzel", serif`;
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText(String(year), 80, 31);
    const tex = canvasTexture(cv);
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.85 });
    m.colorNode = texture(tex).rgb;
    m.emissiveNode = texture(tex).rgb.mul(0.15);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.021), m);
    mesh.position.copy(at).addScaledVector(shelf.dir, 0.032).add(new THREE.Vector3(0, -0.013, 0)).addScaledVector(shelf.normal, 0.004);
    mesh.quaternion.copy(faceOut(shelf.normal));
    scene.add(mesh);
  }

  /** Shelves of one bay (flat chord of the curved wall), top row first. */
  function bayShelves(theta: number, y: number, width: number): Shelf[] {
    const n = inward(theta);
    const center = onWall(theta, y);
    const dir = UP.clone().cross(n); // viewer's right
    const out: Shelf[] = [];
    let yy = y + 0.04;
    const rows: { y: number; h: number }[] = [];
    for (const h of ROWS) {
      rows.push({ y: yy, h });
      yy += h + BOARD;
    }
    for (const r of rows.reverse()) {
      out.push({ origin: center.clone().addScaledVector(dir, -width / 2 + 0.02).add(new THREE.Vector3(0, r.y - y, 0)), dir: dir.clone(), normal: n.clone(), width: width - 0.04, depth: DEPTH, height: r.h });
    }
    return out;
  }

  function buildTower(scene: THREE.Scene, a0: number, a1: number) {
    const y0 = thetaY(a0) - 1.5, y1 = thetaY(a1) + 6;
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(R + DEPTH + 0.02, R + DEPTH + 0.02, y1 - y0, 64, 1, true), stoneMaterial({ cylindrical: true, scale: 1 }));
    (wall.material as THREE.Material).side = THREE.BackSide;
    wall.position.y = (y0 + y1) / 2;
    scene.add(wall);
    // a stone floor far below, lost in the fog, and a cloudy oculus far above
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R + 0.4, 48), stoneMaterial({ scale: 1.4 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = y0;
    scene.add(floor);
    const sky = new THREE.Mesh(new THREE.CircleGeometry(R + 0.4, 48), skyMaterial());
    sky.rotation.x = Math.PI / 2;
    sky.position.y = y1;
    scene.add(sky);
  }

  function buildShelving(scene: THREE.Scene, bays: { theta: number; width: number; y: number }[], a0: number, a1: number, aLibEnd: number) {
    const wood = woodMaterial();
    const parts: [number, number, number, number, number, number][] = [];
    const geos: THREE.BufferGeometry[] = [];
    const addBay = (theta: number, y: number, w: number) => {
      // local: x across, y up, z out of the wall (towards the centre)
      parts.length = 0;
      let yy = y + 0.04;
      parts.push([0, y + 0.02, -DEPTH / 2, w, 0.04, DEPTH]);
      for (const h of ROWS) {
        yy += h;
        parts.push([0, yy + BOARD / 2, -DEPTH / 2, w, BOARD, DEPTH]);
        yy += BOARD;
      }
      parts.push([-w / 2, y + BAND / 2, -DEPTH / 2, 0.04, BAND + 0.06, DEPTH + 0.02]);
      parts.push([w / 2, y + BAND / 2, -DEPTH / 2, 0.04, BAND + 0.06, DEPTH + 0.02]);
      parts.push([0, y + BAND / 2, -DEPTH + 0.01, w, BAND, 0.02]);
      const g = boxes(parts.map((p) => [...p] as [number, number, number, number, number, number]));
      const n = inward(theta);
      const m = new THREE.Matrix4().makeBasis(UP.clone().cross(n), UP, n).setPosition(onWall(theta, 0));
      g.applyMatrix4(m);
      geos.push(g);
    };
    for (const b of bays) addBay(b.theta, b.y, b.width);
    // decorative bays before + after the library
    const deco: { theta: number; y: number; w: number; ghost: boolean }[] = [];
    let a = bays[0].theta - (bays[0].width / 2 + 0.05) / R;
    while (a > a0) {
      const w = 0.9;
      a -= (w + 0.05) / R / 2;
      deco.push({ theta: a, y: thetaY(a), w, ghost: false });
      a -= (w + 0.05) / R / 2;
    }
    a = aLibEnd;
    while (a < a1) {
      const w = 0.9;
      a += (w + 0.05) / R / 2;
      deco.push({ theta: a, y: thetaY(a), w, ghost: true });
      a += (w + 0.05) / R / 2;
    }
    for (const d of deco) addBay(d.theta, d.y, d.w);
    // merge
    const merged = new THREE.Mesh(mergeAll(geos), wood);
    scene.add(merged);
    // filler tomes
    const dusty: Parameters<typeof tomes>[0] = [], ghosts: Parameters<typeof tomes>[0] = [];
    const leather = ["#4a1c14", "#2a3a1c", "#1c2a4a", "#4a3a14", "#3a1c3a", "#5a2a14"].map((h) => new THREE.Color(h));
    let k = 0;
    for (const d of deco) {
      const n = inward(d.theta);
      const right = UP.clone().cross(n);
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, UP, n));
      let yy = d.y + 0.04;
      for (const h of ROWS) {
        let x = -d.w / 2 + 0.03;
        while (x < d.w / 2 - 0.05) {
          k++;
          const tw = 0.025 + ((k * 0.618) % 1) * 0.035;
          const th = h * (0.7 + ((k * 0.414) % 1) * 0.25);
          if ((k * 0.7548) % 1 > 0.08) {
            const pos = onWall(d.theta, yy).addScaledVector(right, x + tw / 2).addScaledVector(n, 0.03 + 0.11);
            const item = { pos, quat: q, size: new THREE.Vector3(tw, th, 0.2 + ((k * 0.3) % 1) * 0.05), color: leather[k % leather.length] };
            (d.ghost ? ghosts : dusty).push(item);
          }
          x += tw + 0.002;
        }
        yy += h + BOARD;
      }
    }
    scene.add(tomes(dusty));
    scene.add(tomes(ghosts, true));
  }

  function buildPlaques(scene: THREE.Scene, plaques: { year: number; theta: number; y: number; label: string }[]) {
    for (const p of plaques) {
      if (p.year === 9999) continue;
      const [cv, cx] = canvas(256, 96);
      const g = cx.createLinearGradient(0, 0, 0, 96);
      g.addColorStop(0, "#d9b25a");
      g.addColorStop(0.5, "#a77a2a");
      g.addColorStop(1, "#6e4c16");
      cx.fillStyle = g;
      cx.fillRect(0, 0, 256, 96);
      cx.strokeStyle = "#3a2608";
      cx.lineWidth = 6;
      cx.strokeRect(6, 6, 244, 84);
      cx.fillStyle = "#2a1a06";
      cx.font = `${p.label.length > 4 ? 52 : 64}px "Cinzel", serif`;
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.fillText(p.label, 128, 52, 236);
      const tex = canvasTexture(cv);
      const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.8 });
      m.colorNode = texture(tex).rgb;
      m.emissiveNode = texture(tex).rgb.mul(0.12);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.075), m);
      const n = inward(p.theta);
      mesh.position.copy(onWall(p.theta, p.y + BAND + 0.07)).addScaledVector(n, 0.02);
      mesh.quaternion.copy(faceOut(n));
      scene.add(mesh);
    }
  }

  return level;
}

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let count = 0;
  for (const g of geos) count += g.getAttribute("position").count;
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  let o = 0;
  for (const g of geos) {
    const p = g.getAttribute("position"), n = g.getAttribute("normal"), u = g.getAttribute("uv");
    pos.set(p.array as Float32Array, o * 3);
    nrm.set(n.array as Float32Array, o * 3);
    uv.set(u.array as Float32Array, o * 2);
    o += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

function skyMaterial() {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = vec3(0);
  m.emissiveNode = vec3(0.35, 0.45, 0.7);
  m.fog = false;
  return m;
}

export { kindOf };
