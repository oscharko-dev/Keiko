import { describe, expect, it } from "vitest";
import {
  checkProperty,
  LINEAR_RATIO_MAX,
  measureScaling,
  propertySettings,
  scalingRatio,
} from "../../../../../../tests/support/property-testing";
import {
  repositoryReferenceTextParts,
  sanitizeRepositoryEvidenceText,
} from "./repositoryReferences";

interface FilenameCase {
  readonly directory: string;
  readonly first: string;
  readonly separator: string;
  readonly last: string;
  readonly extension: string;
}

function* shrinkFilename(value: FilenameCase): Iterable<FilenameCase> {
  if (value.directory !== "") yield { ...value, directory: "" };
  if (value.first !== "A") yield { ...value, first: "A" };
  if (value.last !== "B") yield { ...value, last: "B" };
}

describe("evidence-bound spaced filenames", () => {
  it("preserves each complete known path without creating a suffix reference", async () => {
    const name = "known prose filenames keep their whole identity";
    const settings = propertySettings({ name });
    let checked = 0;
    await checkProperty<FilenameCase>({
      name,
      generate: (random) => ({
        directory: random.pick(["", "docs/", "Release Notes/"]),
        first: random.pick(["Pruefdaten", "Grüße", "会議", "Review2026"]),
        separator: random.pick([" ", "  ", " - ", " – ", "\u00a0"]),
        last: random.pick(["Notes", "Übersicht", "記録", "v2"]),
        extension: random.pick(["md", "txt", "ts"]),
      }),
      shrink: shrinkFilename,
      property: (value) => {
        const suffix = `${value.last}.${value.extension}`;
        const path = `${value.directory}${value.first}${value.separator}${suffix}`;
        const source = `[1] ${path}; see also README.md.`;
        const sanitized = sanitizeRepositoryEvidenceText(source, [suffix, path]);
        const parts = repositoryReferenceTextParts(sanitized, [suffix, path]);
        expect(
          parts.flatMap((part) => (part.reference === undefined ? [] : [part.reference.path])),
        ).toEqual([path, "README.md"]);
        expect(parts.map((part) => part.reference?.label ?? part.text ?? "").join("")).toBe(source);
        checked += 1;
      },
    });
    expect(checked).toBe(settings.runs);
  });

  it("scales with answer size for repeated complete paths and refused suffixes", () => {
    const path = "Pruefdaten - Gruesse.txt";
    const scaling = measureScaling({
      size: 512,
      maximumSize: 8192,
      build: (size) => `[1] ${path}; `.repeat(size),
      run: (source) => {
        const text = sanitizeRepositoryEvidenceText(source, [path]);
        repositoryReferenceTextParts(text, [path]);
        repositoryReferenceTextParts(source);
      },
    });
    expect(scaling.measurable).toBe(true);
    expect(scalingRatio(scaling)).toBeLessThan(LINEAR_RATIO_MAX);
  });

  it("keeps rejected known-path fragments inert in their original context", async () => {
    const name = "known path fragments cannot create new reference boundaries";
    const settings = propertySettings({ name });
    let checked = 0;
    await checkProperty({
      name,
      generate: (random) => ({
        path: `${random.pick(["Release", "Prüfung", "会議"])} - Notes.md`,
        attachment: random.pick(["", "_", "-", "@"]),
        side: random.pick(["before", "after"]),
      }),
      property: ({ path, attachment, side }) => {
        const invalid =
          side === "before" ? `README.md${attachment}${path}` : `${path}${attachment}Extra.ts`;
        const source = `README.md; ${invalid}; see CONTRIBUTING.md.`;
        const sanitized = sanitizeRepositoryEvidenceText(source, [path]);
        const parts = repositoryReferenceTextParts(sanitized, [path]);
        expect(
          parts.flatMap((part) => (part.reference === undefined ? [] : [part.reference.path])),
        ).toEqual(["README.md", "CONTRIBUTING.md"]);
        expect(parts.map((part) => part.reference?.label ?? part.text ?? "").join("")).toBe(source);
        checked += 1;
      },
    });
    expect(checked).toBe(settings.runs);
  });

  it("scans non-reference ranges only once around refused evidence names", () => {
    const path = "not a path";
    const scaling = measureScaling({
      size: 512,
      maximumSize: 8192,
      build: (size) => `${path}; `.repeat(size),
      run: (source) => repositoryReferenceTextParts(source, [path]),
    });
    expect(scaling.measurable).toBe(true);
    expect(scalingRatio(scaling)).toBeLessThan(LINEAR_RATIO_MAX);
  });
});
