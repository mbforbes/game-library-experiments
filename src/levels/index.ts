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
}

export interface LevelEntry {
  name: string;
  tagline: string;
  accent: string;
  hidden?: boolean;
  music?: Track;
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
    music: { url: "/audio/music-den-v1.mp3", title: "Path Of The Fireflies", artist: "AERØHEAD", license: "CC BY-NC 3.0", licenseUrl: "https://creativecommons.org/licenses/by-nc/3.0/", link: "https://www.youtube.com/channel/UCoZbM1a4PKQ6haa2Ap4TSdg", via: { name: "BreakingCopyright", url: "https://breakingcopyright.com" } },
    load: () => import("./den/den").then((m) => m.default),
  },
  stacks: {
    name: "The Infinite Stacks",
    tagline: "A stone tower whose library spirals up through time.",
    accent: "#ffb36b",
    newColor: "#ffd36b",
    music: { url: "/audio/music-stacks-v1.mp3", title: "Lands", artist: "Alex Productions", license: "CC BY 3.0", licenseUrl: "https://creativecommons.org/licenses/by/3.0/", link: "https://www.youtube.com/channel/UCx0_M61F81Nfb-BRXE-SeVA", via: { name: "BreakingCopyright", url: "https://breakingcopyright.com" } },
    load: () => import("./stacks/stacks").then((m) => m.default),
  },
  lab: {
    name: "Backlog Science",
    tagline: "Results analysis, statistics, and forecasts.",
    accent: "#3aa0ff",
    newColor: "#4dff9a",
    music: { url: "/audio/music-lab-v1.mp3", title: "Fragments", artist: "AERØHEAD", license: "CC BY-NC 3.0", licenseUrl: "https://creativecommons.org/licenses/by-nc/3.0/", link: "https://www.youtube.com/channel/UCoZbM1a4PKQ6haa2Ap4TSdg", via: { name: "BreakingCopyright", url: "https://breakingcopyright.com" } },
    load: () => import("./lab/lab").then((m) => m.default),
  },
  vault: {
    name: "The Vault",
    tagline: "What it's all worth.",
    accent: "#ffcc55",
    hidden: true,
    music: { url: "/audio/music-vault-v1.mp3", title: "Spy Glass", artist: "Kevin MacLeod", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", link: "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1500058" },
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
