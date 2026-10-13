// Core data model shared by the Worker, the client, and build scripts.

export type Status = "backlog" | "playing" | "completed" | "wishlist";

export interface Game {
  /** Unique id within the library, e.g. "g:ps5/signalis" or "w:snes/earthbound". */
  id: string;
  /** Art key: platform + title slug. Shared across tabs so the same game reuses its art. */
  artKey: string;
  title: string;
  /** Platform id as written in the sheet ("PS5", "Switch 2", "Genesis", ...). */
  platform: string;
  genre: string;
  developer: string;
  /** ISO date (yyyy-mm-dd) */
  released?: string;
  year?: number;
  status: Status;
  /** Row position in its source tab (0 = top). Backlog/Completed put newest entries at the top. */
  row: number;
  /** Optional "Edition" column (Greatest Hits, Player's Choice, Collector's...) */
  edition?: string;

  // Backlog
  priority?: number; // 1 = highest, 5 = lowest
  hours?: number; // average completion time

  // Completed
  completedOn?: string; // ISO date
  grade?: Grade;
  ownPhysical?: boolean;
  value?: number; // USD
  review?: string;

  // Shopping list
  rarity?: number;
  looseValue?: number;
  cibValue?: number;
  score?: number; // "holistic score" (smaller is better)
}

export type Grade = "A+" | "A" | "B" | "C" | "D" | "F";
export const GRADES: Grade[] = ["A+", "A", "B", "C", "D", "F"];
export const GRADE_POINTS: Record<Grade, number> = { "A+": 5, A: 4, B: 3, C: 2, D: 1, F: 0 };

export interface ConsoleInfo {
  platform: string;
  released?: string; // ISO
}

export interface Library {
  /** "last updated" note from the sheet, if present */
  sheetUpdated?: string;
  fetchedAt: string;
  games: Game[];
  consoles: ConsoleInfo[];
}
