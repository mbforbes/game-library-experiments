// Title normalization + fuzzy similarity for matching sheet titles to art sources.

const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10", xi: "11", xii: "12", xiii: "13" };
const NUMBERS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5" };
const DROP = new Set(["the", "a", "an", "of", "and"]);

/** Normalize for comparison: lowercase, no diacritics/punctuation/parentheticals, roman -> arabic. */
export function norm(s: string, keepParens = false): string {
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (!keepParens) s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  s = s
    .replace(/&/g, " and ")
    .replace(/['’`.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return s
    .split(" ")
    .filter(Boolean)
    .map((t) => ROMAN[t] ?? NUMBERS[t] ?? t)
    .join(" ");
}

const content = (s: string) => s.split(" ").filter((t) => t && !DROP.has(t));

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/ /g, "");
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0, na = 0, nb = 0;
  for (const v of a.values()) na += v;
  for (const v of b.values()) nb += v;
  for (const [k, v] of a) inter += Math.min(v, b.get(k) ?? 0);
  return na + nb ? (2 * inter) / (na + nb) : 0;
}

/** Similarity in 0..1 between two raw titles. */
export function sim(a: string, b: string): number {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ca = content(na), cb = content(nb);
  if (ca.join(" ") === cb.join(" ")) return 0.98;
  // One is the other plus a subtitle ("Diablo 4" vs "Diablo 4 vessel of hatred") -> strong but not exact
  const sa = ca.join(" "), sb = cb.join(" ");
  if (sa && sb && (sb.startsWith(sa + " ") || sa.startsWith(sb + " "))) {
    // "Assassin's Creed" vs "Assassin's Creed 2" is a sequel, not a subtitle: a small number right
    // after the shared title marks a different game ("... 20 Year Celebration", "WRC 24" are fine)
    const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
    const next = long[short.length];
    if (next && /^\d+$/.test(next) && +next <= 12) return 0.55;
    const shorter = Math.min(ca.length, cb.length), longer = Math.max(ca.length, cb.length);
    return 0.72 + 0.2 * (shorter / longer);
  }
  const setA = new Set(ca), setB = new Set(cb);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const tokenDice = (2 * inter) / (setA.size + setB.size || 1);
  // Numbers must agree: "Gradius 2" vs "Gradius 3" is a different game.
  const numsA = ca.filter((t) => /^\d+$/.test(t)).join(","), numsB = cb.filter((t) => /^\d+$/.test(t)).join(",");
  const numPenalty = numsA !== numsB ? 0.25 : 0;
  return Math.max(0, 0.5 * tokenDice + 0.5 * dice(bigrams(sa), bigrams(sb)) - numPenalty);
}

/** "Star Fox (2026)" -> 2026 */
export function yearHint(title: string): number | undefined {
  const m = title.match(/\((\d{4})\)/);
  return m ? +m[1] : undefined;
}

/** Strip the sheet's own parenthetical qualifiers: "Star Fox (2026)" -> "Star Fox" */
export function baseTitle(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*/g, " ").trim();
}
