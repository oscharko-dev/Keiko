// KEIKO-0195 regression pin: the single-hard-link guard used before every evidence-artefact
// overwrite / read / list step lives in ONE module and is imported from every sub-store. The
// helper existed as six byte-identical copies across `keiko-evidence` before this consolidation;
// a future refinement of the hard-link check would have had to land in all six or leave the
// unpatched sub-store on the old behavior. This pin fails if a caller re-inlines a local copy
// or diverges the shared helper's stat + hard-link semantics.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSingleLinkRegularFile } from "./fs-safety.js";
import { EvidenceReadError, EvidenceWriteError } from "./errors.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// The six sub-stores that historically each carried their own copy.
const CONSUMERS: readonly string[] = [
  "store.ts",
  "side-file.ts",
  "tool-result-artifact-store.ts",
  join("qualityIntelligence", "store.ts"),
  join("qualityIntelligence", "companionStore.ts"),
  join("promptEnhancement", "store.ts"),
];

function readConsumer(relative: string): string {
  return readFileSync(join(SRC_DIR, relative), "utf8");
}

describe("isSingleLinkRegularFile — consolidation (KEIKO-0195)", () => {
  it("is exported from fs-safety.ts as a callable helper", () => {
    expect(typeof isSingleLinkRegularFile).toBe("function");
  });

  it("no evidence sub-store re-declares a local `function isSingleLinkRegularFile` body", () => {
    for (const consumer of CONSUMERS) {
      const source = readConsumer(consumer);
      expect(source, `${consumer} must not redefine the helper locally`).not.toMatch(
        /function\s+isSingleLinkRegularFile\s*\(/u,
      );
    }
  });

  it("every evidence sub-store imports isSingleLinkRegularFile from ./fs-safety.js", () => {
    for (const consumer of CONSUMERS) {
      const source = readConsumer(consumer);
      expect(source, `${consumer} must import the shared helper`).toContain(
        "isSingleLinkRegularFile",
      );
      expect(source, `${consumer} must import from the fs-safety module`).toMatch(
        /from\s+"[^"]*fs-safety\.js"/u,
      );
    }
  });

  it("throws the caller-supplied error class when the underlying stat fails", () => {
    const throwingFs = {
      stat: (): never => {
        throw new Error("boom");
      },
    } as unknown as Parameters<typeof isSingleLinkRegularFile>[1];

    expect(() =>
      isSingleLinkRegularFile(
        "/does/not/matter",
        throwingFs,
        (message) => new EvidenceReadError(`read: ${message}`),
      ),
    ).toThrow(EvidenceReadError);
    expect(() =>
      isSingleLinkRegularFile(
        "/does/not/matter",
        throwingFs,
        (message) => new EvidenceWriteError(`write: ${message}`),
      ),
    ).toThrow(EvidenceWriteError);
  });

  it("returns true only when the target is a regular file with hardLinkCount <= 1", () => {
    const okFs = {
      stat: (): { isFile: true; hardLinkCount: number } => ({ isFile: true, hardLinkCount: 1 }),
    } as unknown as Parameters<typeof isSingleLinkRegularFile>[1];
    const hardLinkedFs = {
      stat: (): { isFile: true; hardLinkCount: number } => ({ isFile: true, hardLinkCount: 2 }),
    } as unknown as Parameters<typeof isSingleLinkRegularFile>[1];
    const nonFileFs = {
      stat: (): { isFile: false; hardLinkCount: number } => ({ isFile: false, hardLinkCount: 1 }),
    } as unknown as Parameters<typeof isSingleLinkRegularFile>[1];
    const factory = (message: string): Error => new EvidenceReadError(message);

    expect(isSingleLinkRegularFile("/x", okFs, factory)).toBe(true);
    expect(isSingleLinkRegularFile("/x", hardLinkedFs, factory)).toBe(false);
    expect(isSingleLinkRegularFile("/x", nonFileFs, factory)).toBe(false);
  });
});
