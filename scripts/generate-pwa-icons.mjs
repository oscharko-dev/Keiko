// PWA icon generator for issue #123 — one-shot dev tool, not invoked at build/runtime.
//
// Why pure Node (no `sharp`):
//   The root package.json overrides `sharp` to `empty-npm-package`, so the canonical SVG
//   rasterizer is not available in this codebase. The spec's hard rule forbids adding new
//   runtime dependencies. This script therefore emits the required PNG variants with a
//   self-contained, deterministic encoder over `node:zlib` and writes the literal SVG
//   bytes verbatim for `favicon.svg`. When `sharp` is restored upstream, the renderer
//   functions below can be swapped for `sharp` calls without changing the file contract.
//
// Why this geometry:
//   The Keiko symbol (see packages/keiko-ui/public/keiko-logo.svg, fill="#4EBA87") is a
//   filled glyph centered on a 1024-unit canvas. Without an SVG rasterizer we cannot
//   reproduce the path edges, so we emit a centered solid disc on a transparent (or
//   branded) canvas in the same accent color. This preserves the brand palette
//   (theme #4EBA87, background #1B1E23) and satisfies the W3C maskable safe-area rule.
//
// Determinism:
//   PNGs are byte-identical across runs on a given machine: zlib is invoked with
//   `level: 9` and `strategy: Z_FIXED` so the deflate stream is a pure function of
//   the pixel buffer. The PNG signature, IHDR, IDAT, IEND chunks are written in a
//   fixed order with computed CRCs.
//
// Usage: `node scripts/generate-pwa-icons.mjs`. Commit the regenerated assets.

import { Buffer } from "node:buffer";
import { copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, constants as zlibConstants } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const UI_PUBLIC = join(REPO_ROOT, "packages", "keiko-ui", "public");

const ACCENT = { r: 0x4e, g: 0xba, b: 0x87 };
const BG = { r: 0x1b, g: 0x1e, b: 0x23 };
const WHITE = { r: 0xff, g: 0xff, b: 0xff };
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function buildIhdr(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace
  return chunk("IHDR", ihdr);
}

function buildIdat(rgba, width, height) {
  // Filter byte 0 (None) per scanline; 4 bytes/pixel RGBA.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw.writeUInt8(0, y * (stride + 1));
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = deflateSync(raw, {
    level: 9,
    strategy: zlibConstants.Z_FIXED,
  });
  return chunk("IDAT", compressed);
}

function encodePng(rgba, width, height) {
  return Buffer.concat([
    PNG_SIGNATURE,
    buildIhdr(width, height),
    buildIdat(rgba, width, height),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function fillPixel(buf, idx, color) {
  buf[idx] = color.r;
  buf[idx + 1] = color.g;
  buf[idx + 2] = color.b;
  buf[idx + 3] = color.a ?? 0xff;
}

function paintCanvas(width, height, background) {
  const buf = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    fillPixel(buf, p * 4, background);
  }
  return buf;
}

// 4×4 supersample over the boundary pixel at (x,y) — returns coverage in [0, 1].
// Extracted to keep paintDisc's branching at or below the project complexity ceiling.
function discCoverage(x, y, cx, cy, radius) {
  const r2 = radius * radius;
  let hits = 0;
  for (let sy = 0; sy < 4; sy += 1) {
    for (let sx = 0; sx < 4; sx += 1) {
      const sdx = x + (sx + 0.5) / 4 - cx;
      const sdy = y + (sy + 0.5) / 4 - cy;
      if (sdx * sdx + sdy * sdy <= r2) hits += 1;
    }
  }
  return hits / 16;
}

function blendPixel(buf, idx, color, coverage) {
  const dstA = buf[idx + 3] / 255;
  const srcA = (color.a ?? 0xff) / 255;
  const outA = srcA * coverage + dstA * (1 - srcA * coverage);
  if (outA <= 0) return;
  buf[idx] = Math.round(
    (color.r * srcA * coverage + buf[idx] * dstA * (1 - srcA * coverage)) / outA,
  );
  buf[idx + 1] = Math.round(
    (color.g * srcA * coverage + buf[idx + 1] * dstA * (1 - srcA * coverage)) / outA,
  );
  buf[idx + 2] = Math.round(
    (color.b * srcA * coverage + buf[idx + 2] * dstA * (1 - srcA * coverage)) / outA,
  );
  buf[idx + 3] = Math.round(outA * 255);
}

// Draws an anti-aliased filled disc of `radius` centered at (cx, cy) onto an RGBA buffer.
// Boundary-band coverage and alpha blending are factored into discCoverage/blendPixel so
// transparent canvases composite cleanly in OS adaptive-icon shaders.
function paintDisc(buf, width, height, cx, cy, radius, color) {
  const r2outer = (radius + 1) * (radius + 1);
  const r2inner = (radius - 1) * (radius - 1);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2outer) continue;
      const coverage = d2 > r2inner ? discCoverage(x, y, cx, cy, radius) : 1;
      if (coverage <= 0) continue;
      blendPixel(buf, (y * width + x) * 4, color, coverage);
    }
  }
}

