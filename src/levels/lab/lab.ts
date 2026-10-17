// THE BACKLOG SCIENCE ENRICHMENT CENTER — bright, clinical test chambers (a love letter to
// Portal, with our own names and words).
//
//  • Chamber 01 "TEST QUEUE": every unbeaten game in a lit wall cell, ordered by Cooper's priority;
//    amber light = test in progress.
//  • Chamber 02 "RESULTS": every beaten game, sorted by grade, so the cell lights form a gold →
//    green → blue → grey → red bar chart of his grades across the whole wall.
//  • Linked portals: each chamber has a portal showing a live view into the other; tap one to step through.
//  • Pneumatic tubes carry the wishlist upward forever.
//  • The Archivist, a deadpan AI core, comments on stats and on whatever you pick up.

import * as THREE from "three/webgpu";
import type { Game } from "../../../shared/types";
import { platformOf } from "../../../shared/platforms";
import { wallRail, type Rail } from "../../engine/rail";
import { MediaField, templateOf, type Placement } from "../../media/field";
import { faceOut } from "../../world/shelving";
import { panelMaterial, Portal, chamberSign, Archivist, tube, companionCube, cellFrames, labFx, legendStrip, dataBoard } from "../../world/kit/lab";
import { loadForecasts, letterOf, type Forecasts } from "../../library/forecasts";
import { live } from "../../engine/quality";
import { boxes, neonMaterial, neonSign } from "../../world/kit/common";
import { neonEnvironment } from "../../world/kit/env";
import { DotMatrix } from "../../world/kit/displays";
import { GRADE_COLORS } from "../../media/spines";
import type { Level, LevelCtx, Station } from "../types";
import { LOOPS } from "../../audio/sfx";
import { decorateLab } from "./decor";

const W = 9, D = 7, H = 5.2; // chamber size
const B_OFFSET = new THREE.Vector3(40, 0, 0); // chamber 02 lives far away; portals make them adjacent
const CELL = 0.24;
const GRADE_ORDER = ["A+", "A", "B", "C", "D", "F"];

