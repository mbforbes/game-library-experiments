// Level registry. Each level is code-split and loaded on demand.

import type { LevelFactory } from "./types";

export interface LevelEntry {
  name: string;
  tagline: string;
  accent: string;
  hidden?: boolean;
  load: () => Promise<LevelFactory>;
}

export const LEVELS: Record<string, LevelEntry> = {
  den: {
    name: "The Neon Den",
    tagline: "Late-night game den: shelves by console, arcade corner, holo table, wishlist vending machine.",
    accent: "#ff3d9a",
    load: () => import("./den/den").then((m) => m.default),
  },
  stacks: {
    name: "The Infinite Stacks",
    tagline: "A stone tower where the library spirals up through time, 1971 at the bottom to today at the top.",
    accent: "#ffb36b",
    load: () => import("./stacks/stacks").then((m) => m.default),
  },
  lab: {
    name: "Backlog Science",
    tagline: "Clinical test chambers: the queue, the results wall, live portals, and an AI with opinions about your backlog.",
    accent: "#3aa0ff",
    load: () => import("./lab/lab").then((m) => m.default),
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
