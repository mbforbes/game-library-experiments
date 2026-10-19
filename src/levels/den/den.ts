// THE NEON DEN — a late-night game room that's slightly bigger (and stranger) on the inside.
//
//   back wall   : console library (bookcases, by platform in launch order) + CRT TV nook + LED ticker
//   left wall   : PC wall (90s big boxes, glowing digital slabs) + battlestation desk
//   right wall  : the cartridge wall (every cart face-out) with mini arcade cabinets on top
//   front wall  : arcade alcove, the impossible window, the Want-O-Matic (wishlist) alcove,
//                 split-flap NOW PLAYING board
//   centre      : rug, couch, holo-table projecting the selected game
//
// Everything that holds games is sized from the data, so the room grows with the backlog.

import * as THREE from "three/webgpu";
import { texture, vec3, uv, fract, step, length, vec2, float, mix, positionWorld, hash, floor } from "three/tsl";
import type { Game } from "../../../shared/types";
import { platformOf, type MediaKind } from "../../../shared/platforms";
import { wallRail, type Rail } from "../../engine/rail";
import { MediaField, kindOf, type Placement } from "../../media/field";
import { packShelves, runLength, type Mode, type Shelf, faceOut } from "../../world/shelving";
import { bookcase, couch, rug, roundTable } from "../../world/kit/furniture";
import { boxes, canvas, canvasTexture, lin, neonFx, neonMaterial, neonSign } from "../../world/kit/common";
import { DotMatrix, SplitFlap, ledPanel } from "../../world/kit/displays";
import { CrtScreen, arcadeCabinet, crtTv } from "../../world/kit/screens";
import { Hologram } from "../../world/kit/hologram";
import { VendingMachine } from "../../world/kit/vending";
import { buildOutside, billboard, outsideFx } from "../../world/kit/outside";
import { neonEnvironment } from "../../world/kit/env";
import { poster } from "../../world/kit/decor";
import { GRADE_COLORS } from "../../media/spines";
import { DecorBuilder } from "../../world/kit/decorkit";
import { LabelSheet } from "../../world/kit/labels";
import type { Level, LevelCtx, Station } from "../types";
import { DenEggs } from "./eggs";
import { decorateDen } from "./decor";
import { dust } from "../../world/kit/medieval";

const X0 = -4, X1 = 4, Z0 = -3, Z1 = 3, CEIL = 3.0;
const INSET = 0.35; // rail runs this far in front of the walls (bookcase fronts)
const CART_KINDS = new Set<MediaKind>(["nes-cart", "snes-cart", "n64-cart", "gb-cart", "gba-cart", "gg-cart", "msx-cart", "hucard"]);
const UP = new THREE.Vector3(0, 1, 0);

const sortTitle = (t: string) => t.toLowerCase().replace(/^(the|a)\s+/, "");
const byTitle = (a: Game, b: Game) => sortTitle(a.title).localeCompare(sortTitle(b.title));

