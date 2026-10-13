// Grade forecasts for the backlog + context on Cooper's past grades (data/forecasts.json, made by
// scripts/forecast). Loaded lazily as its own (content-hashed, forever-cached) chunk.

export interface Forecast {
  grade: string;
  confidence: number;
  why: string;
}

export interface Forecasts {
  generatedAt: string;
  method: string;
  backtest: { exact: number; withinOne: number; n: number };
  insights: string[];
  context: {
    vsCommunity: { n: number; avgDelta: number; harsher: number; kinder: number; same: number };
    byGenre: { genre: string; n: number; avg: number; delta: number }[];
    byPlatform: { platform: string; n: number; avg: number; delta: number }[];
    byDeveloper: { developer: string; n: number; avg: number }[];
    byDecade: { decade: string; n: number; avg: number }[];
    disagreements: { id: string; title: string; grade: string; community: number; note: string }[];
    likes: string[];
    dislikes: string[];
  };
  forecasts: Record<string, Forecast>;
}

let data: Promise<Forecasts | null> | null = null;
export function loadForecasts(): Promise<Forecasts | null> {
  return (data ??= import("../../data/forecasts.json").then((m) => m.default as unknown as Forecasts).catch(() => null));
}

/** 0..5 grade points (A+ = 5 … F = 0) → nearest letter */
export function letterOf(points: number) {
  const L = ["F", "D", "C", "B", "A", "A+"];
  return L[Math.max(0, Math.min(5, Math.round(points)))];
}
