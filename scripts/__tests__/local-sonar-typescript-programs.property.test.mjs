import { posix } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertFrequencyFloor,
  checkProperty,
  propertySettings,
} from "../../tests/support/property-testing.ts";
import {
  generatedTsconfigPath,
  planChangedTypeScriptPrograms,
  readTsconfigPaths,
} from "../local-sonar-typescript-programs.mjs";

// Seeded properties for the pure text rules of the changed-file TypeScript program generator:
// the tsconfigPaths property parser, the checkout-id guard and path-separator normalization.
const SEGMENTS = ["src", "tests", "packages", "keiko-ui", "e2e", "a.ts", "b.tsx", "env.d.ts", "x"];
const PADDING = ["", " ", "  ", "\t", " \t "];
const ID_CHARACTERS = [..."0123456789abcdef", ..."ABCDEFgz/.-_ \\"];

function segmentPath(random, minimum, maximum) {
  const length = random.integer(minimum, maximum);
  return Array.from({ length }, () => random.pick(SEGMENTS)).join("/");
}

describe("readTsconfigPaths properties", () => {
  const name = "reads exactly the trimmed, non-empty entries under any padding and line ending";
  it(name, async () => {
    const { runs } = propertySettings({ name });
    let crlf = 0;
    let padded = 0;
    await checkProperty({
      name,
      generate: (random) => {
        const paths = Array.from(
          { length: random.integer(1, 5) },
          () => `${segmentPath(random, 1, 4)}/tsconfig.json`,
        );
        const entries = paths.map(
          (path) => `${random.pick(PADDING)}${path}${random.pick(PADDING)}`,
        );
        if (random.chance(0.3)) entries.splice(random.integer(0, entries.length), 0, " ");
        const eol = random.chance(0.5) ? "\r\n" : "\n";
        const lines = ["sonar.projectKey=keiko", "# comment"];
        lines.splice(
          random.integer(0, lines.length),
          0,
          `${random.pick(PADDING)}sonar.typescript.tsconfigPaths=${entries.join(",")}`,
        );
        return { paths, text: lines.join(eol), eol, entries };
      },
      property: ({ paths, text, eol, entries }) => {
        if (eol === "\r\n") crlf += 1;
        if (entries.some((entry) => entry !== entry.trim())) padded += 1;
        expect(readTsconfigPaths(text)).toEqual(paths);
      },
    });
    assertFrequencyFloor({ what: "CRLF input", count: crlf, runs, share: 0.3, validatedRuns: 200 });
    assertFrequencyFloor({
      what: "padded entry",
      count: padded,
      runs,
      share: 0.5,
      validatedRuns: 200,
    });
  });
});

describe("generatedTsconfigPath properties", () => {
  const name = "accepts exactly twelve lowercase hex characters and stays inside .keiko";
  it(name, async () => {
    const { runs } = propertySettings({ name });
    let accepted = 0;
    let rejected = 0;
    await checkProperty({
      name,
      generate: (random) => {
        const length = random.chance(0.5) ? 12 : random.integer(0, 16);
        const hexOnly = random.chance(0.5);
        const pool = hexOnly ? ID_CHARACTERS.slice(0, 16) : ID_CHARACTERS;
        const id = Array.from({ length }, () => random.pick(pool)).join("");
        return { id, owner: `${segmentPath(random, 0, 3)}/tsconfig.json`.replace(/^\//u, "") };
      },
      property: ({ id, owner }) => {
        if (!/^[0-9a-f]{12}$/u.test(id)) {
          rejected += 1;
          expect(() => generatedTsconfigPath(owner, id)).toThrow(TypeError);
          return;
        }
        accepted += 1;
        const path = generatedTsconfigPath(owner, id);
        expect(path).toBe(
          posix.join(posix.dirname(owner), `.keiko/local-sonar-tsconfig-${id}.json`),
        );
        expect(path.split("/")).not.toContain("..");
      },
    });
    assertFrequencyFloor({
      what: "accepted id",
      count: accepted,
      runs,
      share: 0.2,
      validatedRuns: 200,
    });
    assertFrequencyFloor({
      what: "rejected id",
      count: rejected,
      runs,
      share: 0.2,
      validatedRuns: 200,
    });
  });
});

describe("planChangedTypeScriptPrograms properties", () => {
  const name =
    "plans the same programs for backslash and slash spellings, each non-declaration file analysed once";
  it(name, async () => {
    const { runs } = propertySettings({ name });
    let backslashed = 0;
    await checkProperty({
      name,
      generate: (random) => {
        const files = [
          ...new Set(Array.from({ length: random.integer(1, 8) }, () => segmentPath(random, 1, 4))),
        ];
        const owners = [
          {
            configPath: "tsconfig.json",
            rootDir: ".",
            fileNames: files.filter((_, i) => i % 2 === 0),
          },
          {
            configPath: "packages/keiko-ui/tsconfig.json",
            rootDir: "packages/keiko-ui",
            fileNames: files.filter(() => random.chance(0.6)),
          },
        ];
        const changed = files.filter(() => random.chance(0.6));
        const spelled = changed.map((path) =>
          random.chance(0.5) ? path.replaceAll("/", "\\") : path,
        );
        return { owners, changed, spelled };
      },
      property: ({ owners, changed, spelled }) => {
        const checkoutId = "0123456789ab";
        const plans = planChangedTypeScriptPrograms({ changedPaths: changed, owners, checkoutId });
        const fromSpelled = planChangedTypeScriptPrograms({
          changedPaths: spelled,
          owners,
          checkoutId,
        });
        if (plans.length > 0 && spelled.some((path) => path.includes("\\"))) backslashed += 1;
        expect(fromSpelled).toEqual(plans);
        const owned = plans.flatMap((plan) =>
          plan.config.files
            .map((file) => posix.normalize(posix.join(posix.dirname(plan.path), file)))
            .filter((file) => changed.includes(file)),
        );
        // A declaration file is ambient context for every program that holds it; any other
        // changed file is analysed in exactly one program.
        const analysed = owned.filter((file) => !file.endsWith(".d.ts"));
        expect(analysed.length).toBe(new Set(analysed).size);
        for (const file of changed) {
          const inProgram = owners.some((owner) => owner.fileNames.includes(file));
          expect(owned.includes(file)).toBe(inProgram);
        }
      },
    });
    assertFrequencyFloor({
      what: "backslash spelling with a planned program",
      count: backslashed,
      runs,
      share: 0.2,
      validatedRuns: 200,
    });
  });
});
