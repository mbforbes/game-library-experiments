// Platform registry: how each console in the sheet looks, where its art lives, and
// which physical form factor its games are rendered as.

export type MediaKind =
  | "nes-cart"
  | "snes-cart"
  | "n64-cart"
  | "gb-cart"
  | "gba-cart"
  | "gg-cart"
  | "msx-cart"
  | "hucard"
  | "genesis-case"
  | "jewel"
  | "dvd"
  | "gc-case"
  | "bluray"
  | "switch-case"
  | "ds-case"
  | "bigbox"
  | "slab"
  | "cabinet";

export type Family = "nintendo" | "sega" | "sony" | "microsoft" | "pc" | "nec" | "arcade" | "msx";

export interface Platform {
  id: string; // as written in the sheet
  slug: string;
  name: string; // display name
  short: string; // compact label for spines/displays
  family: Family;
  released: string; // US launch (ISO); the sheet's Machinery tab overrides when present
  media: MediaKind;
  /** Plastic / cardboard shell colour */
  shell: string;
  /** Spine background + text colours, and the platform band colour at the top of the spine */
  spine: string;
  spineText: string;
  band: string;
  bandText: string;
  /** Signature neon colour used by levels for signage / accents */
  neon: string;
  /** libretro-thumbnails system folders, best first */
  libretro?: string[];
}

const P = (p: Omit<Platform, "slug">): Platform => ({ ...p, slug: slugify(p.id) });

