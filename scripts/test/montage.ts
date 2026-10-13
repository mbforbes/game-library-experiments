// bun scripts/test/montage.ts out.jpg a.png b.png ... [--cols=2] [--w=900]
import sharp from "sharp";
const args = process.argv.slice(2);
const opt = (k: string, d: number) => +(args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);
const files = args.filter((a) => !a.startsWith("--"));
const out = files.shift()!;
const cols = opt("cols", 2), W = opt("w", 900);
const imgs = await Promise.all(files.map(async (f) => {
  const img = sharp(f).resize(W);
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  const label = Buffer.from(`<svg width="${W}" height="28"><rect width="100%" height="100%" fill="#000" opacity="0.6"/><text x="8" y="20" font-family="Helvetica" font-size="16" fill="#ff0">${f.split("/").pop()}</text></svg>`);
  return { buf: await sharp(data).composite([{ input: label, left: 0, top: 0 }]).toBuffer(), h: info.height };
}));
const H = Math.max(...imgs.map((i) => i.h));
const rows = Math.ceil(imgs.length / cols);
await sharp({ create: { width: cols * W, height: rows * H, channels: 3, background: "#111" } })
  .composite(imgs.map((im, i) => ({ input: im.buf, left: (i % cols) * W, top: Math.floor(i / cols) * H })))
  .jpeg({ quality: 82 }).toFile(out);
console.log(out);