export default function den(): Level {
  // every shelf-edge label in the room, as one mesh
  const labels = new LabelSheet([256, 40], [0.15, 0.0234]);
  let ctx: LevelCtx;
  let rail: Rail;
  const fields: MediaField[] = [];
  const stations: Station[] = [];
  const tickers: ((dt: number, t: number) => void)[] = [];
  let holo: Hologram;
  let tv: CrtScreen;
  let vending: VendingMachine;
  let eggs: DenEggs;
  let consoleField: MediaField, pcField: MediaField, cartField: MediaField;
  let housing: THREE.MeshStandardNodeMaterial | null = null;
  /** Dark satin housing behind the bare display panels (ticker, split-flap, bookcase LED panels). */
  const housingMaterial = () => (housing ??= new THREE.MeshStandardNodeMaterial({ color: 0x0d0b14, roughness: 0.45, metalness: 0.35 }));

  const level: Level = {
    id: "den",
    name: "The Neon Den",
    tagline: "Late-night game den",
    stations,
    fields,

    async build(c, progress) {
      ctx = c;
      const { scene, art, store, kit, engine } = c;
      await progress("Wiring the neon…");
      engine.post.bloomStrength.value = 0.4; // (gentle and tight: the glow hazed over the games and flared as lights came into view)
      engine.post.bloomRadius.value = 0.22;
      engine.post.vignette.value = 0.45;
      engine.post.exposure.value = 1.05;
      scene.background = new THREE.Color(0x030208);
      scene.fog = new THREE.FogExp2(0x0b0716, 0.035);
      scene.environment = neonEnvironment(engine.renderer, [
        { color: "#ff3d9a", pos: [-3, 2.8, -4], size: [4, 0.2, 0.2], intensity: 4 },
        { color: "#4fd8ff", pos: [4, 2.8, 0], size: [0.2, 0.2, 6], intensity: 4 },
        { color: "#a35cff", pos: [0, 4.4, 0], size: [3, 0.1, 3], intensity: 2 },
        { color: "#3dffa8", pos: [-4.5, 1.5, 0], size: [0.1, 1, 3], intensity: 1.5 },
        { color: "#ffb36b", pos: [0, 1.2, 4.6], size: [3, 1.6, 0.1], intensity: 1.2 },
      ]);
      scene.environmentIntensity = 0.55;

      buildRoom(scene);
      buildLights(scene);
      c.audio.setRoom({ seconds: 0.9, decay: 3.5, wet: 0.22 });
      // (no ambient loops in the den: rain, hums and fans all read as static. Music + SFX only.)

      // ---------------- data partitions ----------------
      const owned = store.games.filter((g) => g.status !== "wishlist");
      const kOf = (g: Game) => kindOf(g, art);
      const plat = (g: Game) => platformOf(g.platform);
      const byLaunch = (a: Game, b: Game) => plat(a).released.localeCompare(plat(b).released) || byTitle(a, b);
      const consoles = owned.filter((g) => !CART_KINDS.has(kOf(g)) && kOf(g) !== "cabinet" && plat(g).family !== "pc").sort(byLaunch);
      const pc = owned.filter((g) => plat(g).family === "pc").sort((a, b) => (kOf(a) === kOf(b) ? byTitle(a, b) : kOf(a) === "bigbox" ? -1 : 1));
      const carts = owned.filter((g) => CART_KINDS.has(kOf(g))).sort(byLaunch);
      const arcade = owned.filter((g) => kOf(g) === "cabinet").sort(byTitle);
      const wishlist = store.games.filter((g) => g.status === "wishlist").sort((a, b) => (a.score ?? 999) - (b.score ?? 999) || (a.priority ?? 9) - (b.priority ?? 9));

      // ---------------- back wall: console library ----------------
      await progress("Shelving the console library…");
      const consoleMode = (g: Game, i: number, sec: Game[]): Mode => (g.grade === "A+" ? "face" : sec.length >= 12 && i >= sec.length - 3 ? "stack" : "spine");
      const caseRows = [0.24, 0.24, 0.24, 0.24, 0.24, 0.24, 0.24];
      const caseW = 1.15;
      const need = runLength(consoles, art, (g) => (g.grade === "A+" ? "face" : "spine"));
      const perCase = caseRows.length * (caseW - 0.05) * 0.72;
      const nConsole = Math.max(1, Math.min(5, Math.ceil(need / perCase)));
      const consoleSpan = nConsole * caseW;
      const consoleCenterX = X1 - 0.35 - consoleSpan / 2;
      const consoleShelves: Shelf[] = [];
      const consoleCases: ReturnType<typeof bookcase>[] = [];
      for (let i = 0; i < nConsole; i++) {
        const x = consoleCenterX - consoleSpan / 2 + caseW * (i + 0.5);
        const bc = bookcase({ center: new THREE.Vector3(x, 0, Z0 + 0.3), normal: new THREE.Vector3(0, 0, 1), width: caseW, rows: caseRows, led: ["#ff3d9a", "#a35cff", "#4fd8ff", "#ff7a1a", "#3dffa8"][i % 5] });
        scene.add(bc.group);
        consoleShelves.push(...bc.shelves);
        consoleCases.push(bc);
      }
      const consolePack = packShelves(consoles, consoleShelves, art, { mode: consoleMode, sectionGap: 0.06, newShelfBelow: 0.22 });
      consoleField = addField(consolePack.placements, "consoles");
      decorateSections(consolePack.sections, consoleShelves, "consoles");
      console.info(`[den] consoles: ${consoles.length} games, ${nConsole} bookcases, fill ${(consolePack.fill * 100).toFixed(0)}%, overflow ${consolePack.overflow.length}`);
      // smart panels on top of each bookcase
      consoleCases.forEach((bc, i) => {
        const shelvesOfCase = new Set(bc.shelves);
        const secs = consolePack.sections.filter((s) => shelvesOfCase.has(consoleShelves[s.shelf]));
        const plats = [...new Set(secs.map((s) => s.key))];
        addSmartPanel(bc, plats, new THREE.Vector3(0, 0, 1), ["#ff3d9a", "#a35cff", "#4fd8ff", "#ff7a1a", "#3dffa8"][i % 5]);
      });

      // ticker over the console wall
      const s = store.stats;
      const ticker = new DotMatrix({ width: Math.max(2.6, consoleSpan), height: 0.16, rows: 16, color: "#ffb000", off: "#1c1206", speed: 18 });
      ticker.setText(
        [
          `${s.total} GAMES`,
          `${s.completed} BEATEN (${Math.round(s.pct * 100)}%)`,
          `${s.playing} IN PROGRESS`,
          `${s.backlogHours.toLocaleString()} HOURS OF BACKLOG (${Math.round(s.backlogHours / 24)} DAYS NONSTOP)`,
          s.clearYear ? `AT THIS PACE THE BACKLOG CLEARS IN ${s.clearYear}` : "",
          `${s.grades["A+"]} GAMES EARNED AN A+`,
          s.topDeveloper ? `MOST PROLIFIC DEV: ${s.topDeveloper.name.toUpperCase()} (${s.topDeveloper.count})` : "",
          `${s.physicalOwned} PHYSICAL COPIES WORTH $${s.valueOwned.toLocaleString()}`,
          s.recentlyCompleted[0] ? `LAST BEATEN: ${s.recentlyCompleted[0].title.toUpperCase()} (${s.recentlyCompleted[0].grade ?? "-"})` : "",
          `${s.wishlist} ON THE WISHLIST`,
        ]
          .filter(Boolean)
          .join("   ★   ") + "   ★   ",
      );
      ticker.mesh.position.set(consoleCenterX, 2.62, Z0 + 0.04);
      scene.add(ticker.mesh);
      // the dot-matrix board's housing, screwed to the wall (the display face sits just in front of it)
      const tickerW = Math.max(2.6, consoleSpan);
      const tickerBox = new THREE.Mesh(boxes([[consoleCenterX, 2.62, Z0 + 0.0195, tickerW + 0.04, 0.2, 0.039]]), housingMaterial());
      scene.add(tickerBox);
      tickers.push((dt) => ticker.update(dt));

      // ---------------- back-left: TV nook ----------------
      await progress("Warming up the CRT…");
      const tvSet = crtTv(art, 0.62);
      const nookX = Math.min(-2.4, consoleCenterX - consoleSpan / 2 - 0.9);
      tvSet.group.position.set(nookX, 0, Z0 + 0.42);
      scene.add(tvSet.group);
      tv = tvSet.screen;
      const playing = owned.filter((g) => g.status === "playing");
      tv.setPlaylist(playing.length ? playing : owned, { titleScreens: true });
      tickers.push((dt) => tv.update(dt));
      c.pickable(tvSet.group, () => {
        tv.burst(0.5);
        (tv as any).timer = tv.interval; // next channel
        c.audio.play("channel", { at: tvSet.group.position.clone().setY(0.8) });
        c.toast("📺 Channel up");
      });
      const press = neonSign("PRESS START", { font: `"Tilt Neon", "Monoton", sans-serif`, height: 0.22, color: "#4fd8ff", flicker: 0.02 });
      press.position.set(nookX, 1.95, Z0 + 0.02);
      scene.add(press);
      const den = neonSign("Game Den", { font: `"Monoton", sans-serif`, height: 0.42, color: "#ff3d9a", flicker: 0.006 });
      den.position.set(nookX, 2.45, Z0 + 0.02);
      scene.add(den);
      c.pickable(den, () => eggs.tapTable());

      // ---------------- left wall: PC ----------------
      await progress("Racking the PC wall…");
      const pcRows = [0.26, 0.26, 0.26, 0.26, 0.26, 0.26, 0.26];
      const pcW = 1.2;
      const pcNeed = runLength(pc, art, () => "spine");
      const nPc = Math.max(1, Math.min(4, Math.ceil(pcNeed / (pcRows.length * (pcW - 0.05) * 0.62))));
      const pcShelves: Shelf[] = [];
      const pcSpan = nPc * pcW;
      const pcCenterZ = Z0 + 0.35 + pcSpan / 2;
      const pcCases: ReturnType<typeof bookcase>[] = [];
      for (let i = 0; i < nPc; i++) {
        // viewer faces -x; their right is -z, so reading order runs towards -z
        const z = pcCenterZ + pcSpan / 2 - pcW * (i + 0.5);
        const bc = bookcase({ center: new THREE.Vector3(X0 + 0.3, 0, z), normal: new THREE.Vector3(1, 0, 0), width: pcW, rows: pcRows, led: "#3dffa8" });
        scene.add(bc.group);
        pcShelves.push(...bc.shelves);
        pcCases.push(bc);
      }
      const pcPack = packShelves(pc, pcShelves, art, { section: (g) => kOf(g), sectionGap: 0.08, newShelfBelow: 0.3, mode: (g) => (g.grade === "A+" ? "face" : "spine") });
      pcField = addField(pcPack.placements, "pc");
      decorateSections(pcPack.sections, pcShelves, "pc");
      pcCases.forEach((bc) => addSmartPanel(bc, ["Windows"], new THREE.Vector3(1, 0, 0), "#3dffa8"));
      console.info(`[den] pc: ${pc.length} games, ${nPc} bookcases, fill ${(pcPack.fill * 100).toFixed(0)}%, overflow ${pcPack.overflow.length}`);
      const pcSign = neonSign("PC MASTER ARCHIVE", { font: `"Tilt Neon", sans-serif`, height: 0.16, color: "#3dffa8" });
      pcSign.position.set(X0 + 0.02, 2.62, pcCenterZ);
      pcSign.rotation.y = Math.PI / 2;
      scene.add(pcSign);
      // battlestation desk with a CRT monitor
      const deskZ = Math.min(Z1 - 1.2, pcCenterZ + pcSpan / 2 + 0.9);
      const desk = new THREE.Mesh(
        boxes([
          [0, 0.74, 0, 0.7, 0.04, 1.3],
          [0, 0.37, -0.6, 0.6, 0.74, 0.04],
          [0, 0.37, 0.6, 0.6, 0.74, 0.04],
        ]),
        new THREE.MeshStandardNodeMaterial({ color: 0x14121c, roughness: 0.4 }),
      );
      desk.position.set(X0 + 0.38, 0, deskZ);
      scene.add(desk);
      // (front face at X0 + 0.56: the screen and the sticky notes in decor sit just in front of it)
      const mon = new THREE.Mesh(boxes([[0, 1.0, 0, 0.42, 0.38, 0.4]]), new THREE.MeshStandardNodeMaterial({ color: 0xd8d2c0, roughness: 0.6 }));
      mon.position.set(X0 + 0.35, 0, deskZ);
      scene.add(mon);
      const pcScreen = new CrtScreen(art, 0.31, 0.24, { curve: 0.16 });
      pcScreen.mesh.position.set(X0 + 0.35 + 0.21 + 0.0015, 1.0, deskZ);
      pcScreen.mesh.rotation.y = Math.PI / 2;
      scene.add(pcScreen.mesh);
      pcScreen.setPlaylist(pc.filter((g) => g.status !== "backlog").slice(0, 80));
      pcScreen.interval = 5;
      tickers.push((dt) => pcScreen.update(dt));
      c.pickable(mon, () => pcScreen.current && c.inspect(pcScreen.current));

      // ---------------- right wall: cartridge wall ----------------
      await progress("Hanging the cartridge wall…");
      const cartRowH = 0.17;
      const cartW = 3.4;
      const cartCenterZ = -0.4;
      const cartRows = 6;
      const cartBase = 0.62;
      const cartShelves: Shelf[] = [];
      const cn = new THREE.Vector3(-1, 0, 0);
      const cdir = UP.clone().cross(cn); // viewer's right
      for (let r = cartRows - 1; r >= 0; r--) {
        const y = cartBase + r * cartRowH;
        const origin = new THREE.Vector3(X1 - 0.2, y, cartCenterZ).addScaledVector(cdir, -cartW / 2);
        cartShelves.push({ origin, dir: cdir.clone(), normal: cn.clone(), width: cartW, depth: 0.1, height: cartRowH - 0.02 });
      }
      const cartPack = packShelves(carts, cartShelves, art, { mode: () => "face", gap: 0.006, sectionGap: 0.07, newShelfBelow: 0.12, inset: 0.004, lean: 0.06 });
      // arcade minis on a shelf on top
      const topShelf: Shelf = { origin: new THREE.Vector3(X1 - 0.26, cartBase + cartRows * cartRowH + 0.04, cartCenterZ).addScaledVector(cdir, -cartW / 2), dir: cdir.clone(), normal: cn.clone(), width: cartW, depth: 0.16, height: 0.3 };
      const arcadePack = packShelves(arcade, [topShelf], art, { mode: () => "face", gap: 0.03, lean: 0 });
      cartField = addField([...cartPack.placements, ...arcadePack.placements], "carts");
      decorateSections(cartPack.sections, cartShelves, "carts");
      const labelMesh = labels.build();
      if (labelMesh) scene.add(labelMesh);
      console.info(`[den] carts: ${carts.length} carts, fill ${(cartPack.fill * 100).toFixed(0)}%, overflow ${cartPack.overflow.length}`);
      // backboard + acrylic ledges
      const cartBack = new THREE.Mesh(new THREE.PlaneGeometry(cartW + 0.3, cartRows * cartRowH + 0.6), pegboardMaterial());
      cartBack.position.set(X1 - 0.05, cartBase + (cartRows * cartRowH) / 2 + 0.12, cartCenterZ);
      cartBack.rotation.y = -Math.PI / 2;
      scene.add(cartBack);
      const ledgeParts: [number, number, number, number, number, number][] = [];
      for (let r = 0; r < cartRows; r++) ledgeParts.push([X1 - 0.13, cartBase + r * cartRowH - 0.006, cartCenterZ, 0.14, 0.012, cartW]);
      ledgeParts.push([X1 - 0.155, topShelf.origin.y - 0.008, cartCenterZ, 0.21, 0.016, cartW]);
      scene.add(new THREE.Mesh(boxes(ledgeParts), new THREE.MeshStandardNodeMaterial({ color: 0x9fb8ff, roughness: 0.08, metalness: 0.0, transparent: true, opacity: 0.35 })));
      const ledgeLed = new THREE.Mesh(boxes(ledgeParts.map(([x, y, z, w, , d]) => [x - w / 2 + 0.004, y - 0.008, z, 0.004, 0.004, d] as [number, number, number, number, number, number])), neonMaterial("#a35cff", 3));
      scene.add(ledgeLed);
      const cartSign = neonSign("CARTRIDGE VAULT", { font: `"Tilt Neon", sans-serif`, height: 0.16, color: "#a35cff" });
      cartSign.position.set(X1 - 0.02, 2.72, cartCenterZ);
      cartSign.rotation.y = -Math.PI / 2;
      scene.add(cartSign);

      // ---------------- front wall: arcade alcove, window, vending alcove ----------------
      await progress("Plugging in the arcade…");
      const arcadePicks = pickArcadeHeadliners(arcade);
      arcadePicks.forEach((g, i) => {
        const cab = arcadeCabinet(art, { color: ["#1d1340", "#401326", "#132a40"][i % 3], neon: ["#ffd23f", "#ff3d9a", "#4fd8ff"][i % 3], title: g.title });
        cab.group.position.set(-3.45 + i * 0.74, 0, Z1 - 0.45);
        cab.group.rotation.y = Math.PI;
        scene.add(cab.group);
        cab.screen.setPlaylist([g], { titleScreens: true });
        cab.screen.interval = 4 + i;
        tickers.push((dt) => cab.screen.update(dt));
        c.pickable(cab.group, () => {
          c.toast("🪙 INSERT COIN");
          c.audio.play("coin", { at: cab.group.position.clone().setY(1.0) });
          cab.screen.burst(0.6);
          setTimeout(() => c.inspect(g), 500);
        });
      });
      const arcSign = neonSign("ARCADE", { font: `"Monoton", sans-serif`, height: 0.24, color: "#ffd23f", flicker: 0.015 });
      arcSign.position.set(-2.72, 2.55, Z1 - 0.02);
      arcSign.rotation.y = Math.PI;
      scene.add(arcSign);

      await progress("Stocking the Want-O-Matic…");
      vending = new VendingMachine(kit, wishlist, scene);
      vending.group.position.set(2.75, 0, Z1 - 0.5);
      vending.group.rotation.y = Math.PI;
      scene.add(vending.group);
      const vendAt = new THREE.Vector3(2.75, 1.2, Z1 - 0.5);
      // a little safe on the floor beside the vending machine (the way into the vault)
      const safe = miniSafe();
      // (in front of the corner plant, clear of the machine's side and its front)
      safe.position.set(3.55, 0, Z1 - 0.64);
      safe.rotation.y = Math.PI - 0.35;
      scene.add(safe);
      c.pickable(safe, () => c.openVault());
      const vendSfx = () => {
        c.audio.play("coin", { at: vendAt, volume: 0.6 });
        c.audio.play("vend", { at: vendAt, delay: 0.15 });
      };
      c.pickable(vending.buttons.next, () => {
        vendSfx();
        vending.setPage(vending.page + 1);
      });
      c.pickable(vending.buttons.prev, () => {
        vendSfx();
        vending.setPage(vending.page - 1);
      });
      tickers.push((dt) => vending.update(dt));

      // the window + the world outside
      await progress("Opening the window…");
      const outside = buildOutside(new THREE.Vector3(0, 1.5, Z1), new THREE.Vector3(0, 0, -1), 2.8, 1.4);
      outside.group.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) (m as any).fog = false;
      });
      scene.add(outside.group);
      const rainAt = new THREE.Vector3(0, 1.5, Z1 - 0.2);
      const boards = [billboard(3.2, 4.4), billboard(2.6, 3.6)];
      boards[0].mesh.position.set(-4.5, 4.2, Z1 + 21);
      boards[1].mesh.position.set(6.5, 2.4, Z1 + 12);
      for (const b of boards) {
        b.mesh.rotation.y = Math.PI;
        (b.mesh.material as any).fog = false;
        scene.add(b.mesh);
      }
      const rotateBoards = async () => {
        for (const b of boards) {
          const g = playing[Math.floor(Math.random() * playing.length)];
          if (!g) continue;
          const t = await art.hiRes(g);
          if (t) b.tex.value = t;
        }
      };
      rotateBoards();
      let boardT = 0;
      tickers.push((dt) => {
        boardT += dt;
        if (boardT > 18) {
          boardT = 0;
          rotateBoards();
        }
      });
      const windowGlass = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.4), new THREE.MeshStandardNodeMaterial({ color: 0x0a1020, roughness: 0.03, transparent: true, opacity: 0.08, depthWrite: false }));
      windowGlass.position.set(0, 1.5, Z1 - 0.01);
      windowGlass.rotation.y = Math.PI;
      scene.add(windowGlass);
      c.pickable(windowGlass, () => {
        eggs.cycleWindow();
        c.audio.play("zap", { at: rainAt });
      });

      // NOW PLAYING split-flap board above the window
      // sized to fit between the window frame's head (y 2.23) and the ceiling cove strip (y 2.95), with
      // a housing behind it on the wall
      const flap = new SplitFlap(26, 6, 1.99);
      flap.mesh.position.set(0, 2.59, Z1 - 0.03);
      flap.mesh.rotation.y = Math.PI;
      scene.add(flap.mesh);
      const flapH = (1.99 * 6 * 60) / (26 * 40);
      scene.add(new THREE.Mesh(boxes([[0, 2.59, Z1 - 0.0145, 1.99 + 0.016, flapH + 0.012, 0.029]]), housingMaterial()));
      let flapPage = 0, flapT = 99;
      const playList = playing.slice();
      tickers.push((dt) => {
        flap.update(dt);
        flapT += dt;
        if (flapT > 7 && playList.length) {
          flapT = 0;
          c.audio.play("flap", { at: flap.mesh.position, volume: 0.7 });
          flap.setRow(0, `NOW PLAYING ${String(flapPage * 5 + 1).padStart(3)}-${Math.min(playList.length, flapPage * 5 + 5)} OF ${playList.length}`, "#ffb000");
          for (let r = 0; r < 5; r++) {
            const g = playList[flapPage * 5 + r];
            if (!g) {
              flap.setRow(r + 1, "");
              continue;
            }
            const p = platformOf(g.platform).short;
            const title = g.title.toUpperCase().slice(0, 25 - p.length - 1);
            flap.setRow(r + 1, title.padEnd(25 - p.length) + p, r % 2 ? "#f2f2f2" : "#dfe6ff");
          }
          flapPage = (flapPage + 1) % Math.ceil(playList.length / 5);
        }
      });

      // ---------------- centre: rug, couch, holo-table ----------------
      await progress("Calibrating the hologram…");
      scene.add(rugAt(0, 0.4, 3.4, 2.4));
      const sofa = couch();
      sofa.position.set(0, 0, 1.75);
      sofa.rotation.y = Math.PI;
      scene.add(sofa);
      const table = roundTable(0.5, 0.42);
      table.position.set(0, 0, 0.2);
      scene.add(table);
      holo = new Hologram(art, { size: 0.62, res: engine.quality.mobile ? 44 : 60 });
      holo.group.position.set(0, 0.46, 0.2);
      scene.add(holo.group);
      const hallOfFame = owned.filter((g) => g.grade === "A+");
      let fameIdx = 0, fameT = 0;
      holo.show(hallOfFame[0] ?? null);
      tickers.push((dt) => {
        holo.update(dt);
        // the hologram always turns to face the viewer
        const cam = c.camera.position;
        const want = Math.atan2(cam.x - holo.group.position.x, cam.z - holo.group.position.z);
        let d = want - holo.group.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        holo.group.rotation.y += d * Math.min(1, dt * 3);
        if (store.selected) return;
        fameT += dt;
        if (fameT > 9 && hallOfFame.length) {
          fameT = 0;
          fameIdx = (fameIdx + 1) % hallOfFame.length;
          holo.show(hallOfFame[fameIdx]);
        }
      });
      c.pickable(table, () => holo.game && c.inspect(holo.game));
      c.pickable(holo.group, () => holo.game && c.inspect(holo.game));

      // ---------------- posters: the latest favourites ----------------
      const faves = owned.filter((g) => g.grade === "A+" || g.grade === "A").filter((g) => g.completedOn && art.entry(g)?.c).sort((a, b) => b.completedOn!.localeCompare(a.completedOn!));
      const spots: { pos: THREE.Vector3; rotY: number; h: number }[] = [
        { pos: new THREE.Vector3(X0 + 0.02, 1.75, deskZ), rotY: Math.PI / 2, h: 0.72 },
        { pos: new THREE.Vector3(X1 - 0.02, 1.55, 1.9), rotY: -Math.PI / 2, h: 0.78 },
        { pos: new THREE.Vector3(X1 - 0.02, 1.55, -2.55), rotY: -Math.PI / 2, h: 0.62 },
        { pos: new THREE.Vector3(nookX, 1.42, Z0 + 0.02), rotY: 0, h: 0.0 },
      ];
      spots.forEach((sp, i) => {
        const g = faves[i];
        if (!g || sp.h <= 0) return;
        const p = poster(art, g, sp.h);
        p.position.copy(sp.pos);
        p.rotation.y = sp.rotY;
        scene.add(p);
        c.pickable(p, () => c.inspect(g));
      });

      // ---------------- the lived-in layer: props, furniture, clutter (one merged mesh) ----------------
      await decorateDen(c, { X0, X1, Z0, Z1, CEIL, nookX, consoleX0: consoleCenterX - consoleSpan / 2, pcZ0: pcCenterZ - pcSpan / 2, pcZ1: pcCenterZ + pcSpan / 2, deskZ, cartZ0: cartCenterZ - cartW / 2, cartZ1: cartCenterZ + cartW / 2, cartBase, arcadeXs: arcadePicks.map((_, i) => -3.45 + i * 0.74), vendingX: 2.75, couchZ: 1.75, tableZ: 0.2, tickerX0: consoleCenterX - Math.max(2.6, consoleSpan) / 2 - 0.02 }, () => progress("Making a mess…"));

      // ---------------- camera rail + stations ----------------
      rail = wallRail(
        [
          [X1 - INSET, Z0 + INSET],
          [X0 + INSET, Z0 + INSET],
          [X0 + INSET, Z1 - INSET],
          [X1 - INSET, Z1 - INSET],
        ],
        { closed: true, h: [0.3, 2.65], d: [0.36, 4.4], h0: 1.25, d0: 1.6, lift: 0.18, round: 0.9 },
      );
      const sAt = (x: number, z: number) => rail.project(new THREE.Vector3(x, 0, z));
      const consoleS = sAt(consoleCenterX, Z0);
      c.rig.setRail(rail, { s: consoleS, h: 1.3, d: 3.2 });
      const go = (s: number, h: number, d: number) => () => c.rig.goTo({ s, h, d });
      stations.push(
        { id: "consoles", label: "Consoles", go: go(consoleS, 1.25, 1.9) },
        { id: "pc", label: "PC", go: go(sAt(X0, pcCenterZ), 1.2, 1.8) },
        { id: "carts", label: "Carts", go: go(sAt(X1, cartCenterZ), 1.15, 1.7) },
        { id: "arcade", label: "Arcade", go: go(sAt(-2.7, Z1), 1.35, 1.9) },
        { id: "wishlist", label: "Wishlist", go: go(sAt(2.75, Z1), 1.15, 1.95) },
        { id: "playing", label: "Now Playing", go: go(sAt(0, Z1), 2.1, 2.9) },
        {
          id: "holo",
          label: "Holo Table",
          go: () => c.rig.goFree(new THREE.Vector3(0.35, 1.3, -1.25), new THREE.Vector3(0, 0.8, 0.2)),
        },
        { id: "tv", label: "TV", go: go(sAt(nookX, Z0), 1.0, 1.75) },
        { id: "overview", label: "Overview", go: go(consoleS, 1.5, 4.4) },
      );

      eggs = new DenEggs(c, { holo, tv, outside, flashTarget: c.engine.post, catPath: { y: consoleCases[0]?.top ?? 2.4, z: Z0 + 0.15, x0: consoleCenterX - consoleSpan / 2, x1: consoleCenterX + consoleSpan / 2 } });
      tickers.push((dt, t) => eggs.update(dt, t));
    },

    update(dt, t) {
      for (const fn of tickers) fn(dt, t);
    },

    focusGame(g) {
      if (g.status === "wishlist") {
        const p = vending.pageOf(g);
        if (p >= 0 && p !== vending.page) vending.setPage(p);
        stations.find((s) => s.id === "wishlist")?.go();
        return;
      }
      for (const f of fields) {
        const p = f.centerOf(g.id);
        if (p) {
          ctx.rig.goTo({ s: rail.project(p), h: p.y, d: 0.75 }, 1.1);
          return;
        }
      }
    },

    onSelect(g) {
      if (g) {
        holo.show(g);
        ctx.audio.play("materialize", { at: holo.group.position, delay: 0.35, volume: 0.6 });
        if (g.status !== "wishlist") tv.show(g);
      }
    },

    onKey(e) {
      return eggs.key(e);
    },

    dispose() {
      for (const f of fields) f.dispose();
      vending?.field?.dispose();
      eggs?.dispose();
    },
  };

  // The wishlist field changes per vending page; expose it through a live proxy in `fields`.
  Object.defineProperty(level, "fields", {
    get: () => {
      const list = fields.filter((f) => f instanceof MediaField);
      if (vending?.field) list.push(vending.field);
      return list;
    },
  });

  function addField(placements: Placement[], name: string) {
    const f = new MediaField(ctx.kit, placements, { name });
    ctx.scene.add(f.group);
    fields.push(f);
    // (no status glows: with 100+ games in progress the shelves were mostly glowing)
    return f;
  }

  /** Shelf-edge labels at the start of each platform section. */
  function decorateSections(sections: ReturnType<typeof packShelves>["sections"], shelves: Shelf[], _name: string) {
    const seen = new Set<string>();
    // where the last label on each shelf ends (distance along the shelf): a short section's label would
    // otherwise run over the next one's (two coplanar plates, the text on top of each other)
    const labelEnd = new Map<number, number>();
    const LW = 0.15;
    for (const sec of sections) {
      const sh = shelves[sec.shelf];
      const first = !seen.has(sec.key);
      seen.add(sec.key);
      if (!first) continue;
      const along0 = sec.start.clone().sub(sh.origin).dot(sh.dir);
      const along = Math.max(0, Math.min(Math.max(along0, labelEnd.get(sec.shelf) ?? -1), sh.width - LW));
      labelEnd.set(sec.shelf, along + LW + 0.004);
      const p = platformOf(sec.key === "bigbox" || sec.key === "slab" ? "Windows" : sec.key);
      const total = sec.key === "bigbox" ? "BIG BOX" : sec.key === "slab" ? "DIGITAL" : p.short;
      const count = sections.filter((x) => x.key === sec.key).reduce((a, x) => a + x.games.length, 0);
      const at = sec.start.clone().addScaledVector(sh.dir, along - along0 + LW / 2).addScaledVector(UP, -0.012).addScaledVector(sh.normal, 0.003);
      labels.add(paintShelfLabel(`${total} · ${count}`, p.neon), at, faceOut(sh.normal));
    }
  }

  function addSmartPanel(bc: ReturnType<typeof bookcase>, plats: string[], normal: THREE.Vector3, accent: string) {
    const stats = ctx.store.stats.platforms;
    const lines: { text: string; color?: string; size?: number }[] = [];
    let best: (typeof stats)[number] | undefined;
    for (const id of plats.slice(0, 3)) {
      const ps = stats.find((x) => x.platform === id);
      if (!ps) continue;
      if (!best || ps.total > best.total) best = ps;
      lines.push({ text: `${platformOf(id).short.padEnd(9)} ${String(ps.completed).padStart(3)}/${ps.total}`, color: platformOf(id).neon, size: 0.17 });
    }
    if (plats.length > 3) lines.push({ text: `+${plats.length - 3} MORE`, color: "#888", size: 0.14 });
    const panel = ledPanel(lines, { width: 0.7, height: 0.24, accent, bar: best ? { value: best.pct, color: accent } : undefined });
    const g = bc.group;
    panel.position.copy(g.position).add(new THREE.Vector3(0, bc.top + 0.15, 0)).addScaledVector(normal, -0.1);
    panel.quaternion.copy(faceOut(normal));
    ctx.scene.add(panel);
    // the panel's housing stands on the bookcase top (the display face sits just in front of it)
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.29, 0.04), housingMaterial());
    box.position.copy(g.position).add(new THREE.Vector3(0, bc.top + 0.145, 0)).addScaledVector(normal, -0.1 - 0.0205);
    box.quaternion.copy(panel.quaternion);
    ctx.scene.add(box);
  }

  function buildRoom(scene: THREE.Scene) {
    const wallMat = new THREE.MeshStandardNodeMaterial({ color: 0x241b38, roughness: 0.92 });
    const floorMat = floorMaterial();
    const ceilMat = new THREE.MeshStandardNodeMaterial({ color: 0x0b0912, roughness: 0.9 });
    const W = X1 - X0, D = Z1 - Z0;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    // dust drifting through the neon light
    const motes = dust(ctx.engine.quality.mobile ? 110 : 240, 3.4, 0.2, CEIL - 0.2, "#ffb3e0");
    scene.add(motes);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = CEIL;
    scene.add(ceil);
    const t = 0.1;
    // back, left, right walls; front wall has a window + two alcoves
    scene.add(
      new THREE.Mesh(
        boxes([
          [0, CEIL / 2, Z0 - t / 2, W + 2 * t, CEIL, t],
          [X0 - t / 2, CEIL / 2, 0, t, CEIL, D],
          [X1 + t / 2, CEIL / 2, 0, t, CEIL, D],
          // front wall around the window (x -1.4..1.4, y 0.9..2.4)
          [-2.7, CEIL / 2, Z1 + t / 2, 2.6, CEIL, t],
          [2.7, CEIL / 2, Z1 + t / 2, 2.6, CEIL, t],
          [0, 0.4, Z1 + t / 2, 2.8, 0.8, t],
          [0, 2.6, Z1 + t / 2, 2.8, 0.8, t],
        ]),
        wallMat,
      ),
    );
    // window frame
    const frame = new THREE.Mesh(
      boxes([
        [0, 0.8, Z1 - 0.02, 2.9, 0.06, 0.14],
        [0, 2.2, Z1 - 0.02, 2.9, 0.06, 0.14],
        [-1.42, 1.5, Z1 - 0.02, 0.06, 1.46, 0.14],
        [1.42, 1.5, Z1 - 0.02, 0.06, 1.46, 0.14],
        [0, 1.5, Z1, 0.04, 1.4, 0.05],
        [0, 1.5, Z1, 2.8, 0.03, 0.05],
      ]),
      new THREE.MeshStandardNodeMaterial({ color: 0x0c0c10, roughness: 0.5, metalness: 0.4 }),
    );
    scene.add(frame);
    // neon cove lighting along the ceiling edges + skirting
    const cove = (color: string, parts: [number, number, number, number, number, number][]) => scene.add(new THREE.Mesh(boxes(parts), neonMaterial(color, 3.2)));
    cove("#ff3d9a", [[0, CEIL - 0.04, Z0 + 0.03, W, 0.02, 0.02]]);
    cove("#3dffa8", [[X0 + 0.03, CEIL - 0.04, 0, 0.02, 0.02, D]]);
    cove("#a35cff", [[X1 - 0.03, CEIL - 0.04, 0, 0.02, 0.02, D]]);
    cove("#4fd8ff", [[0, CEIL - 0.04, Z1 - 0.03, W, 0.02, 0.02]]);
    cove("#4fd8ff", [
      [0, 0.03, Z0 + 0.02, W, 0.012, 0.012],
      [X0 + 0.02, 0.03, 0, 0.012, 0.012, D],
      [X1 + -0.02, 0.03, 0, 0.012, 0.012, D],
    ]);
  }

  function buildLights(scene: THREE.Scene) {
    const mobile = ctx.engine.quality.mobile;
    scene.add(new THREE.HemisphereLight(0x4a3a7a, 0x120a18, 1.1));
    const pl = (color: string, x: number, y: number, z: number, i: number, dist: number) => {
      const l = new THREE.PointLight(color, i, dist, 1.6);
      l.position.set(x, y, z);
      scene.add(l);
      return l;
    };
    pl("#ff6ab8", 1.2, 2.6, -1.8, 7, 6.5); // console wall wash (pink)
    pl("#6fe0ff", 3.0, 2.4, -0.3, 5, 5.5); // cart wall (cyan)
    pl("#5dffb8", -3.0, 2.4, -0.6, 5, 5.5); // PC wall (green)
    pl("#ffbf80", 0, 2.2, 0.6, 4, 4.5); // warm over the couch/table
    if (!mobile) {
      pl("#b48cff", -2.6, 2.4, 2.2, 4, 4.5); // arcade (purple)
      pl("#ff9a5a", 2.6, 2.4, 2.2, 3, 4.5); // vending (orange)
      pl("#ff6ab8", -2.6, 2.6, -1.8, 4, 4.5); // back-left nook
    }
  }

  return level;
}

