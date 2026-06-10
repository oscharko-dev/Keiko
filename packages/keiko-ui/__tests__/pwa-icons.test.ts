import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, "..", "public");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngFixture {
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

// ADR-0024 D5 — manifest-referenced raster set plus apple-touch and the legacy ICO fallback.
// favicon.ico ships as a 32×32 PNG payload (see scripts/generate-pwa-icons.mjs header) because
// the codebase has no ICO encoder and the spec permits the PNG-bytes-with-.ico-extension form.
const PNG_FIXTURES: readonly PngFixture[] = [
  { file: "icon-192.png", width: 192, height: 192 },
  { file: "icon-512.png", width: 512, height: 512 },
  { file: "icon-192-maskable.png", width: 192, height: 192 },
  { file: "icon-512-maskable.png", width: 512, height: 512 },
  { file: "apple-touch-icon.png", width: 180, height: 180 },
  { file: "favicon.ico", width: 32, height: 32 },
];

const OLD_PLACEHOLDER_HASHES: ReadonlyMap<string, string> = new Map([
  ["icon-192.png", "9059e1ba8b01fcf3e5f92eda3987ec790404ee704ce12de21d4bc447509f0cf8"],
  ["icon-512.png", "c3d0aae799bbe90e6504b2c2cdfc3a2ddb535fa08131ed529babcd99ad129faa"],
  ["icon-192-maskable.png", "901d8e8505e89c0f0f40b116922262362d6f93335c824f69c936ad7a9fb497da"],
  ["icon-512-maskable.png", "517ce6380ce284dd2bc3da83fce9c191c68e72b2f522ece8a2f6e44113bd952d"],
  ["apple-touch-icon.png", "ffe14908c22279fe5d05b3d257019ca866ab697de0fa2b4e4ce3259caafc7850"],
  ["favicon.ico", "f9f8abdd1383fa4adab6d08d77b94583aed94e69a4d729c391280c4d616c7069"],
] as const);

interface PngHeader {
  readonly signatureValid: boolean;
  readonly width: number;
  readonly height: number;
}

function readPngHeader(file: string): PngHeader {
  const buf = readFileSync(resolve(PUBLIC_DIR, file));
  const signatureValid = buf.subarray(0, 8).equals(PNG_SIGNATURE);
  return {
    signatureValid,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function sha256(file: string): string {
  return createHash("sha256")
    .update(readFileSync(resolve(PUBLIC_DIR, file)))
    .digest("hex");
}

describe("PWA icon assets (ADR-0024 D5, issue #123)", () => {
  it.each(PNG_FIXTURES)("$file exists and is non-empty", (fixture) => {
    const stat = statSync(resolve(PUBLIC_DIR, fixture.file));
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);
  });

  it.each(PNG_FIXTURES)("$file is a real PNG with the expected IHDR signature", (fixture) => {
    const header = readPngHeader(fixture.file);
    expect(header.signatureValid).toBe(true);
  });

  it.each(PNG_FIXTURES)("$file IHDR width × height equals $width × $height", (fixture) => {
    const header = readPngHeader(fixture.file);
    expect(header.width).toBe(fixture.width);
    expect(header.height).toBe(fixture.height);
  });

  it.each(PNG_FIXTURES)("$file is not the old circular placeholder asset", (fixture) => {
    expect(sha256(fixture.file)).not.toBe(OLD_PLACEHOLDER_HASHES.get(fixture.file));
  });

  it("ships favicon.svg as a copy of keiko-logo.svg (D5 vector favicon)", () => {
    const favicon = readFileSync(resolve(PUBLIC_DIR, "favicon.svg"));
    const source = readFileSync(resolve(PUBLIC_DIR, "keiko-logo.svg"));
    expect(favicon.length).toBeGreaterThan(0);
    expect(favicon.equals(source)).toBe(true);
  });

  it("ships every manifest-referenced icon path on disk", () => {
    interface IconEntry {
      readonly src: string;
    }
    interface Manifest {
      readonly icons: readonly IconEntry[];
    }
    const manifest = JSON.parse(
      readFileSync(resolve(PUBLIC_DIR, "manifest.webmanifest"), "utf8"),
    ) as Manifest;
    for (const icon of manifest.icons) {
      const onDisk = resolve(PUBLIC_DIR, icon.src.replace(/^\//, ""));
      expect(statSync(onDisk).isFile()).toBe(true);
    }
  });
});
