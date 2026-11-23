import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readJsonArgument } from "../lib/json-argument.mjs";

function recorder() {
  const errors = [];
  return { errors, io: { error: (line) => errors.push(line) } };
}

describe("readJsonArgument", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("returns the parsed file named by the one argument", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-json-argument-"));
    roots.push(root);
    const file = join(root, "input.json");
    writeFileSync(file, JSON.stringify({ ok: true }));
    const { errors, io } = recorder();
    expect(
      readJsonArgument(["node", "check", file], io, { name: "check", input: "report" }),
    ).toEqual({ value: { ok: true } });
    expect(errors).toEqual([]);
  });

  it.each([[["node", "check"]], [["node", "check", ""]]])(
    "reports a missing argument as a usage error: %j",
    (argv) => {
      const { errors, io } = recorder();
      expect(readJsonArgument(argv, io, { name: "check", input: "report" })).toEqual({
        exitCode: 2,
      });
      expect(errors).toEqual(["check: FAIL usage: node scripts/check.mjs <report.json>"]);
    },
  );

  it("reports a missing or invalid file as a failure", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-json-argument-"));
    roots.push(root);
    const invalid = join(root, "invalid.json");
    writeFileSync(invalid, "{");
    for (const file of [join(root, "absent.json"), invalid]) {
      const { errors, io } = recorder();
      expect(
        readJsonArgument(["node", "check", file], io, { name: "check", input: "evidence" }),
      ).toEqual({ exitCode: 1 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^check: FAIL the evidence could not be read \(.+\)$/u);
    }
  });
});