// ---------------------------------------------------------------------------------------------

function pickArcadeHeadliners(arcade: Game[]): Game[] {
  const pref = ["Gradius", "Salamander", "Haunted Castle"];
  const out: Game[] = [];
  for (const p of pref) {
    const g = arcade.find((x) => x.title === p);
    if (g) out.push(g);
  }
  for (const g of arcade) if (out.length < 3 && !out.includes(g)) out.push(g);
  return out.slice(0, 3);
}

/** A shelf-edge label's face, painted into the den's label sheet (256 x 40). */
const paintShelfLabel = (text: string, color: string) => (ctx: CanvasRenderingContext2D) => {
  ctx.fillStyle = "#07070b";
  ctx.fillRect(0, 0, 256, 40);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 5, 40);
  ctx.font = `22px "Silkscreen", monospace`;
  ctx.textBaseline = "middle";
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.fillText(text, 14, 21, 236);
};

function floorMaterial() {
  // dark polished floor with large tiles and a little grit; reflections come from the env map
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0.15 });
  const p = positionWorld.xz;
  const tile = fract(p.div(0.6));
  const seam = step(0.985, tile.x).max(step(0.985, tile.y)).max(step(tile.x, 0.015)).max(step(tile.y, 0.015));
  const grit = hash(floor(p.mul(240)).dot(vec2(1, 311)));
  const base = vec3(0.012, 0.01, 0.018).add(grit.mul(0.006));
  m.colorNode = mix(base, vec3(0.003), seam);
  m.roughnessNode = mix(float(0.18).add(grit.mul(0.1)), float(0.6), seam);
  m.userData.seam = seam;
  return m;
}

