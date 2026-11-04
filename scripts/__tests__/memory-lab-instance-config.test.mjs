import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLabInstance } from "../testing/memory-lab/instance.mjs";

describe("the gateway configuration a live instance reads", () => {
  let subjectRoot;
  let dir;
  let configPath;
  const bytes = JSON.stringify({
    providers: [{ modelId: "a", baseUrl: "http://127.0.0.1:9/v1", apiKey: "lab-key-value" }],
  });
  beforeEach(() => {
    subjectRoot = mkdtempSync(join(tmpdir(), "memory-lab-subject-"));
    dir = mkdtempSync(join(tmpdir(), "memory-lab-instance-"));
    mkdirSync(join(dir, "project"), { recursive: true });
    configPath = join(mkdtempSync(join(tmpdir(), "memory-lab-config-")), "gateway.json");
    writeFileSync(configPath, bytes, { mode: 0o600 });
  });
  afterEach(() => {
    rmSync(subjectRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(configPath, ".."), { recursive: true, force: true });
  });

  it("is a private copy of the operator's file, so the product's writes never reach that file", async () => {
    // The failure this pins: the instance pointed KEIKO_CONFIG_FILE at the operator's own file, which
    // the product rewrites at start (persisted credentials) and on context-window adoption; the
    // digest check then ended the run at the next unit, and the operator's file had been changed.
    const error = await startLabInstance({
      dir,
      ceiling: "autonomous-delivery",
      subjectRoot,
      configPath,
      answerModelId: "a",
      learnModelId: "a",
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    const copy = join(dir, "gateway.json");
    expect(readFileSync(copy, "utf8")).toBe(bytes);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath, "utf8")).toBe(bytes);
  });
});
