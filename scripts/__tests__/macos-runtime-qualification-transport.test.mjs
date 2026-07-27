import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../macos-runtime-qualification-transport.mjs";

const roots = [];
const RECEIPT = join(
  "payload",
  "Keiko",
  "Keiko.app",
  "Contents",
  "Resources",
  ".portable",
  "runtime-qualification.json",
);

function root() {
  const value = mkdtempSync(join(tmpdir(), "keiko-macos-qualification-transport-"));
  roots.push(value);
  return value;
}

function stageFixture(base) {
  const stage = join(base, "stage");
  mkdirSync(join(stage, "payload", "Keiko"), { recursive: true });
  writeFileSync(join(stage, "payload", "Keiko", "alpha.txt"), "alpha\n");
  writeFileSync(join(stage, "payload", "Keiko", "beta.txt"), "beta\n");
  return stage;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("macOS runtime qualification transport", () => {
  it("binds a deterministic snapshot and accepts only the added qualification receipt", () => {
    const base = root();
    const stage = stageFixture(base);
    const snapshot = join(base, "snapshot.json");
    main(["snapshot", "--stage-root", stage, "--output", snapshot]);
    const payload = JSON.parse(readFileSync(snapshot, "utf8"));
    expect(payload).toMatchObject({ schemaVersion: 1 });
    expect(payload.files.map((file) => file.path)).toEqual([
      "payload/Keiko/alpha.txt",
      "payload/Keiko/beta.txt",
    ]);

    mkdirSync(join(stage, RECEIPT, ".."), { recursive: true });
    writeFileSync(join(stage, RECEIPT), '{"result":"passed"}\n');
    expect(() => main(["verify", "--stage-root", stage, "--snapshot", snapshot])).not.toThrow();
  });

  it("rejects mutated bytes, extra files, malformed snapshots, and duplicate receipt paths", () => {
    const base = root();
    const stage = stageFixture(base);
    const snapshot = join(base, "snapshot.json");
    main(["snapshot", "--stage-root", stage, "--output", snapshot]);
    writeFileSync(join(stage, "payload", "Keiko", "alpha.txt"), "changed\n");
    mkdirSync(join(stage, RECEIPT, ".."), { recursive: true });
    writeFileSync(join(stage, RECEIPT), "{}\n");
    expect(() => main(["verify", "--stage-root", stage, "--snapshot", snapshot])).toThrow(
      "qualified stage bytes changed unexpectedly",
    );

    writeFileSync(join(stage, "payload", "Keiko", "alpha.txt"), "alpha\n");
    writeFileSync(join(stage, "payload", "Keiko", "extra.txt"), "extra\n");
    expect(() => main(["verify", "--stage-root", stage, "--snapshot", snapshot])).toThrow(
      "qualified stage file set changed unexpectedly",
    );
    expect(() => main(["snapshot", "--stage-root", stage, "--output", snapshot])).toThrow(
      "qualification receipt already exists",
    );

    writeFileSync(snapshot, '{"schemaVersion":2,"files":[]}\n');
    expect(() => main(["verify", "--stage-root", stage, "--snapshot", snapshot])).toThrow(
      "snapshot is invalid",
    );
  });

  it("fails closed on links, missing arguments, and unsupported commands", () => {
    const base = root();
    const stage = stageFixture(base);
    symlinkSync(join(stage, "payload", "Keiko", "alpha.txt"), join(stage, "linked.txt"));
    expect(() =>
      main(["snapshot", "--stage-root", stage, "--output", join(base, "snapshot.json")]),
    ).toThrow("stage contains a link");
    expect(() => main(["snapshot", "--stage-root"])).toThrow("invalid arguments");
    expect(() => main(["verify", "--stage-root", stage])).toThrow("--snapshot is required");
    expect(() => main(["unknown"])).toThrow("unsupported command");
  });
});
