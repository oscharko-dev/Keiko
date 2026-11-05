import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { openProgress } from "../testing/memory-lab/progress.mjs";
import { holdoutProgressCodec } from "../testing/memory-lab/corpus/holdout.mjs";

describe("completed lab jobs (#4247)", () => {
  let out;
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "memory-lab-progress-"));
  });
  afterEach(() => rmSync(out, { recursive: true, force: true }));
  const identity = { corpus: "fixture", model: "local", budget: 12 };
  const options = () => ({ out, identity, total: 3 });

  it("keeps an ordered private journal and requires an explicit matching resume", () => {
    const progress = openProgress(options());
    progress.append({ scenario: "one", score: 1 });
    progress.append({ scenario: "two", score: 0 });
    expect(() => openProgress(options())).toThrow(/use --resume/u);
    expect(() =>
      openProgress({ ...options(), resume: true, identity: { ...identity, budget: 13 } }),
    ).toThrow(/different inputs/u);
    expect(() => openProgress({ ...options(), resume: true, total: 4 })).toThrow(
      /different inputs/u,
    );
    const resumed = openProgress({ ...options(), resume: true });
    expect(resumed.results).toEqual([
      { scenario: "one", score: 1 },
      { scenario: "two", score: 0 },
    ]);
    for (const file of readdirSync(join(out, ".progress")))
      expect(statSync(join(out, ".progress", file)).mode & 0o077).toBe(0);
    resumed.append({ scenario: "three", score: 1 });
    expect(() => resumed.append({ scenario: "four" })).toThrow(/every job/u);
    resumed.clear();
    expect(existsSync(join(out, ".progress"))).toBe(false);
    expect(() => openProgress({ ...options(), resume: true })).toThrow(/no unfinished progress/u);
  });

  it("refuses a damaged job or a gap rather than remeasuring or silently losing it", () => {
    openProgress(options()).append({ scenario: "one" });
    const path = join(out, ".progress", "00000000.json");
    const entry = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...entry, value: { scenario: "changed" } }));
    expect(() => openProgress({ ...options(), resume: true })).toThrow(/integrity/u);
    rmSync(path);
    writeFileSync(join(out, ".progress", "00000001.json"), JSON.stringify(entry));
    expect(() => openProgress({ ...options(), resume: true })).toThrow(/missing or unknown job/u);
  });

  it.each([null, 42, []])("refuses a malformed manifest root %j", (value) => {
    openProgress(options()).append({ scenario: "one" });
    writeFileSync(join(out, ".progress", "manifest.json"), JSON.stringify(value));
    expect(() => openProgress({ ...options(), resume: true })).toThrow(/manifest is malformed/u);
  });

  it.each([null, 42, []])("refuses a malformed job root %j", (value) => {
    openProgress(options()).append({ scenario: "one" });
    writeFileSync(join(out, ".progress", "00000000.json"), JSON.stringify(value));
    expect(() => openProgress({ ...options(), resume: true })).toThrow(/job is malformed/u);
  });

  it.each(["manifest.json", "00000000.json"])("refuses non-regular progress path %s", (name) => {
    openProgress(options()).append({ scenario: "one" });
    const path = join(out, ".progress", name);
    rmSync(path);
    mkdirSync(path);
    expect(() => openProgress({ ...options(), resume: true })).toThrow(/regular file/u);
  });

  it("refuses a restored job whose input does not match the current plan", () => {
    openProgress(options()).append({ scenario: "unexpected" });
    expect(() =>
      openProgress({
        ...options(),
        resume: true,
        validate: (value) => value.scenario === "expected",
      }),
    ).toThrow(/planned input/u);
  });

  it("encrypts holdout jobs with a separate key and detects changes without quoting content", () => {
    const codec = holdoutProgressCodec(Buffer.alloc(32, 4));
    const value = { scenario: "PRIVATE-HOLDOUT-NAME", turns: [{ user: "PRIVATE TURN" }] };
    const progress = openProgress({ ...options(), codec });
    progress.append(value);
    const path = join(out, ".progress", "00000000.json");
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("PRIVATE");
    expect(openProgress({ ...options(), codec, resume: true }).results).toEqual([value]);
    const otherKey = holdoutProgressCodec(Buffer.alloc(32, 5));
    expect(() => openProgress({ ...options(), codec: otherKey, resume: true })).toThrow(
      /wrong key or modified/u,
    );
    const envelope = JSON.parse(text);
    const bytes = Buffer.from(envelope.data, "base64");
    bytes[0] ^= 1;
    writeFileSync(path, JSON.stringify({ ...envelope, data: bytes.toString("base64") }));
    expect(() => openProgress({ ...options(), codec, resume: true })).toThrow(
      /wrong key or modified/u,
    );
  });
});
