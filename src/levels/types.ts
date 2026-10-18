// The contract every world ("level") implements. Levels own their scene content, rails,
// lighting and props; the app owns data, art, the camera rig, input, inspect + UI.

import type * as THREE from "three/webgpu";
import type { Game } from "../../shared/types";
import type { Engine } from "../engine/renderer";
import type { CameraRig } from "../engine/rig";
import type { LibraryStore } from "../library/store";
import type { ArtStore } from "../library/art";
import type { MediaField, MediaKit } from "../media/field";
import type { AudioEngine } from "../audio/audio";

export interface LevelCtx {
  engine: Engine;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  rig: CameraRig;
  store: LibraryStore;
  art: ArtStore;
  kit: MediaKit;
  /** Sound: one-shots (`audio.play`) and positional ambient loops (`audio.addEmitter`). */
  audio: AudioEngine;
  /** Register an object that reacts to taps (props, buttons, easter eggs). */
  pickable(obj: THREE.Object3D, onTap: (hit: THREE.Intersection) => void): void;
  /** Ask the app to inspect a game (as if it was tapped). */
  inspect(game: Game): void;
  /** Toast-style message in the HUD (easter eggs, announcements). */
  toast(text: string, ms?: number): void;
  /** the Archivist (Backlog Science) says something: in the open game's panel, else at the top */
  say(text: string): void;
  /** A level-scoped place to put per-frame tickers */
  onUpdate(fn: (dt: number, t: number) => void): void;
  /** Ask for the vault password (server-checked) and go to the vault if it's right. */
  openVault(): void;
}

export interface Station {
  id: string;
  label: string;
  go(): void;
}

export interface Level {
  id: string;
  name: string;
  tagline: string;
  /** Build into ctx.scene. `await progress(...)` between phases: it yields so frames keep flowing. */
  build(ctx: LevelCtx, progress: (msg: string) => Promise<void>): Promise<void>;
  /** Called each time the level becomes the one on screen (after the first build too). */
  enter?(): void;
  update(dt: number, t: number): void;
  stations: Station[];
  /** Fields with pickable games (also receive filter state). */
  fields: MediaField[];
  /** Move the camera so a game is in view (search results, prev/next). */
  focusGame(game: Game): void;
  /** Selection changed (hologram projectors etc. can react). */
  onSelect?(game: Game | null): void;
  /** Keyboard hook for easter eggs; return true if handled */
  onKey?(e: KeyboardEvent): boolean;
  /** Gesture hook (e.g. a close-up mode that uses drags itself); return true if handled. */
  onGesture?(g: Gesture): boolean;
  /** Extra lines for a game's info panel in this world (label, value), shown first. */
  facts?(game: Game): [string, string][];
  dispose(): void;
}

export type Gesture =
  | { type: "pan"; dx: number; dy: number }
  | { type: "panEnd" }
  | { type: "zoom"; factor: number }
  | { type: "scroll"; dx: number; dy: number };

export type LevelFactory = () => Level;
