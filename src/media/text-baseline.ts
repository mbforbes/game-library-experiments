// Canvas text placed by its "top", "middle" or "bottom" lands in the same spot in every browser.
// Those baselines are measured from the font's em box, and browsers disagree on where that is:
// Chrome (and current WebKit) scale the font's ascent + descent to 1 em, but Safari on iPhones
// measures from the full ascent, which for a tall-ascent font like Oswald (1.19 em) drops "top"
// text by 0.4 em (the lab's chamber sign drew its big number over its caption). So such text is
// drawn from the alphabetic baseline instead, with the em box worked out the first way.

const proto = CanvasRenderingContext2D.prototype;
/** per font: how far the em box's top sits above the baseline, and its size (px) ([0, 0] if unknown) */
const emTop = new Map<string, [number, number]>();
const emOf = (ctx: CanvasRenderingContext2D): [number, number] => {
  const font = ctx.font;
  let v = emTop.get(font);
  if (!v) {
    // (the font's ascent and descent don't depend on the text: measured once per font, as
    // measuring on every call made drawing a game's printed back noticeably slower)
    const size = parseFloat(font.match(/([\d.]+)px/)?.[1] ?? "");
    const base = ctx.textBaseline;
    ctx.textBaseline = "alphabetic";
    const m = ctx.measureText("H");
    ctx.textBaseline = base;
    const a = m.fontBoundingBoxAscent, d = m.fontBoundingBoxDescent;
    v = size > 0 && a + d > 0 ? [(size * a) / (a + d), size] : [0, 0];
    // fonts still loading measure as their fallback: don't keep that
    if (document.fonts?.check?.(font) !== false) emTop.set(font, v);
  }
  return v;
};
for (const name of ["fillText", "strokeText"] as const) {
  const draw = proto[name];
  proto[name] = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
    const base = this.textBaseline;
    if (base === "top" || base === "middle" || base === "bottom") {
      const [up, size] = emOf(this);
      if (size > 0) {
        this.textBaseline = "alphabetic";
        y += base === "top" ? up : base === "middle" ? up - size / 2 : up - size;
      }
    }
    if (maxWidth === undefined) draw.call(this, text, x, y);
    else draw.call(this, text, x, y, maxWidth);
    this.textBaseline = base;
  };
}
