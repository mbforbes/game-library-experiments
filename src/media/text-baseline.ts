// Canvas text placed by its "top", "middle" or "bottom" lands in the same spot in every browser.
// Those baselines are measured from the font's em box, and browsers disagree on where that is:
// Chrome (and current WebKit) scale the font's ascent + descent to 1 em, but Safari on iPhones
// measures from the full ascent, which for a tall-ascent font like Oswald (1.19 em) drops "top"
// text by 0.4 em (the lab's chamber sign drew its big number over its caption). So such text is
// drawn from the alphabetic baseline instead, with the em box worked out the first way.

const proto = CanvasRenderingContext2D.prototype;
for (const name of ["fillText", "strokeText"] as const) {
  const draw = proto[name];
  proto[name] = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
    const base = this.textBaseline;
    const size = base === "top" || base === "middle" || base === "bottom" ? parseFloat(this.font.match(/([\d.]+)px/)?.[1] ?? "") : NaN;
    if (size > 0) {
      this.textBaseline = "alphabetic";
      const m = this.measureText(text);
      const a = m.fontBoundingBoxAscent, d = m.fontBoundingBoxDescent;
      if (a + d > 0) {
        const up = (size * a) / (a + d); // the em box's top, above the baseline
        y += base === "top" ? up : base === "middle" ? up - size / 2 : up - size;
      } else this.textBaseline = base;
    }
    if (maxWidth === undefined) draw.call(this, text, x, y);
    else draw.call(this, text, x, y, maxWidth);
    this.textBaseline = base;
  };
}
