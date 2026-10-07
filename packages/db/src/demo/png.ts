// Placeholder product images for the demo seed: a two-colour gradient with the product's
// initials, encoded as PNG with Node built-ins only (zlib for the IDAT stream). The bytes go
// through the same `validateImage` pipeline as a seller upload, so nothing here is trusted.
import { deflateSync } from "node:zlib";

// ── PNG encoding (RGB, 8-bit, Sub filter: gradients compress to a few KB) ──────────

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode packed RGB pixels (`width * height * 3` bytes) as a PNG file. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 1; // filter type Sub: each byte minus the byte 3 to its left
    for (let i = 0; i < stride; i++) raw[dst + 1 + i] = (rgb[src + i]! - (i >= 3 ? rgb[src + i - 3]! : 0)) & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // bit depth 8, colour type 2 (RGB), deflate, adaptive filters, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })), // level 9 is 3× slower for ~15% smaller files
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Drawing ─────────────────────────────────────────────────────────────────────────

/** 5×7 bitmap glyphs for A–Z and 0–9, rows top to bottom, `#` = ink. */
const GLYPHS: Record<string, string> = {
  A: ".###./#...#/#...#/#####/#...#/#...#/#...#",
  B: "####./#...#/#...#/####./#...#/#...#/####.",
  C: ".####/#..../#..../#..../#..../#..../.####",
  D: "####./#...#/#...#/#...#/#...#/#...#/####.",
  E: "#####/#..../#..../####./#..../#..../#####",
  F: "#####/#..../#..../####./#..../#..../#....",
  G: ".####/#..../#..../#..##/#...#/#...#/.####",
  H: "#...#/#...#/#...#/#####/#...#/#...#/#...#",
  I: "#####/..#../..#../..#../..#../..#../#####",
  J: "....#/....#/....#/....#/#...#/#...#/.###.",
  K: "#...#/#..#./#.#../##.../#.#../#..#./#...#",
  L: "#..../#..../#..../#..../#..../#..../#####",
  M: "#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#",
  N: "#...#/##..#/#.#.#/#..##/#...#/#...#/#...#",
  O: ".###./#...#/#...#/#...#/#...#/#...#/.###.",
  P: "####./#...#/#...#/####./#..../#..../#....",
  Q: ".###./#...#/#...#/#...#/#.#.#/#..#./.##.#",
  R: "####./#...#/#...#/####./#.#../#..#./#...#",
  S: ".####/#..../#..../.###./....#/....#/####.",
  T: "#####/..#../..#../..#../..#../..#../..#..",
  U: "#...#/#...#/#...#/#...#/#...#/#...#/.###.",
  V: "#...#/#...#/#...#/#...#/#...#/.#.#./..#..",
  W: "#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#",
  X: "#...#/#...#/.#.#./..#../.#.#./#...#/#...#",
  Y: "#...#/#...#/.#.#./..#../..#../..#../..#..",
  Z: "#####/....#/...#./..#../.#.../#..../#####",
  "0": ".###./#...#/#..##/#.#.#/##..#/#...#/.###.",
  "1": "..#../.##../..#../..#../..#../..#../.###.",
  "2": ".###./#...#/....#/...#./..#../.#.../#####",
  "3": "####./....#/....#/.###./....#/....#/####.",
  "4": "#...#/#...#/#...#/#####/....#/....#/....#",
  "5": "#####/#..../#..../####./....#/....#/####.",
  "6": ".###./#..../#..../####./#...#/#...#/.###.",
  "7": "#####/....#/...#./..#../.#.../.#.../.#...",
  "8": ".###./#...#/#...#/.###./#...#/#...#/.###.",
  "9": ".###./#...#/#...#/.####/....#/....#/.###.",
};

type Rgb = [number, number, number];
/** HSL (h in degrees, s/l in 0..1) → RGB bytes. */
export function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Initials for the overlay: first letters of up to two words, A–Z/0–9 only (what the font has). */
export function initialsOf(title: string): string {
  const words = title.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const s = words.slice(0, 2).map((w) => w[0]!).join("");
  return s || "BL";
}

export type PlaceholderOptions = {
  /** Base hue (degrees); the gradient runs from it to `hue + 40`. */
  hue: number;
  /** Rendered text, 1–2 glyphs from A–Z/0–9 (longer strings are cut). */
  initials: string;
  size?: number;
  /** Mirror the gradient direction, for a second "angle" of the same product. */
  flip?: boolean;
};

/** A square gradient card with a soft highlight disc and the initials in white. */
export function placeholderPng({ hue, initials, size = 640, flip = false }: PlaceholderOptions): Buffer {
  const text = initials.slice(0, 2);
  const [r0, g0, b0] = hsl(hue, 0.55, 0.42);
  const [r1, g1, b1] = hsl(hue + 40, 0.6, 0.3);
  const rgb = new Uint8Array(size * size * 3);
  const cx = size * 0.5;
  const cy = size * 0.46;
  const radius = size * 0.34;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = ((flip ? size - 1 - x : x) + y) / (2 * (size - 1));
      let r = r0 + (r1 - r0) * t;
      let g = g0 + (g1 - g0) * t;
      let b = b0 + (b1 - b0) * t;
      const d = Math.hypot(x - cx, y - cy);
      if (d < radius) {
        // Soft disc: brighter towards the centre.
        const k = 0.22 * (1 - d / radius) ** 0.6;
        r += (255 - r) * k;
        g += (255 - g) * k;
        b += (255 - b) * k;
      }
      const i = (y * size + x) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
  // Glyphs: scale so two characters span ~60% of the width; shadow first, then white ink.
  const scale = Math.max(1, Math.floor((size * 0.6) / (text.length * 5 + (text.length - 1))));
  const totalW = (text.length * 5 + (text.length - 1)) * scale;
  const x0 = Math.round((size - totalW) / 2);
  const y0 = Math.round(cy - (7 * scale) / 2);
  const paint = (dx: number, dy: number, ink: Rgb, alpha: number) => {
    for (const [ci, ch] of [...text].entries()) {
      const rows = (GLYPHS[ch] ?? GLYPHS["0"]!).split("/");
      for (const [ry, row] of rows.entries()) {
        for (let rx = 0; rx < 5; rx++) {
          if (row[rx] !== "#") continue;
          const px = x0 + (ci * 6 + rx) * scale + dx;
          const py = y0 + ry * scale + dy;
          for (let yy = py; yy < py + scale; yy++) {
            if (yy < 0 || yy >= size) continue;
            for (let xx = px; xx < px + scale; xx++) {
              if (xx < 0 || xx >= size) continue;
              const i = (yy * size + xx) * 3;
              rgb[i] = rgb[i]! + (ink[0] - rgb[i]!) * alpha;
              rgb[i + 1] = rgb[i + 1]! + (ink[1] - rgb[i + 1]!) * alpha;
              rgb[i + 2] = rgb[i + 2]! + (ink[2] - rgb[i + 2]!) * alpha;
            }
          }
        }
      }
    }
  };
  paint(Math.round(scale * 0.18), Math.round(scale * 0.18), [0, 0, 0], 0.22);
  paint(0, 0, [255, 255, 255], 0.96);
  return encodePng(size, size, rgb);
}
