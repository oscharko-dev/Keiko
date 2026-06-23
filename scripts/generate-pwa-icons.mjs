// PWA icon generator for issue #123.
//
// This emits the installable app icon set from the canonical Keiko SVG mark in
// packages/keiko-ui/public/keiko-logo.svg. The generated PNGs are committed because
// browsers and OS launchers need raster icons for PWA installation surfaces.
//
// The root package intentionally overrides `sharp`, so this one-shot developer tool uses
// the platform SVG renderer available through macOS `sips`. It is not invoked by build or
// runtime. If the project later restores a cross-platform SVG rasterizer, replace renderSvg()
// with that implementation without changing the output file contract.
//
// Usage: `node scripts/generate-pwa-icons.mjs`. Commit the regenerated assets.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const UI_PUBLIC = join(REPO_ROOT, "packages", "keiko-ui", "public");

const ACCENT = "#4EBA87";
const MARK = "#050806";
const PRODUCT_TITLE = "Keiko | Ex experientia disco";
const SOURCE_VIEWBOX = "0 0 1024 1024";
const APP_ICON_VISUAL_SCALE = 0.95;

const sourceSvg = join(UI_PUBLIC, "keiko-logo.svg");
const sourceSvgText = readFileSync(sourceSvg, "utf8");
const svgInner = extractSvgInner(sourceSvgText);

function extractSvgInner(svg) {
  const match = /<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/u.exec(svg);
  if (!match?.[1]?.trim()) {
    throw new Error(`Could not extract SVG body from ${sourceSvg}`);
  }
  return match[1].trim();
}

function xmlEscape(value) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function withFill(svg, fill) {
  return svg.replace(/fill="#[0-9A-Fa-f]{6}"/gu, `fill="${fill}"`);
}

function buildIconSvg(size, options = {}) {
  const background = options.background;
  const fill = options.fill ?? MARK;
  const visualScale = options.visualScale ?? 1;
  const glyphSize = Math.round(size * visualScale);
  const glyphOffset = Math.round((size - glyphSize) / 2);
  const backgroundRect =
    typeof background === "string"
      ? `<rect x="0" y="0" width="${size}" height="${size}" fill="${background}"/>`
      : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<title>${xmlEscape(PRODUCT_TITLE)}</title>`,
    backgroundRect,
    `<svg x="${glyphOffset}" y="${glyphOffset}" width="${glyphSize}" height="${glyphSize}" viewBox="${SOURCE_VIEWBOX}" preserveAspectRatio="xMidYMid meet">`,
    withFill(svgInner, fill),
    "</svg>",
    "</svg>",
  ].join("");
}

function writeSvgIcon(file, size, options) {
  writeFileSync(join(UI_PUBLIC, file), buildIconSvg(size, options));
  console.log(`wrote ${file}`);
}

function renderSvg(inputSvg, outputPng) {
  const result = spawnSync("sips", ["-s", "format", "png", inputSvg, "--out", outputPng], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Failed to render ${inputSvg} to ${outputPng}.`,
        "Install or enable a platform SVG renderer, or replace this script with a cross-platform rasterizer.",
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function renderIcon(file, size, options) {
  const tempDir = mkdtempSync(join(tmpdir(), "keiko-pwa-icon-"));
  try {
    const tempSvg = join(tempDir, `${file}.svg`);
    const target = join(UI_PUBLIC, file);
    writeFileSync(tempSvg, buildIconSvg(size, options));
    renderSvg(tempSvg, target);
    console.log(`wrote ${file}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const brandedIcon = { background: ACCENT, fill: MARK, visualScale: APP_ICON_VISUAL_SCALE };

renderIcon("icon-192.png", 192, brandedIcon);
renderIcon("icon-512.png", 512, brandedIcon);
renderIcon("icon-192-maskable.png", 192, brandedIcon);
renderIcon("icon-512-maskable.png", 512, brandedIcon);
renderIcon("apple-touch-icon.png", 180, brandedIcon);
renderIcon("favicon.ico", 32, brandedIcon);
writeSvgIcon("favicon.svg", 1024, brandedIcon);
console.log("done.");