// Renders the brand "ring + dot" mark — a thick accent-colored annulus surrounding a smaller
// solid disc, evoking the Keiko symbol's circular composition (see keiko-logo.svg). Used by
// standard and apple-touch variants. `glyphColor` carries the symbol fill; `holeColor` clears
// the annulus interior to the canvas background.
function paintBrandMark(buf, width, height, glyphColor, holeColor) {
  const cx = width / 2;
  const cy = height / 2;
  const outer = width * 0.46;
  const inner = width * 0.28;
  const dot = width * 0.12;
  paintDisc(buf, width, height, cx, cy, outer, glyphColor);
  paintDisc(buf, width, height, cx, cy, inner, holeColor);
  paintDisc(buf, width, height, cx, cy, dot, glyphColor);
}

function buildStandardIcon(size) {
  const buf = paintCanvas(size, size, TRANSPARENT);
  paintBrandMark(buf, size, size, ACCENT, TRANSPARENT);
  return encodePng(buf, size, size);
}

function buildMaskableIcon(size) {
  const buf = paintCanvas(size, size, { ...ACCENT, a: 0xff });
  // W3C safe area is the centered 66% inscribed square; mark fits within it by construction
  // (outer disc diameter = size * 0.92 ≤ size * 1.00, and the mark is rendered onto a buffer
  // restricted to that safe-area sub-canvas before being composited back).
  const safeSize = Math.round(size * 0.66);
  const subBuf = paintCanvas(safeSize, safeSize, { ...ACCENT, a: 0xff });
  paintBrandMark(subBuf, safeSize, safeSize, WHITE, { ...ACCENT, a: 0xff });
  const offset = Math.round((size - safeSize) / 2);
  for (let y = 0; y < safeSize; y += 1) {
    for (let x = 0; x < safeSize; x += 1) {
      const srcIdx = (y * safeSize + x) * 4;
      const dstIdx = ((y + offset) * size + (x + offset)) * 4;
      buf[dstIdx] = subBuf[srcIdx];
      buf[dstIdx + 1] = subBuf[srcIdx + 1];
      buf[dstIdx + 2] = subBuf[srcIdx + 2];
      buf[dstIdx + 3] = subBuf[srcIdx + 3];
    }
  }
  return encodePng(buf, size, size);
}

function buildAppleTouchIcon(size) {
  const buf = paintCanvas(size, size, { ...BG, a: 0xff });
  paintBrandMark(buf, size, size, ACCENT, { ...BG, a: 0xff });
  return encodePng(buf, size, size);
}

function write(file, bytes) {
  const target = join(UI_PUBLIC, file);
  writeFileSync(target, bytes);
  console.log(`wrote ${file} (${String(bytes.length)} bytes)`);
}

const sourceSvg = join(UI_PUBLIC, "keiko-logo.svg");
const svgBytes = readFileSync(sourceSvg);
if (svgBytes.length === 0) {
  throw new Error(`keiko-logo.svg is empty at ${sourceSvg}`);
}

write("icon-192.png", buildStandardIcon(192));
write("icon-512.png", buildStandardIcon(512));
write("icon-192-maskable.png", buildMaskableIcon(192));
write("icon-512-maskable.png", buildMaskableIcon(512));
write("apple-touch-icon.png", buildAppleTouchIcon(180));

// favicon.svg is a literal copy of the source SVG so browsers receive the canonical wordmark
// path. ADR-0024 D5 lists `favicon.svg` as the vector favicon — re-emitting it via copy keeps
// the source of truth singular (edits to keiko-logo.svg propagate on the next regeneration).
copyFileSync(sourceSvg, join(UI_PUBLIC, "favicon.svg"));
console.log("wrote favicon.svg (copy of keiko-logo.svg)");

// favicon.ico fallback per spec D5 final bullet: ship a 32×32 PNG-bytes payload with `.ico`
// extension when no ICO encoder is available. All major browsers accept PNG content under a
// `.ico` URL and the manifest never references favicon.ico (legacy <link rel="shortcut icon">
// in the root layout points the legacy tab favicon at this file).
write("favicon.ico", buildStandardIcon(32));

console.log("done.");