export const PLATFORMS: Platform[] = [
  P({ id: "Arcade", name: "Arcade", short: "ARCADE", family: "arcade", released: "1971-10-15", media: "cabinet", shell: "#1a1a22", spine: "#111", spineText: "#ffd23f", band: "#ffd23f", bandText: "#111", neon: "#ffd23f", libretro: ["MAME", "FBNeo - Arcade Games"] }),
  P({ id: "MS-DOS", name: "MS-DOS", short: "DOS", family: "pc", released: "1981-08-12", media: "bigbox", shell: "#2b2b2b", spine: "#222", spineText: "#eee", band: "#3a3a3a", bandText: "#9f9", neon: "#39ff88", libretro: ["DOS"] }),
  P({ id: "NES", name: "Nintendo Entertainment System", short: "NES", family: "nintendo", released: "1985-10-18", media: "nes-cart", shell: "#a9a9a6", spine: "#1b1b1b", spineText: "#f2f2f2", band: "#d21f2b", bandText: "#fff", neon: "#ff2a3d", libretro: ["Nintendo - Nintendo Entertainment System"] }),
  P({ id: "MSX", name: "MSX", short: "MSX", family: "msx", released: "1983-10-21", media: "msx-cart", shell: "#26262b", spine: "#222", spineText: "#eee", band: "#e8e8e8", bandText: "#222", neon: "#ff8c2a", libretro: ["Microsoft - MSX2", "Microsoft - MSX"] }),
  P({ id: "Master System", name: "Sega Master System", short: "SMS", family: "sega", released: "1986-09-01", media: "genesis-case", shell: "#141414", spine: "#121212", spineText: "#fff", band: "#d8d8d8", bandText: "#c4161c", neon: "#2a7fff", libretro: ["Sega - Master System - Mark III"] }),
  P({ id: "Windows", name: "PC (Windows)", short: "PC", family: "pc", released: "1985-11-20", media: "slab", shell: "#0e1116", spine: "#0f1218", spineText: "#e8f1ff", band: "#1b2838", bandText: "#66c0f4", neon: "#38f2ff" }),
  P({ id: "TG-16", name: "TurboGrafx-16", short: "TG-16", family: "nec", released: "1989-08-29", media: "hucard", shell: "#e9e7e1", spine: "#1c1c1c", spineText: "#ffb300", band: "#f38b00", bandText: "#111", neon: "#ff9f1c", libretro: ["NEC - PC Engine - TurboGrafx 16", "NEC - PC Engine CD - TurboGrafx-CD"] }),
  P({ id: "Genesis", name: "Sega Genesis", short: "GENESIS", family: "sega", released: "1989-08-14", media: "genesis-case", shell: "#121212", spine: "#121212", spineText: "#f4f4f4", band: "#c4161c", bandText: "#fff", neon: "#2a7fff", libretro: ["Sega - Mega Drive - Genesis"] }),
  P({ id: "Gameboy", name: "Game Boy", short: "GAME BOY", family: "nintendo", released: "1989-07-31", media: "gb-cart", shell: "#9e9e9b", spine: "#d8d8d8", spineText: "#222", band: "#3b3b8f", bandText: "#fff", neon: "#9bff3a", libretro: ["Nintendo - Game Boy", "Nintendo - Game Boy Color"] }),
  P({ id: "Game Gear", name: "Sega Game Gear", short: "GAME GEAR", family: "sega", released: "1991-04-26", media: "gg-cart", shell: "#1b1b1b", spine: "#1b1b1b", spineText: "#fff", band: "#2050c8", bandText: "#fff", neon: "#2a7fff", libretro: ["Sega - Game Gear"] }),
  P({ id: "SNES", name: "Super Nintendo", short: "SNES", family: "nintendo", released: "1991-08-23", media: "snes-cart", shell: "#b4b4b8", spine: "#cfcfd4", spineText: "#2b2b2b", band: "#5b4b9b", bandText: "#fff", neon: "#a35cff", libretro: ["Nintendo - Super Nintendo Entertainment System"] }),
  P({ id: "Saturn", name: "Sega Saturn", short: "SATURN", family: "sega", released: "1995-05-11", media: "jewel", shell: "#111", spine: "#111", spineText: "#fff", band: "#2a2a2a", bandText: "#6fa8ff", neon: "#2a7fff", libretro: ["Sega - Saturn"] }),
  P({ id: "PS1", name: "PlayStation", short: "PS1", family: "sony", released: "1995-09-09", media: "jewel", shell: "#0d0d0d", spine: "#0d0d0d", spineText: "#f5f5f5", band: "#1b1b1b", bandText: "#e9e9e9", neon: "#3d7bff", libretro: ["Sony - PlayStation"] }),
  P({ id: "N64", name: "Nintendo 64", short: "N64", family: "nintendo", released: "1996-09-29", media: "n64-cart", shell: "#3f3f44", spine: "#2b2b2f", spineText: "#eee", band: "#1e7b3c", bandText: "#fff", neon: "#2bff88", libretro: ["Nintendo - Nintendo 64"] }),
  P({ id: "Dreamcast", name: "Sega Dreamcast", short: "DREAMCAST", family: "sega", released: "1999-09-09", media: "jewel", shell: "#f0f0f0", spine: "#f2f2f2", spineText: "#222", band: "#ff6a00", bandText: "#fff", neon: "#ff7a1a", libretro: ["Sega - Dreamcast"] }),
  P({ id: "PS2", name: "PlayStation 2", short: "PS2", family: "sony", released: "2000-10-26", media: "dvd", shell: "#0e0e10", spine: "#0e0e10", spineText: "#f1f1f1", band: "#0e0e10", bandText: "#6aa2ff", neon: "#3d7bff", libretro: ["Sony - PlayStation 2"] }),
  P({ id: "GBA", name: "Game Boy Advance", short: "GBA", family: "nintendo", released: "2001-06-11", media: "gba-cart", shell: "#43405a", spine: "#2a2a35", spineText: "#eee", band: "#5c4bb5", bandText: "#fff", neon: "#a35cff", libretro: ["Nintendo - Game Boy Advance"] }),
  P({ id: "GC", name: "GameCube", short: "GAMECUBE", family: "nintendo", released: "2001-11-18", media: "gc-case", shell: "#111", spine: "#141414", spineText: "#f1f1f1", band: "#5a4fcf", bandText: "#fff", neon: "#7b6cff", libretro: ["Nintendo - GameCube"] }),
  P({ id: "XBOX", name: "Xbox", short: "XBOX", family: "microsoft", released: "2001-11-15", media: "dvd", shell: "#101010", spine: "#101010", spineText: "#eee", band: "#107c10", bandText: "#fff", neon: "#3cff4c", libretro: ["Microsoft - Xbox"] }),
  P({ id: "DS", name: "Nintendo DS", short: "DS", family: "nintendo", released: "2004-11-21", media: "ds-case", shell: "#d6d6d6", spine: "#ececec", spineText: "#222", band: "#8a8a8a", bandText: "#fff", neon: "#ff2a3d", libretro: ["Nintendo - Nintendo DS"] }),
  P({ id: "XBOX 360", name: "Xbox 360", short: "XBOX 360", family: "microsoft", released: "2005-11-22", media: "dvd", shell: "#5dc21e", spine: "#5dc21e", spineText: "#fff", band: "#f2f2f2", bandText: "#3c8a12", neon: "#3cff4c", libretro: ["Microsoft - Xbox 360"] }),
  P({ id: "PS3", name: "PlayStation 3", short: "PS3", family: "sony", released: "2006-11-17", media: "bluray", shell: "#20242a", spine: "#1a1d22", spineText: "#f1f1f1", band: "#000", bandText: "#fff", neon: "#3d7bff", libretro: ["Sony - PlayStation 3"] }),
  P({ id: "Wii", name: "Wii", short: "Wii", family: "nintendo", released: "2006-11-19", media: "dvd", shell: "#f4f4f4", spine: "#f6f6f6", spineText: "#222", band: "#cfcfcf", bandText: "#444", neon: "#6fe7ff", libretro: ["Nintendo - Wii"] }),
  P({ id: "Wii U", name: "Wii U", short: "Wii U", family: "nintendo", released: "2012-11-18", media: "dvd", shell: "#1a8fd6", spine: "#1a8fd6", spineText: "#fff", band: "#fff", bandText: "#1a8fd6", neon: "#2ab8ff", libretro: ["Nintendo - Wii U"] }),
  P({ id: "PS4", name: "PlayStation 4", short: "PS4", family: "sony", released: "2013-11-15", media: "bluray", shell: "#0b3d91", spine: "#0b3d91", spineText: "#fff", band: "#0b3d91", bandText: "#fff", neon: "#3d7bff", libretro: ["Sony - PlayStation 4"] }),
  P({ id: "XBONE", name: "Xbox One", short: "XBOX ONE", family: "microsoft", released: "2013-11-22", media: "bluray", shell: "#107c10", spine: "#107c10", spineText: "#fff", band: "#0d5f0d", bandText: "#fff", neon: "#3cff4c" }),
  P({ id: "Switch", name: "Nintendo Switch", short: "SWITCH", family: "nintendo", released: "2017-03-03", media: "switch-case", shell: "#e60012", spine: "#e60012", spineText: "#fff", band: "#fff", bandText: "#e60012", neon: "#ff2a3d" }),
  P({ id: "XBSeries", name: "Xbox Series X|S", short: "XBOX SERIES", family: "microsoft", released: "2020-11-10", media: "bluray", shell: "#107c10", spine: "#0e0e0e", spineText: "#fff", band: "#107c10", bandText: "#fff", neon: "#3cff4c" }),
  P({ id: "PS5", name: "PlayStation 5", short: "PS5", family: "sony", released: "2020-11-12", media: "bluray", shell: "#1f5fd1", spine: "#1f5fd1", spineText: "#fff", band: "#f4f4f4", bandText: "#111", neon: "#4f8bff" }),
  P({ id: "Switch 2", name: "Nintendo Switch 2", short: "SWITCH 2", family: "nintendo", released: "2025-06-05", media: "switch-case", shell: "#e60012", spine: "#d9000f", spineText: "#fff", band: "#1a1a1a", bandText: "#fff", neon: "#ff3d6e" }),
];

