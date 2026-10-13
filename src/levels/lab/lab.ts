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
import { panelMaterial, Portal, chamberSign, Archivist, tube, companionCube, cellFrames, labFx } from "../../world/kit/lab";
import { boxes, neonMaterial, neonSign } from "../../world/kit/common";
import { neonEnvironment } from "../../world/kit/env";
import { DotMatrix } from "../../world/kit/displays";
import { GRADE_COLORS } from "../../media/spines";
import type { Level, LevelCtx, Station } from "../types";
import { LOOPS } from "../../audio/sfx";

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
      engine.post.bloomStrength.value = 0.7;
      engine.post.bloomRadius.value = 0.4;
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
      scene.add(fieldA.group, fieldB.group, gridA.frames.frame, gridA.frames.light, gridB.frames.frame, gridB.frames.light);
      fields.push(fieldA, fieldB);

      // wall headers
      const hdrA = neonSign("TEST QUEUE", { font: `"Oswald", sans-serif`, height: 0.32, color: "#4fb2ff", intensity: 2.2 });
      hdrA.position.set(0, gridA.top + 0.35, -D / 2 + 0.02);
      const hdrB = neonSign("TEST RESULTS", { font: `"Oswald", sans-serif`, height: 0.32, color: "#ff9a2a", intensity: 2.2 });
      hdrB.position.copy(B_OFFSET).add(new THREE.Vector3(0, gridB.top + 0.35, -D / 2 + 0.02));
      scene.add(hdrA, hdrB);
      // grade legend under the results wall
      GRADE_ORDER.forEach((g, i) => {
        const n = store.stats.grades[g as keyof typeof store.stats.grades];
        const sign = neonSign(`${g} ×${n}`, { font: `"Oswald", sans-serif`, height: 0.13, color: GRADE_COLORS[g], intensity: 2 });
        sign.position.copy(B_OFFSET).add(new THREE.Vector3(-2.5 + i * 1.0, 0.32, -D / 2 + 0.03));
        scene.add(sign);
      });

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
        if (engine.quality.mobile && frameN % 2) return;
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
        portalA.group.visible = portalB.group.visible = false;
        // same MRT + target layout as the main pass: no extra shader variants to compile
        const prevMrt = r.getMRT(), prevRt = r.getRenderTarget();
        r.setRenderTarget(near.rt);
        r.setMRT(engine.mrt);
        r.render(scene, near.cam);
        r.setMRT(prevMrt);
        r.setRenderTarget(prevRt);
        portalA.group.visible = portalB.group.visible = true;
      });

      // the Archivist hangs over chamber A
      archivist = new Archivist();
      archivist.group.position.set(2.2, 3.6, 0.2);
      scene.add(archivist.group);
      c.pickable(archivist.group, () => say(nextQuip()));
      caption = new DotMatrix({ width: 4.2, height: 0.18, rows: 14, color: "#ffb84a", off: "#2a2010", speed: 22 });
      caption.mesh.position.set(0, H - 0.45, -D / 2 + 0.03);
      scene.add(caption.mesh);
      const captionB = new DotMatrix({ width: 4.2, height: 0.18, rows: 14, color: "#ffb84a", off: "#2a2010", speed: 22 });
      captionB.mesh.position.copy(B_OFFSET).add(new THREE.Vector3(0, H - 0.45, -D / 2 + 0.03));
      scene.add(captionB.mesh);
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
        const tb = tube(H - 0.2, 0.17);
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
      const tubeSign = neonSign("PENDING ACQUISITION", { font: `"Oswald", sans-serif`, height: 0.14, color: "#4fd8ff", intensity: 2 });
      tubeSign.position.set(-2.6, 2.6, D / 2 - 0.03);
      tubeSign.rotation.y = Math.PI;
      scene.add(tubeSign);
      const tubeCount = neonSign(`${wish.length} SUBJECTS · $${store.stats.wishlistLoose.toLocaleString()}`, { font: `"Oswald", sans-serif`, height: 0.1, color: "#4fd8ff", intensity: 1.5 });
      tubeCount.position.set(-2.6, 2.42, D / 2 - 0.03);
      tubeCount.rotation.y = Math.PI;
      scene.add(tubeCount);

      // a companion cube on a pedestal
      const ped = new THREE.Mesh(boxes([[0, 0.25, 0, 0.6, 0.5, 0.6]]), new THREE.MeshStandardNodeMaterial({ color: 0x3a3c42, roughness: 0.4, metalness: 0.5 }));
      ped.position.set(2.7, 0, 2.3);
      const cube = companionCube(0.4);
      cube.position.set(2.7, 0.72, 2.3);
      cube.rotation.y = 0.4;
      scene.add(ped, cube);
      const cubeLines = ["The cube does not want to be in your backlog either.", "It has been with you through every test. It will not be playing any of them.", "Please do not attempt to transfer your feelings to the backlog."];
      let cubeIdx = 0;
      c.pickable(cube, () => {
        c.audio.play("boop", { at: cube.position });
        say(cubeLines[cubeIdx++ % cubeLines.length]);
      });

      // rails: a U around each chamber's back + side walls
      const mk = (o: THREE.Vector3) =>
        wallRail(
          [
            [o.x + W / 2 - 0.4, o.z + D / 2 - 0.6],
            [o.x + W / 2 - 0.4, o.z - D / 2 + 0.4],
            [o.x - W / 2 + 0.4, o.z - D / 2 + 0.4],
            [o.x - W / 2 + 0.4, o.z + D / 2 - 0.4],
            [o.x + W / 2 - 0.4, o.z + D / 2 - 0.4],
          ],
          { closed: false, h: [0.4, 4.4], d: [0.4, 5.6], h0: 1.6, d0: 2.6, lift: 0.12, round: 1.0 },
        );
      railA = mk(new THREE.Vector3());
      railB = mk(B_OFFSET);
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
      stations.push(
        { id: "queue", label: "Test Queue", go: goA(sA, 2.1, 4.6) },
        { id: "playing", label: "In Progress", go: goA(sA - (gridA.width / 2 - 0.6), gridA.top - 0.4, 1.3) },
        { id: "results", label: "Results", go: goB(sB, 2.1, 4.6) },
        { id: "aplus", label: "A+ Wall", go: goB(sB - (gridB.width / 2 - 0.6), gridB.top - 0.4, 1.3) },
        { id: "portal", label: "Portal", go: goA(railA.project(portalA.group.position), 1.3, 2.4) },
        { id: "tubes", label: "Pending", go: goA(railA.project(new THREE.Vector3(-2.6, 0, D / 2)), 1.6, 2.2) },
        { id: "stats", label: "Chamber Sign", go: goA(railA.project(signA.position), 2.0, 2.0) },
      );
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
    if (g.status === "wishlist") return `${g.title}: not yet acquired. Estimated cost $${g.looseValue ?? "?"}. You do not need it. You will buy it.`;
    if (g.status === "playing") return `${g.title} (${p}): test in progress. Please continue. Eventually.`;
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
    n.position.set(W / 2 - 0.01, 3.9, 1.8);
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
    games.forEach((g, i) => {
      const cx = i % cols, cy = Math.floor(i / cols);
      const center = wallCenter.clone().add(new THREE.Vector3(-width / 2 + (cx + 0.5) * CELL, top - (cy + 0.5) * CELL, 0.13));
      const [w, h] = templateOf(g, ctx.art).size;
      const sc = Math.min((CELL * 0.72) / w, (CELL * 0.7) / h, 1.7);
      placements.push({ game: g, position: center.clone().add(new THREE.Vector3(0, (-h * sc) / 2 + 0.008, -0.02)), quaternion: q, scale: sc });
      cells.push({ pos: center, quat: new THREE.Quaternion(), color: new THREE.Color(colorOf(g)).convertSRGBToLinear(), size: CELL });
    });
    return { placements, frames: cellFrames(cells), top, width };
  }

  return level;
}

export type { LevelCtx };