export default function lab(): Level {
  let ctx: LevelCtx;
  const fields: MediaField[] = [];
  const stations: Station[] = [];
  const tickers: ((dt: number, t: number) => void)[] = [];
  let railA: Rail, railB: Rail;
  let inB = false;
  let forecasts: Forecasts | null = null;
  let portalA: Portal, portalB: Portal;
  let archivist: Archivist;
  let caption: DotMatrix;
  let quipT = 6;
  let quipIdx = 0;
  let quips: string[] = [];
  let tubeField: { field: MediaField; items: { game: Game; tube: number; phase: number }[] } | null = null;
  const tubeX = [-3.1, -2.6, -2.1];

  const level: Level = {
    id: "lab",
    name: "Backlog Science",
    tagline: "Test chambers",
    stations,
    fields,

    async build(c, progress) {
      ctx = c;
      const { scene, art, store, engine } = c;
      engine.post.bloomStrength.value = 0.35;
      engine.post.bloomRadius.value = 0.3;
      engine.post.vignette.value = 0.3;
      engine.post.exposure.value = 0.95;
      scene.background = new THREE.Color(0x9aa0a8);
      scene.fog = null;
      scene.environment = neonEnvironment(
        engine.renderer,
        [
          { color: "#ffffff", pos: [0, 4.5, 0], size: [6, 0.1, 6], intensity: 2.2 },
          { color: "#4fb2ff", pos: [-4.8, 1.5, 0], size: [0.1, 2, 1.2], intensity: 2 },
          { color: "#ff9a2a", pos: [4.8, 1.5, 0], size: [0.1, 2, 1.2], intensity: 2 },
        ],
        0x8a9098,
      );
      scene.environmentIntensity = 0.8;
      // tiled rooms: bright medium reverb, fluorescent hum everywhere
      c.audio.setRoom({ seconds: 1.8, decay: 2.6, wet: 0.3 });
      c.audio.addEmitter({ position: new THREE.Vector3(), radius: 1e6, ambient: true, volume: 0.55, build: LOOPS.fluorescent });

      await progress("Pressurizing test chambers…");
      labFx.since.value = 0;
      const owned = store.games.filter((g) => g.status !== "wishlist");
      const queue = owned
        .filter((g) => g.status !== "completed")
        .sort((a, b) => (a.status === "playing" ? -1 : 0) - (b.status === "playing" ? -1 : 0) || (a.priority ?? 9) - (b.priority ?? 9) || a.title.localeCompare(b.title));
      const results = owned
        .filter((g) => g.status === "completed")
        .sort((a, b) => GRADE_ORDER.indexOf(a.grade ?? "F") - GRADE_ORDER.indexOf(b.grade ?? "F") || (b.completedOn ?? "").localeCompare(a.completedOn ?? ""));

      const chamberA = buildChamber(scene, new THREE.Vector3(0, 0, 0), "01");
      const chamberB = buildChamber(scene, B_OFFSET, "02");
      void chamberA;
      void chamberB;
      scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6));
      for (const off of [new THREE.Vector3(), B_OFFSET]) {
        const key = new THREE.DirectionalLight(0xffffff, 1.4);
        key.position.copy(off).add(new THREE.Vector3(1, 6, 4));
        key.target.position.copy(off);
        scene.add(key, key.target);
      }

      await progress("Filing test subjects…");
      const gridA = buildGrid(queue, new THREE.Vector3(0, 0, -D / 2), (g) => (g.status === "playing" ? "#ffb000" : "#e8f4ff"));
      const gridB = buildGrid(results, B_OFFSET.clone().add(new THREE.Vector3(0, 0, -D / 2)), (g) => GRADE_COLORS[g.grade ?? "C"] ?? "#cccccc");
      const fieldA = new MediaField(c.kit, gridA.placements, { name: "queue" });
      const fieldB = new MediaField(c.kit, gridB.placements, { name: "results" });
      scene.add(fieldA.group, fieldB.group, gridA.frames.frame, gridA.frames.light, gridB.frames.frame, gridB.frames.light, gridA.backing, gridB.backing);
      fields.push(fieldA, fieldB);

      // title + colour key strips along the foot of each wall (neon on white walls washed out)
      const nPlaying = queue.filter((g) => g.status === "playing").length;
      const keyA = legendStrip({
        title: "TEST QUEUE",
        items: [
          { color: "#ffb000", label: `IN PROGRESS · ${nPlaying}` },
          { color: "#e8f4ff", label: `UNTESTED · ${queue.length - nPlaying}` },
        ],
        note: "IN PROGRESS FIRST, THEN PRIORITY P1 → P5, THEN A → Z",
        width: gridA.width,
      });
      keyA.position.set(0, 0.27, -D / 2 + 0.021); // its backing reaches the wall
      const GRADE_WORDS: Record<string, string> = { "A+": "EXCEPTIONAL", A: "GREAT", B: "GOOD", C: "MIXED", D: "POOR", F: "FAILED" };
      const keyB = legendStrip({
        title: "TEST RESULTS",
        items: GRADE_ORDER.filter((g) => store.stats.grades[g as keyof typeof store.stats.grades]).map((g) => ({ color: GRADE_COLORS[g], label: `${g} ${GRADE_WORDS[g]} ${store.stats.grades[g as keyof typeof store.stats.grades]}` })),
        note: "BY GRADE, NEWEST FIRST",
        width: gridB.width,
      });
      keyB.position.copy(B_OFFSET).add(new THREE.Vector3(0, 0.27, -D / 2 + 0.021));
      scene.add(keyA, keyB);

      // chamber signs
      const s = store.stats;
      const signA = chamberSign({
        number: String(s.backlog),
        caption: "untested subjects",
        progress: s.pct,
        lines: [`${s.playing} tests in progress`, `${s.backlogHours.toLocaleString()} hours of testing remain`, s.clearYear ? `Projected completion: ${s.clearYear}` : "", `Top supplier: ${s.topDeveloper?.name ?? "-"}`].filter(Boolean),
      });
      signA.position.set(W / 2 - 0.02, 2.0, -1.4);
      signA.rotation.y = -Math.PI / 2;
      const signB = chamberSign({
        number: `${Math.round(s.pct * 100)}%`,
        caption: "of all subjects tested",
        progress: s.pct,
        lines: [`${s.completed} tests concluded`, `Average result: ${s.avgGrade ?? "-"}`, `${s.grades["A+"]} exceptional results`, `${s.physicalOwned} physical specimens retained`],
      });
      signB.position.copy(B_OFFSET).add(new THREE.Vector3(W / 2 - 0.02, 2.0, -1.4));
      signB.rotation.y = -Math.PI / 2;
      scene.add(signA, signB);

      // data boards: the forecast + subject profile + platforms (01), findings + crowd + decades (02)
      forecasts = await loadForecasts();
      for (const make of buildBoards(queue, results)) {
        scene.add(make());
        await progress("Printing the reports…");
      }

      // portals: blue in A (left wall) <-> orange in B (left wall)
      await progress("Calibrating portals…");
      portalA = new Portal("#3aa0ff", engine.matchingTarget(512, 512));
      portalB = new Portal("#ff8a1a", engine.matchingTarget(512, 512));
      portalA.group.position.set(-W / 2 + 0.03, 1.05, 0.6);
      portalA.group.rotation.y = Math.PI / 2;
      portalB.group.position.copy(B_OFFSET).add(new THREE.Vector3(-W / 2 + 0.03, 1.05, 0.6));
      portalB.group.rotation.y = Math.PI / 2;
      portalA.link(portalB);
      scene.add(portalA.group, portalB.group);
      for (const pt of [portalA, portalB]) c.audio.addEmitter({ position: pt.group.position.clone(), radius: 3.4, volume: 0.8, build: LOOPS.portalHum });
      c.pickable(portalA.surface, () => stepThrough(true));
      c.pickable(portalB.surface, () => stepThrough(false));
      let portalOpen = 0;
      let frameN = 0;
      const frustum = new THREE.Frustum();
      const projView = new THREE.Matrix4();
      tickers.push((dt) => {
        portalOpen = Math.min(1, portalOpen + dt * 0.8);
        portalA.setOpen(portalOpen);
        portalB.setOpen(portalOpen);
        // render the view through the portal on the camera's side, only when it's on screen
        // (every other frame on phones, at reduced resolution)
        frameN++;
        if (!live.fx || (engine.quality.mobile && frameN % 2)) return; // live portal views are an optional effect
        const near = inB ? portalB : portalA;
        frustum.setFromProjectionMatrix(projView.multiplyMatrices(c.camera.projectionMatrix, c.camera.matrixWorldInverse));
        near.surface.updateWorldMatrix(true, false);
        if (!near.surface.geometry.boundingSphere) near.surface.geometry.computeBoundingSphere();
        if (!frustum.intersectsObject(near.surface)) return;
        const r = engine.renderer;
        const size = r.getDrawingBufferSize(new THREE.Vector2());
        const scale = engine.quality.mobile ? 0.35 : 0.45;
        near.resize(size.x * scale, size.y * scale);
        near.updateCamera(c.camera);
        near.cam.layers.mask = c.camera.layers.mask;
        portalA.group.visible = portalB.group.visible = false;
        // same MRT, target layout and render context as the main pass: nothing new to compile
        engine.renderTo(scene, near.cam, near.rt);
        portalA.group.visible = portalB.group.visible = true;
      });

      // the Archivist hangs over chamber A
      archivist = new Archivist();
      archivist.group.position.set(2.2, 3.6, 0.2);
      scene.add(archivist.group);
      c.pickable(archivist.group, () => say(nextQuip()));
      caption = new DotMatrix({ width: 4.2, height: 0.18, rows: 14, color: "#ffb84a", off: "#2a2010", speed: 22 });
      caption.mesh.position.set(0, H - 0.3, -D / 2 + 0.03);
      scene.add(caption.mesh);
      const captionB = new DotMatrix({ width: 4.2, height: 0.18, rows: 14, color: "#ffb84a", off: "#2a2010", speed: 22 });
      captionB.mesh.position.copy(B_OFFSET).add(new THREE.Vector3(0, H - 0.3, -D / 2 + 0.03));
      scene.add(captionB.mesh);
      // the LED panels sit in a housing on the wall (a bare plane would float 3 cm off it)
      const housingMat = new THREE.MeshStandardNodeMaterial({ color: 0x1a1b1f, roughness: 0.45, metalness: 0.5 });
      for (const o of [new THREE.Vector3(), B_OFFSET]) {
        const housing = new THREE.Mesh(boxes([[0, 0, 0, 4.28, 0.26, 0.028]]), housingMat);
        housing.position.copy(o).add(new THREE.Vector3(0, H - 0.3, -D / 2 + 0.014));
        scene.add(housing);
      }
      tickers.push((dt, t) => {
        caption.update(dt);
        captionB.update(dt);
        archivist.update(t, c.camera.position);
        archivist.mood.value = Math.max(0, archivist.mood.value - dt * 0.4);
        quipT -= dt;
        if (quipT <= 0) {
          quipT = 28 + Math.random() * 20;
          say(nextQuip(), false);
        }
      });
      (captionB as any)._mirror = true;
      const sayTo = (text: string) => {
        caption.setText(text + "      ");
        captionB.setText(text + "      ");
      };
      (level as any)._sayTo = sayTo;
      quips = buildQuips();
      sayTo("WELCOME TO THE BACKLOG SCIENCE ENRICHMENT CENTER.  " + quips[0]);

      // pneumatic tubes carrying the wishlist upward
      await progress("Pressurizing tubes…");
      const wish = store.games.filter((g) => g.status === "wishlist");
      for (const x of tubeX) {
        const tb = tube(H, 0.17); // floor to ceiling: the top collar meets the ceiling
        tb.position.set(x, 0, D / 2 - 0.5);
        scene.add(tb);
      }
      c.audio.addEmitter({ position: new THREE.Vector3(tubeX[1], 1.6, D / 2 - 0.5), radius: 3.6, volume: 0.8, build: LOOPS.tubes });
      const perTube = 9;
      const items = wish.slice(0, perTube * tubeX.length).map((g, i) => ({ game: g, tube: i % tubeX.length, phase: Math.floor(i / tubeX.length) / perTube }));
      // solid specimens (additive holograms vanish against white walls)
      const tf = new MediaField(c.kit, items.map((it) => ({ game: it.game, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: 1 })), { name: "tubes" });
      scene.add(tf.group);
      fields.push(tf);
      tubeField = { field: tf, items };
      const tubeSign = legendStrip({ title: "PENDING ACQUISITION", note: `${wish.length} SUBJECTS · $${store.stats.wishlistLoose.toLocaleString()}`, width: 1.9, height: 0.2 });
      tubeSign.position.set(tubeX[1], 2.75, D / 2 - 0.021); // its backing reaches the wall
      tubeSign.rotation.y = Math.PI;
      scene.add(tubeSign);

      // a companion cube on a pedestal
      const ped = new THREE.Mesh(boxes([[0, 0.25, 0, 0.6, 0.5, 0.6]]), new THREE.MeshStandardNodeMaterial({ color: 0x3a3c42, roughness: 0.4, metalness: 0.5 }));
      ped.position.set(2.7, 0, 2.3);
      const cube = companionCube(0.4);
      cube.position.set(2.7, 0.7, 2.3); // resting on the pedestal top (0.5) — it hovered 2 cm
      cube.rotation.y = 0.4;
      scene.add(ped, cube);
      const cubeLines = ["The cube does not want to be in your backlog either.", "It has been with you through every test. It will not be playing any of them.", "Please do not attempt to transfer your feelings to the backlog."];
      let cubeIdx = 0;
      c.pickable(cube, () => {
        c.audio.play("boop", { at: cube.position });
        say(cubeLines[cubeIdx++ % cubeLines.length]);
      });

      // lab equipment, test elements and signage in both chambers (one baked mesh per chamber)
      await decorateLab(c, { W, D, H, origins: [new THREE.Vector3(), B_OFFSET] });

      // rails: a U around each chamber's back + side walls
      const mk = (o: THREE.Vector3) =>
        wallRail(
          [
            [o.x + W / 2 - 0.4, o.z + D / 2 - 0.4],
            [o.x + W / 2 - 0.4, o.z - D / 2 + 0.4],
            [o.x - W / 2 + 0.4, o.z - D / 2 + 0.4],
            [o.x - W / 2 + 0.4, o.z + D / 2 - 0.4],
          ],
          // a closed loop round all four walls: browsing wraps instead of stopping in a corner
          { closed: true, h: [0.4, 4.4], d: [0.4, 5.6], h0: 1.6, d0: 2.6, lift: 0.12, round: 1.0 },
        );
      railA = mk(new THREE.Vector3());
      railB = mk(B_OFFSET);
      // the camera can pull back a long way: keep it out of the props standing in the chambers
      const V = (x: number, y: number, z: number, o = new THREE.Vector3()) => new THREE.Vector3(x, y, z).add(o);
      c.rig.obstacles = [
        { a: V(2.2, 3.6, 0.2), b: V(2.2, 4.9, 0.2), r: 0.75 }, // the Archivist and its arm
        { a: V(2.7, 4.0, 2.3), b: V(2.7, 5.2, 2.3), r: 0.5 }, // the cube dispenser (0.47 m round)
        { a: V(2.7, 0, 2.3), b: V(2.7, 0.8, 2.3), r: 0.55 }, // the cube on its pedestal
        { a: V(1.2, 4.9, 1.9, B_OFFSET), b: V(1.3, 2.0, 0.9, B_OFFSET), r: 0.6 }, // chamber 02's robotic arm
        { a: V(0.9, 0.2, 0.75, B_OFFSET), b: V(1.7, 0.2, 0.75, B_OFFSET), r: 0.6 }, // its faith plate
      ];
      const backS = (r: Rail, o: THREE.Vector3) => r.project(o.clone().add(new THREE.Vector3(0, 0, -D / 2)));
      c.rig.setRail(railA, { s: backS(railA, new THREE.Vector3()), h: 2.0, d: 5.2 });
      const goA = (s: number, h: number, d: number) => () => {
        if (inB) switchTo(false);
        c.rig.goTo({ s, h, d });
      };
      const goB = (s: number, h: number, d: number) => () => {
        if (!inB) switchTo(true);
        c.rig.goTo({ s, h, d });
      };
      const sA = backS(railA, new THREE.Vector3());
      const sB = backS(railB, B_OFFSET);
      // Frame a set of cells: fit them on screen if possible, otherwise start at their top-left
      // corner (the order reads left to right, top to bottom) at the widest view the room allows
      const frameCells = (r: Rail, grid: typeof gridA, list: Game[], offset: THREE.Vector3) => {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const g of list) {
          const p = grid.centers.get(g.id);
          if (!p) continue;
          x0 = Math.min(x0, p.x - CELL / 2);
          x1 = Math.max(x1, p.x + CELL / 2);
          y0 = Math.min(y0, p.y - CELL / 2);
          y1 = Math.max(y1, p.y + CELL / 2);
        }
        if (!isFinite(x0)) return { s: r.project(offset), h: 2, d: 4 };
        const cam = c.camera;
        const tv = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * 0.84; // leave room for the HUD bars
        const th = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect * 0.94;
        const pad = 0.1;
        const bw = x1 - x0 + 2 * pad, bh = y1 - y0 + 2 * pad;
        const off = 0.27; // the rail runs this far in front of the cells
        const dist = Math.min(r.opts.d[1] + off, Math.max(0.9, bh / 2 / tv, bw / 2 / th));
        let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const hw = dist * th, hh = dist * tv;
        if (bw / 2 > hw) cx = x0 - pad + hw;
        if (bh / 2 > hh) cy = y1 + pad - hh;
        return { s: r.project(new THREE.Vector3(cx, 0, offset.z - D / 2)), h: cy, d: dist - off };
      };
      const fr = (b: boolean, grid: typeof gridA, list: () => Game[]) => () => {
        if (b !== inB) switchTo(b);
        const o = b ? B_OFFSET : new THREE.Vector3();
        c.rig.goTo(frameCells(b ? railB : railA, grid, list(), o), 1.4);
      };
      stations.push(
        { id: "queue", label: "Test Queue", go: fr(false, gridA, () => queue) },
        { id: "playing", label: "In Progress", go: fr(false, gridA, () => queue.filter((g) => g.status === "playing")) },
        { id: "results", label: "Results", go: fr(true, gridB, () => results) },
        { id: "aplus", label: "A+ Wall", go: fr(true, gridB, () => results.filter((g) => g.grade === "A+")) },
        { id: "portal", label: "Portal", go: goA(railA.project(portalA.group.position), 1.3, 2.4) },
        { id: "tubes", label: "Pending", go: goA(railA.project(new THREE.Vector3(-2.6, 0, D / 2)), 1.75, 2.6) }, // (sign at 2.75 m in view)
        { id: "stats", label: "Chamber Sign", go: goA(railA.project(signA.position), 2.0, 2.0) },
        { id: "forecast", label: "Forecast", go: goA(railA.project(new THREE.Vector3(1.32, 0, D / 2)), 2.1, 4.3) },
        { id: "findings", label: "Findings", go: goB(railB.project(B_OFFSET.clone().add(new THREE.Vector3(1.32, 0, D / 2))), 2.1, 4.3) },
      );
      void sA;
      void sB;
    },

    update(dt, t) {
      labFx.since.value += dt;
      for (const fn of tickers) fn(dt, t);
      if (tubeField) {
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3();
        for (const it of tubeField.items) {
          const k = (it.phase + t * 0.035) % 1;
          p.set(tubeX[it.tube], 0.2 + k * (H - 0.6), D / 2 - 0.5);
          q.setFromEuler(new THREE.Euler(Math.sin(t + it.phase * 20) * 0.3, t * 0.8 + it.phase * 12, Math.cos(t * 0.7 + it.phase * 9) * 0.3));
          const sz = templateOf(it.game, ctx.art).size;
          const sc = Math.min(0.24 / Math.max(sz[0], sz[1]), 1.6);
          m.compose(p, q, new THREE.Vector3(sc, sc, sc));
          tubeField.field.setMatrix(it.game.id, m);
        }
      }
    },

    focusGame(g) {
      for (const f of fields) {
        const p = f.centerOf(g.id);
        if (!p) continue;
        const wantB = p.x > B_OFFSET.x / 2;
        if (wantB !== inB) switchTo(wantB);
        const r = wantB ? railB : railA;
        ctx.rig.goTo({ s: r.project(p), h: p.y, d: 0.75 }, 1.2);
        return;
      }
    },

    onSelect(g) {
      if (g) say(commentOn(g));
    },

    dispose() {
      for (const f of fields) f.dispose();
      portalA?.rt.dispose();
      portalB?.rt.dispose();
    },
  };

  function switchTo(b: boolean) {
    inB = b;
    const r = b ? railB : railA;
    const st = { ...ctx.rig.state };
    ctx.engine.post.flash.value = 0.35;
    const t0 = performance.now();
    const fade = () => {
      const k = (performance.now() - t0) / 400;
      ctx.engine.post.flash.value = Math.max(0, 0.35 * (1 - k));
      if (k < 1) requestAnimationFrame(fade);
    };
    fade();
    ctx.rig.setRail(r, { s: Math.min(st.s, r.length), h: st.h, d: st.d });
  }

  function stepThrough(fromA: boolean) {
    ctx.audio.play("portal");
    switchTo(fromA);
    const r = fromA ? railB : railA;
    const p = (fromA ? portalB : portalA).group.position;
    ctx.rig.setRail(r, { s: r.project(p), h: 1.3, d: 1.2 });
    ctx.rig.goTo({ s: r.project(p.clone().add(new THREE.Vector3(3, 0, -D / 2))), h: 2.0, d: 4.2 }, 1.6);
    say(fromA ? "You have entered the results chamber. Try not to gloat." : "Back to the queue. It missed you. It did not get shorter.");
  }

  function say(text: string, talk = true) {
    (level as any)._sayTo?.(text.toUpperCase());
    if (talk) {
      archivist.mood.value = 1;
      ctx.audio.play("chatter", { at: archivist.group.position, pitch: 0.9 + Math.random() * 0.2 });
      ctx.toast(`🤖 ${text}`, 4200);
    }
  }

  function nextQuip() {
    quipIdx = (quipIdx + 1) % quips.length;
    return quips[quipIdx];
  }

  function buildQuips(): string[] {
    const s = ctx.store.stats;
    const years = s.clearYear ? s.clearYear - new Date().getFullYear() : 0;
    return [
      `You have ${s.backlog} untested subjects. At your current rate of ${s.pace} per year, testing concludes in ${s.clearYear ?? "the distant future"}. I will wait.`,
      `${s.backlogHours.toLocaleString()} hours of testing remain. That is ${Math.round(s.backlogHours / 24)} days without sleep. I have scheduled none.`,
      `Your most reliable supplier of test subjects is ${s.topDeveloper?.name ?? "unknown"}, with ${s.topDeveloper?.count ?? 0} specimens. They must be very proud.`,
      `${s.wishlist} additional subjects are pending acquisition. Acquiring games is not the same as playing them. This has been noted.`,
      `${s.grades["A+"]} subjects earned an A plus. ${s.grades.F} earned an F. The F subjects have been reassigned to the incinerator. Metaphorically.`,
      `Average test result: ${s.avgGrade ?? "?"}. Statistically, you are a ${s.avgGrade === "B" ? "B" : "fine"} tester. I say that with all the warmth I am capable of.`,
      `${s.playing} tests are currently in progress. Simultaneously. That is not how tests work.`,
      years > 0 ? `Projected completion in ${years} years. Please do not acquire any more subjects. You will acquire more subjects.` : `Testing may soon be complete. I find that unsettling.`,
      `${s.physicalOwned} physical specimens are retained in storage, valued at $${s.valueOwned.toLocaleString()}. Please do not sell the specimens.`,
    ];
  }

  function commentOn(g: Game): string {
    const p = platformOf(g.platform).short;
    const year = ctx.art.year(g);
    const age = year ? new Date().getFullYear() - year : 0;
    if (g.status === "wishlist") return `${g.title}: not yet acquired. Estimated cost $${g.looseValue ?? "?"}.`;
    if (g.status === "playing") return `${g.title} (${p}): test in progress. Please continue. Eventually.`;
    const fc = forecasts?.forecasts[g.id];
    if (fc && g.status === "backlog" && Math.random() < 0.6) {
      const pct = Math.round((forecasts!.backtest.exact ?? 0.45) * 100);
      return `${g.title}: my models predict a ${fc.grade.replace("+", " plus")}. ${fc.why.replace(/\.$/, "")}. I am right ${pct} percent of the time. You are right less often.`;
    }
    if (g.status === "backlog") {
      if (age > 25) return `${g.title} has waited ${age} years for testing. It is very patient. More patient than me.`;
      if (g.priority === 1) return `${g.title}: priority one. Which apparently means "soon-ish".`;
      return `${g.title}: queued for testing${g.hours ? `. Estimated duration ${g.hours} hours` : ""}. Your enthusiasm has been logged.`;
    }
    switch (g.grade) {
      case "A+":
        return `${g.title}: result A plus. Exceptional. I was not aware you were capable of that.`;
      case "A":
        return `${g.title}: result A. An excellent test. Do not let it go to your head.`;
      case "B":
        return `${g.title}: result B. Satisfactory. The subject has been thanked for its service.`;
      case "C":
        return `${g.title}: result C. Adequate. Nobody will remember this test, including the subject.`;
      case "D":
        return `${g.title}: result D. The subject has been asked to reflect on its choices.`;
      case "F":
        return `${g.title}: result F. The subject has been disposed of. Please do not attempt to retrieve it.`;
      default:
        return `${g.title}: test concluded.`;
    }
  }

  /** The data boards on the front + right walls of both chambers. */
  function buildBoards(queue: Game[], results: Game[]) {
    const out: (() => THREE.Object3D)[] = [];
    const place = (make: () => THREE.Object3D, chamberB: boolean, wall: "front" | "right", along: number, y: number) => out.push(() => {
      const m = make();
      const o = chamberB ? B_OFFSET : new THREE.Vector3();
      if (wall === "front") {
        m.position.copy(o).add(new THREE.Vector3(along, y, D / 2 - 0.035));
        m.rotation.y = Math.PI;
      } else {
        m.position.copy(o).add(new THREE.Vector3(W / 2 - 0.035, y, along));
        m.rotation.y = -Math.PI / 2;
      }
      return m;
    });
    const titleOf = (id: string) => ctx.store.byId.get(id)?.title ?? id;
    const F = forecasts;
    const s = ctx.store.stats;

    // --- 01 front: FORECAST
    if (F) {
      const fs = queue.map((g) => F.forecasts[g.id]).filter(Boolean);
      const counts = GRADE_ORDER.map((g) => ({ g, n: fs.filter((f) => f.grade === g).length })).filter((x) => x.n);
      const best = queue
        .filter((g) => F.forecasts[g.id] && GRADE_ORDER.indexOf(F.forecasts[g.id].grade) <= 1)
        .sort((a, b) => GRADE_ORDER.indexOf(F.forecasts[a.id].grade) - GRADE_ORDER.indexOf(F.forecasts[b.id].grade) || F.forecasts[b.id].confidence - F.forecasts[a.id].confidence)
        .slice(0, 5);
      place(
        () => dataBoard(2.5, 1.6, (b) => {
          b.head("FORECAST", `Predicted results for ${fs.length} untested subjects`, `${Math.round(F.backtest.withinOne * 100)}%`);
          b.bars(counts.map((x) => ({ label: x.g, value: x.n, color: GRADE_COLORS[x.g] })), { labelW: 130, rowH: 80 });
          b.text("MOST PROMISING", { size: 56, font: "600", color: "#555", gap: 8 });
          for (const g of best.slice(0, 4)) if (!b.text(`${g.title}: ${F.forecasts[g.id].grade}. ${F.forecasts[g.id].why}`, { size: 56, indent: 56, bullet: "•", gap: 10 })) break;
          b.foot(`Within one grade ${Math.round(F.backtest.withinOne * 100)}% of the time · exactly right ${Math.round(F.backtest.exact * 100)}% · tested on ${F.backtest.n} past results`);
        }),
        false, "front", 0.0, 2.15,
      );
      // --- 01 front: SUBJECT PROFILE
      place(
        () => dataBoard(2.0, 1.6, (b) => {
          b.head("SUBJECT PROFILE", "Observed from 186 written reviews");
          b.text("RESPONDS WELL TO", { size: 62, font: "600", color: "#2a7a3a", gap: 6 });
          for (const l of F.context.likes.slice(0, 6)) b.text(l, { size: 59, indent: 62, bullet: "+", gap: 4 });
          b.y += 14;
          b.text("ADVERSE REACTIONS", { size: 62, font: "600", color: "#b2392b", gap: 6 });
          for (const l of F.context.dislikes.slice(0, 6)) if (!b.text(l, { size: 59, indent: 62, bullet: "−", gap: 4 })) break;
        }),
        false, "front", 2.65, 2.15,
      );
    }
    // --- 01 right: PLATFORMS (untested subjects by platform)
    const plat = s.platforms.filter((p) => p.backlog > 0).sort((a, b) => b.backlog - a.backlog).slice(0, 10);
    place(
      () => dataBoard(2.3, 1.55, (b) => {
        b.head("SUBJECT ORIGINS", "Untested subjects by platform", String(s.backlog));
        b.bars(plat.map((p) => ({ label: platformOf(p.platform).short, value: p.backlog, color: platformOf(p.platform).neon, text: `${p.backlog} · ${Math.round(p.pct * 100)}%` })), { labelW: 250, rowH: 82 });
        b.foot("bar = untested · % = share of that platform already tested");
      }),
      false, "right", 1.7, 2.05,
    );

    if (F) {
      // --- 02 front: FINDINGS
      place(
        () => dataBoard(2.5, 1.6, (b) => {
          b.head("FINDINGS", `${F.backtest.n} results, compared with ${F.context.vsCommunity.n} crowd ratings`);
          for (const l of F.insights.slice(0, 9)) if (!b.text(l, { size: 64, indent: 64, bullet: "•", gap: 12 })) break;
        }),
        true, "front", 0.0, 2.15,
      );
      // --- 02 front: COOPER VS THE CROWD
      const dis = F.context.disagreements;
      const harsh = dis.filter((d) => GRADE_ORDER.indexOf(d.grade) >= 3).slice(0, 2);
      const kind = dis.filter((d) => GRADE_ORDER.indexOf(d.grade) <= 1).slice(0, 2);
      place(
        () => dataBoard(2.0, 1.6, (b) => {
          b.head("SUBJECT VS CROWD", `Harsher on ${F.context.vsCommunity.harsher} · kinder on ${F.context.vsCommunity.kinder}`);
          b.text("HARSHER THAN THE CROWD", { size: 56, font: "600", color: "#b2392b", gap: 6 });
          for (const d of harsh) b.text(`${titleOf(d.id)}: ${d.grade} vs ★${d.community.toFixed(1)}. ${d.note}`, { size: 50, indent: 53, bullet: "•", gap: 8 });
          b.y += 10;
          b.text("KINDER THAN THE CROWD", { size: 56, font: "600", color: "#2a7a3a", gap: 6 });
          for (const d of kind) if (!b.text(`${titleOf(d.id)}: ${d.grade} vs ★${d.community.toFixed(1)}. ${d.note}`, { size: 50, indent: 53, bullet: "•", gap: 8 })) break;
        }),
        true, "front", 2.65, 2.15,
      );
      // --- 02 right: BY DECADE + PER YEAR
      const years = s.completionsByYear.slice(-7);
      place(
        () => dataBoard(2.3, 1.55, (b) => {
          b.head("RESULTS BY ERA", "Average grade by release decade");
          b.bars(F.context.byDecade.map((d) => ({ label: d.decade, value: d.avg, color: GRADE_COLORS[letterOf(d.avg)] ?? "#888", text: `${letterOf(d.avg)} · ${d.n}` })), { max: 5, labelW: 220, rowH: 76 });
          b.text("TESTS CONCLUDED PER YEAR", { size: 56, font: "600", color: "#555", gap: 6 });
          b.bars(years.map((y) => ({ label: String(y.year), value: y.count, color: "#3a3d44" })), { labelW: 220, rowH: 60 });
        }),
        true, "right", 1.7, 2.05,
      );
    }
    return out;
  }

  function buildChamber(scene: THREE.Scene, o: THREE.Vector3, num: string) {
    const g = new THREE.Group();
    g.position.copy(o);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), panelMaterial({ size: 1.0, dark: 0.08, axis: "xz" }));
    floor.rotation.x = -Math.PI / 2;
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), panelMaterial({ size: 1.2, dark: 0.3, axis: "xz" }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = H;
    const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), panelMaterial({ size: 0.75 }));
    back.position.set(0, H / 2, -D / 2);
    const front = new THREE.Mesh(new THREE.PlaneGeometry(W, H), panelMaterial({ size: 0.75 }));
    front.position.set(0, H / 2, D / 2);
    front.rotation.y = Math.PI;
    const left = new THREE.Mesh(new THREE.PlaneGeometry(D, H), panelMaterial({ size: 0.75, axis: "zy" }));
    left.position.set(-W / 2, H / 2, 0);
    left.rotation.y = Math.PI / 2;
    const right = new THREE.Mesh(new THREE.PlaneGeometry(D, H), panelMaterial({ size: 0.75, axis: "zy" }));
    right.position.set(W / 2, H / 2, 0);
    right.rotation.y = -Math.PI / 2;
    g.add(floor, ceil, back, front, left, right);
    // ceiling light panels
    const lights = new THREE.Mesh(
      boxes([
        [-2.5, H - 0.03, -1.5, 1.6, 0.04, 0.5],
        [2.5, H - 0.03, -1.5, 1.6, 0.04, 0.5],
        [-2.5, H - 0.03, 1.5, 1.6, 0.04, 0.5],
        [2.5, H - 0.03, 1.5, 1.6, 0.04, 0.5],
      ]),
      neonMaterial("#f4f8ff", 2.2),
    );
    g.add(lights);
    // chamber number stencil
    const n = neonSign(num, { font: `"Oswald", sans-serif`, height: 0.9, color: "#2b2d33", intensity: 0.0 });
    n.position.set(W / 2 - 0.005, 3.9, 1.8);
    n.rotation.y = -Math.PI / 2;
    g.add(n);
    scene.add(g);
    return g;
  }

  /** Lay games into a wall of cells, row-major from the top-left. */
  function buildGrid(games: Game[], wallCenter: THREE.Vector3, colorOf: (g: Game) => string) {
    const cols = Math.min(32, Math.ceil(Math.sqrt(games.length * 1.9)));
    const rows = Math.ceil(games.length / cols);
    const width = cols * CELL, height = rows * CELL;
    const y0 = Math.max(0.55, (H - height) / 2 - 0.1);
    const top = y0 + height;
    const n = new THREE.Vector3(0, 0, 1);
    const q = faceOut(n);
    const placements: Placement[] = [];
    const cells: Parameters<typeof cellFrames>[0] = [];
    const centers = new Map<string, THREE.Vector3>();
    games.forEach((g, i) => {
      const cx = i % cols, cy = Math.floor(i / cols);
      const center = wallCenter.clone().add(new THREE.Vector3(-width / 2 + (cx + 0.5) * CELL, top - (cy + 0.5) * CELL, 0.13));
      const [w, h] = templateOf(g, ctx.art).size;
      const sc = Math.min((CELL * 0.72) / w, (CELL * 0.7) / h, 1.7);
      placements.push({ game: g, position: center.clone().add(new THREE.Vector3(0, (-h * sc) / 2 + 0.008, -0.02)), quaternion: q, scale: sc });
      cells.push({ pos: center, quat: new THREE.Quaternion(), color: new THREE.Color(colorOf(g)).convertSRGBToLinear(), size: CELL });
      centers.set(g.id, center);
    });
    // a solid cabinet behind the cells, from the wall to their back plates: the frames used to float
    // 10 cm off the wall (and deep cases like arcade cabinets poked out behind the plates)
    const full = Math.floor(games.length / cols), rem = games.length % cols, depth = 0.106;
    const parts: [number, number, number, number, number, number][] = [];
    if (full) parts.push([0, top - (full * CELL) / 2, depth / 2 - 0.0005, width, full * CELL, depth + 0.001]);
    if (rem) parts.push([-width / 2 + (rem * CELL) / 2, top - full * CELL - CELL / 2, depth / 2 - 0.0005, rem * CELL, CELL, depth + 0.001]);
    const backing = new THREE.Mesh(boxes(parts), new THREE.MeshStandardNodeMaterial({ color: 0x24262b, roughness: 0.5, metalness: 0.4 }));
    backing.position.copy(wallCenter);
    return { placements, frames: cellFrames(cells), top, width, centers, backing };
  }

  return level;
}

export type { LevelCtx };