/** A small floor safe: steel body, gold trim, a dial and a three-spoke handle. */
function miniSafe() {
  const d = new DecorBuilder({ atlasSize: 256 });
  const dial = d.canvas(128, 128, (x, w, h) => {
    x.fillStyle = "#1a1a1d";
    x.beginPath();
    x.arc(w / 2, h / 2, w / 2 - 2, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = "#d9b45a";
    x.lineWidth = 2;
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2, r0 = i % 5 ? 0.4 : 0.34;
      x.beginPath();
      x.moveTo(w / 2 + Math.cos(a) * w * r0, h / 2 + Math.sin(a) * h * r0);
      x.lineTo(w / 2 + Math.cos(a) * w * 0.46, h / 2 + Math.sin(a) * h * 0.46);
      x.stroke();
    }
    x.fillStyle = "#d9b45a";
    x.beginPath();
    x.arc(w / 2, h / 2, w * 0.14, 0, Math.PI * 2);
    x.fill();
  });
  const S = 0.34;
  d.box([S, S * 1.05, S * 0.9], [0, S * 0.525 + 0.03, 0], "#22302a", { rough: 0.4, metal: 0.6 });
  d.box([S * 0.84, S * 0.88, 0.02], [0, S * 0.525 + 0.03, S * 0.45 + 0.004], "#2b3b34", { rough: 0.35, metal: 0.6 });
  d.box([S * 0.84, 0.012, 0.024], [0, S * 0.97 + 0.03, S * 0.45 + 0.006], "#c9a45c", { metal: 1, rough: 0.3 });
  d.box([S * 0.84, 0.012, 0.024], [0, 0.11, S * 0.45 + 0.006], "#c9a45c", { metal: 1, rough: 0.3 });
  d.cyl(0.055, 0.055, 0.018, [-0.04, S * 0.6, S * 0.45 + 0.018], "#ffffff", { tex: dial, rot: [Math.PI / 2, 0, 0], metal: 0.5, rough: 0.3, seg: 24 });
  d.cyl(0.012, 0.012, 0.03, [0.085, S * 0.5, S * 0.45 + 0.02], "#c9a45c", { rot: [Math.PI / 2, 0, 0], metal: 1, rough: 0.25 });
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.3;
    d.box([0.008, 0.06, 0.008], [0.085 + Math.cos(a) * 0.028, S * 0.5 + Math.sin(a) * 0.028, S * 0.45 + 0.034], "#c9a45c", { rot: [0, 0, a + Math.PI / 2], metal: 1, rough: 0.25 });
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) d.box([0.04, 0.03, 0.04], [sx * S * 0.4, 0.015, sz * S * 0.36], "#141414", { rough: 0.6 });
  // (essential: it's a door, not decoration; and it must stay clickable)
  const g = new THREE.Group();
  g.add(d.build("den-safe", { essential: true }));
  return g;
}

function pegboardMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
  const p = uv().mul(vec2(60, 22));
  const hole = step(length(fract(p).sub(0.5)), float(0.14));
  m.colorNode = mix(vec3(0.03, 0.025, 0.05), vec3(0.004), hole);
  return m;
}

function rugAt(x: number, z: number, w: number, d: number) {
  const r = rug(w, d);
  r.position.x = x;
  r.position.z = z;
  return r;
}

