import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, "..", "public", "manifest.webmanifest");

interface IconEntry {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

interface Manifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  lang: string;
  dir: string;
  categories: readonly string[];
  icons: readonly IconEntry[];
}

function loadManifest(): Manifest {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  return JSON.parse(raw) as Manifest;
}

const ABSOLUTE_URL = /^https?:\/\//i;
const HOST_WITH_PORT = /:\d+/;
const SECRET_SHAPED = /^(sk-|pk-|ghp_|github_pat_)/;

describe("PWA manifest contract (ADR-0024 D4, issue #123)", () => {
  it("is valid JSON and parses to an object", () => {
    expect(() => loadManifest()).not.toThrow();
  });

  it.each([
    ["name", "Keiko"],
    ["short_name", "Keiko"],
    ["description", "Keiko — a governed agentic workspace for knowledge work."],
    ["start_url", "/"],
    ["scope", "/"],
    ["display", "standalone"],
    ["theme_color", "#4EBA87"],
    ["background_color", "#1B1E23"],
    ["lang", "en"],
    ["dir", "ltr"],
  ] as const)("sets %s to the exact D4 value %s", (field, expected) => {
    const m = loadManifest() as unknown as Record<string, unknown>;
    expect(m[field]).toBe(expected);
  });

  it("declares categories as exactly ['business', 'productivity', 'developer-tools']", () => {
    const m = loadManifest();
    expect(m.categories).toEqual(["business", "productivity", "developer-tools"]);
  });

  it("lists exactly four icon entries covering both purposes and both sizes", () => {
    const m = loadManifest();
    expect(m.icons).toHaveLength(4);
    expect(m.icons).toEqual([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-192-maskable.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ]);
  });

  it("contains no absolute URLs (no deployment endpoint leak)", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    expect(ABSOLUTE_URL.test(raw)).toBe(false);
  });

  it("contains no host:port substrings (no hardcoded port leak)", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    expect(HOST_WITH_PORT.test(raw)).toBe(false);
  });

  it("contains no secret-shaped values", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    expect(SECRET_SHAPED.test(raw)).toBe(false);
    const m = loadManifest() as unknown as Record<string, unknown>;
    for (const value of Object.values(m)) {
      if (typeof value === "string") {
        expect(SECRET_SHAPED.test(value)).toBe(false);
      }
    }
  });

  it("uses root-relative icon paths (every src begins with '/')", () => {
    const m = loadManifest();
    for (const icon of m.icons) {
      expect(icon.src.startsWith("/")).toBe(true);
      expect(ABSOLUTE_URL.test(icon.src)).toBe(false);
    }
  });

  it("declares short_name within the 12-character icon-label limit", () => {
    const m = loadManifest();
    expect(m.short_name.length).toBeLessThanOrEqual(12);
  });
});
