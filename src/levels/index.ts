// Level registry. Each level is code-split and loaded on demand.

import type { LevelFactory } from "./types";

/** Background music (Creative Commons; credited in the controls card). */
export interface Track {
  url: string;
  title: string;
  artist: string;
  license: string;
  licenseUrl: string;
  link: string;
  /** where the track was found (credited as "via …"), if not straight from the artist */
  via?: { name: string; url: string };
  /** the game a fan remix arranges */
  game?: string;
  /** level adjustment (dB) so tracks sit at the same loudness (~ -20 LUFS) */
  gainDb?: number;
}

/**
 * An OverClocked ReMix (ocremix.org, fan arrangements): free for non-commercial use with the
 * remixer credited followed by "OverClocked ReMix" linked to ocremix.org, shown with the music,
 * and the MP3 served exactly as downloaded (name and tags unchanged).
 * https://ocremix.org/info/Content_Policy
 */
const ocr = (file: string, title: string, game: string, remixer: string, id: string, lufs: number): Track => ({
  url: `/audio/ocr/${encodeURIComponent(file)}`,
  title,
  game,
  artist: remixer,
  license: "OverClocked ReMix",
  licenseUrl: "https://ocremix.org",
  link: `https://ocremix.org/remix/${id}`,
  gainDb: -20 - lufs,
});

export interface LevelEntry {
  name: string;
  tagline: string;
  accent: string;
  hidden?: boolean;
  /** background tracks: one is picked at random on entering (or the one chosen in the sound menu) */
  music?: Track[];
  /** colour of the pulsing rim on recently added games */
  newColor?: string;
  load: () => Promise<LevelFactory>;
}

export const LEVELS: Record<string, LevelEntry> = {
  den: {
    name: "The Neon Den",
    tagline: "A cozy space to peruse.",
    accent: "#ff3d9a",
    newColor: "#ff4fd8",
    // lounge
    music: [
      ocr("OutRun_Passing_Breeze_(Lounge_Suite)_OC_ReMix.mp3", "Passing Breeze (Lounge Suite)", "OutRun", "Remorse", "OCR00875", -12.7),
      ocr("Animal_Crossing_Soothing_Rain_OC_ReMix.mp3", "Soothing Rain", "Animal Crossing", "Jamphibious", "OCR03440", -15.6),
      ocr("Wild_Arms_Adlehyde_Castle_Flow_OC_ReMix.mp3", "Adlehyde Castle Flow", "Wild Arms", "posu yan", "OCR00262", -16.5),
    ],
    load: () => import("./den/den").then((m) => m.default),
  },
  stacks: {
    name: "The Infinite Stacks",
    tagline: "A stone tower whose library spirals up through time.",
    accent: "#ffb36b",
    newColor: "#ffd36b",
    music: [
      { url: "/audio/music-stacks-v1.mp3", title: "Lands", artist: "Alex Productions", license: "CC BY 3.0", licenseUrl: "https://creativecommons.org/licenses/by/3.0/", link: "https://www.youtube.com/channel/UCx0_M61F81Nfb-BRXE-SeVA", via: { name: "BreakingCopyright", url: "https://breakingcopyright.com" } },
      ocr("Final_Fantasy_4_Hymn_to_the_Crystals_OC_ReMix.mp3", "Hymn to the Crystals", "Final Fantasy IV", "RebeccaETripp", "OCR03621", -15.0),
      ocr("Legend_of_Zelda_Ocarina_of_Time_Garden_of_Venus_OC_ReMix.mp3", "Garden of Venus", "Zelda: Ocarina of Time", "RebeccaETripp", "OCR03924", -16.5),
      ocr("Secret_of_Mana_Pure_Heart_OC_ReMix.mp3", "Pure Heart", "Secret of Mana", "Fredrik Häthén", "OCR03414", -12.9),
    ],
    load: () => import("./stacks/stacks").then((m) => m.default),
  },
  lab: {
    name: "Backlog Science",
    tagline: "Results analysis, statistics, and forecasts.",
    accent: "#3aa0ff",
    newColor: "#4dff9a",
    music: [
      { url: "/audio/music-lab-v1.mp3", title: "Fragments", artist: "AERØHEAD", license: "CC BY-NC 3.0", licenseUrl: "https://creativecommons.org/licenses/by-nc/3.0/", link: "https://www.youtube.com/channel/UCoZbM1a4PKQ6haa2Ap4TSdg", via: { name: "BreakingCopyright", url: "https://breakingcopyright.com" } },
      ocr("Chicory_Skipping_Stones_Down_Sips_River_OC_ReMix.mp3", "Skipping Stones Down Sips River", "Chicory: A Colorful Tale", "Emunator", "OCR04588", -13.6),
      ocr("Pokemon_Crystal_Version_Spacious_Beauty_OC_ReMix.mp3", "Spacious Beauty", "Pokémon Crystal", "timaeus222", "OCR04762", -12.8),
      ocr("Microsoft_Flight_Simulator_Above_the_Borders_OC_ReMix.mp3", "Above the Borders", "Flight Simulator / Pilotwings", "tibonev", "OCR04956", -13.3),
    ],
    load: () => import("./lab/lab").then((m) => m.default),
  },
  vault: {
    name: "The Vault",
    tagline: "What it's all worth.",
    accent: "#ffcc55",
    hidden: true,
    music: [{ url: "/audio/music-vault-v1.mp3", title: "Spy Glass", artist: "Kevin MacLeod", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", link: "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1500058" }],
    load: () => import("./vault/vault").then((m) => m.default),
  },
  showroom: {
    name: "Showroom",
    tagline: "Test bench: every form factor side by side.",
    accent: "#4fd8ff",
    hidden: true,
    load: () => import("./showroom").then((m) => m.default),
  },
};

export const DEFAULT_LEVEL = "den";