const BY_ID = new Map<string, Platform>();
for (const p of PLATFORMS) {
  BY_ID.set(p.id.toLowerCase(), p);
  BY_ID.set(p.slug, p);
}
// Common aliases people type into spreadsheets
const ALIASES: Record<string, string> = {
  "game boy": "Gameboy",
  gb: "Gameboy",
  gbc: "Gameboy",
  "game boy color": "Gameboy",
  "game boy advance": "GBA",
  gamecube: "GC",
  ps: "PS1",
  psx: "PS1",
  playstation: "PS1",
  "mega drive": "Genesis",
  "sega genesis": "Genesis",
  "super nintendo": "SNES",
  "nintendo switch": "Switch",
  "nintendo switch 2": "Switch 2",
  pc: "Windows",
  dos: "MS-DOS",
  "xbox one": "XBONE",
  "xbox series x": "XBSeries",
  "xbox series": "XBSeries",
  turbografx: "TG-16",
  "turbografx-16": "TG-16",
  "pc engine": "TG-16",
  sms: "Master System",
  gg: "Game Gear",
};

const unknownCache = new Map<string, Platform>();

/** Look up a platform by sheet name; unknown platforms get a neutral generic entry. */
export function platformOf(id: string): Platform {
  const key = id.trim().toLowerCase();
  const hit = BY_ID.get(key) ?? BY_ID.get(ALIASES[key]?.toLowerCase() ?? "") ?? BY_ID.get(slugify(id));
  if (hit) return hit;
  let p = unknownCache.get(key);
  if (!p) {
    p = P({ id: id.trim() || "Unknown", name: id.trim() || "Unknown", short: (id.trim() || "?").toUpperCase(), family: "pc", released: "2000-01-01", media: "dvd", shell: "#333", spine: "#2a2a2a", spineText: "#eee", band: "#555", bandText: "#fff", neon: "#ffffff" });
    unknownCache.set(key, p);
  }
  return p;
}

/** Old PC games came in big boxes; modern ones are digital (rendered as glowing glass slabs). */
export function mediaFor(platform: Platform, year?: number): MediaKind {
  if (platform.id === "Windows") return year !== undefined && year < 2004 ? "bigbox" : "slab";
  return platform.media;
}

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
