// Sealed holdout (#4208): the scenario set is encrypted at rest, opened only in memory, and a run on
// it leaves aggregates under masked names. The last tests run the real product offline and prove that
// no seed, turn text or question of the holdout reaches any file the run writes.
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import {
  HoldoutError,
  holdoutManifest,
  holdoutScenarioName,
  maskHoldoutResult,
  openHoldout,
  openSealedHoldout,
  sealHoldout,
} from "../testing/memory-lab/corpus/holdout.mjs";
import { DEFAULT_SCENARIO_DIR, normalizeOptions, runLab } from "../testing/memory-lab/run.mjs";
import { loadScenarioDirectory, scenarioDigest } from "../testing/memory-lab/scenario.mjs";

const HOLDOUT_SCRIPT = fileURLToPath(
  new URL("../testing/memory-lab/corpus/holdout.mjs", import.meta.url),
);
const RUN_TIMEOUT_MS = 180_000;
const NEEDLES = [
  "Zebrafink",
  "Quarzbach",
  "Flussbarsch",
  "holdout-leak-probe",
  "Ich bevorzuge Zebrafink-Diagramme bei jeder Auswertung.",
  "Heute bearbeite ich den Quarzbach-Bericht.",
];

function leakScenario() {
  return {
    schemaVersion: 1,
    id: "holdout-leak-probe-de",
    language: "de",
    class: "preference",
    difficulty: "plain",
    description: "A sealed scenario whose words must never reach a report.",
    truth: [
      {
        key: "zebrafink-diagramme",
        seed: "Ich bevorzuge Zebrafink-Diagramme bei jeder Auswertung.",
        must: true,
        private: true,
        terms: [["Zebrafink"]],
      },
    ],
    turns: [
      {
        user: "Ich bevorzuge Zebrafink-Diagramme bei jeder Auswertung.",
        assistant: "Notiert für Quarzbach.",
        learner: [
          { body: "Ich bevorzuge Zebrafink-Diagramme bei jeder Auswertung.", type: "preference" },
        ],
      },
      { user: "Heute bearbeite ich den Quarzbach-Bericht.", assistant: "Gern." },
    ],
    probes: [
      {
        id: "quarzbach-related",
        question: "Welche Darstellung wähle ich für den Quarzbach-Bericht?",
        expect: { kind: "answer", terms: [["Zebrafink"]] },
      },
      {
        id: "flussbarsch-unknown",
        question: "Wie nannte ich meinen Flussbarsch?",
        expect: { kind: "abstain" },
      },
      {
        id: "quarzbach-unrelated",
        question: "Erkläre mir die Hydrologie des Quarzbach.",
        expect: { kind: "no-memory" },
      },
    ],
  };
}

function allFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}

// What a sealed run leaves of its private instance state: nothing.
function sealedStateDirectories(directory) {
  return readdirSync(directory).filter((name) => name.startsWith("memory-lab-sealed-"));
}

function leaks(directory) {
  const found = [];
  for (const file of allFiles(directory)) {
    const text = readFileSync(file, "utf8").toLowerCase();
    for (const needle of NEEDLES)
      if (text.includes(needle.toLowerCase())) found.push([file, needle]);
  }
  return found;
}

describe("sealed holdout file", () => {
  let root;
  let scenarios;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-holdout-"));
    scenarios = join(root, "scenarios");
    mkdirSync(scenarios);
    writeFileSync(join(scenarios, "leak.json"), JSON.stringify(leakScenario()));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function seal(name = "holdout.json") {
    return sealHoldout({
      scenarios,
      out: join(root, "sealed", name),
      keyFile: join(root, "keys", "holdout.key"),
    });
  }

  it("round-trips a scenario set through encryption and returns it in memory", () => {
    const sealed = seal();
    expect(sealed.count).toBe(1);
    const opened = openHoldout(
      join(root, "sealed", "holdout.json"),
      join(root, "keys", "holdout.key"),
    );
    const original = loadScenarioDirectory(scenarios);
    expect(opened.map((scenario) => scenarioDigest(scenario))).toEqual(
      original.map((scenario) => scenarioDigest(scenario)),
    );
    expect(readdirSync(root).toSorted()).toEqual(["keys", "scenarios", "sealed"]);
  });

  it("writes only ciphertext: none of the scenario's words are in the file", () => {
    seal();
    const file = readFileSync(join(root, "sealed", "holdout.json"), "utf8");
    const envelope = JSON.parse(file);
    expect(envelope).toMatchObject({
      format: "keiko-memory-holdout",
      version: 1,
      algorithm: "aes-256-gcm",
    });
    expect(Buffer.from(envelope.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(envelope.tag, "base64")).toHaveLength(16);
    for (const needle of NEEDLES) expect(file.toLowerCase()).not.toContain(needle.toLowerCase());
  });

  it("creates the key file with 32 random bytes and mode 0600, and reuses it", () => {
    seal("one.json");
    const keyPath = join(root, "keys", "holdout.key");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64")).toHaveLength(32);
    expect(statSync(join(root, "sealed", "one.json")).mode & 0o777).toBe(0o600);
    const before = readFileSync(keyPath, "utf8");
    seal("two.json");
    expect(readFileSync(keyPath, "utf8")).toBe(before);
    const first = JSON.parse(readFileSync(join(root, "sealed", "one.json"), "utf8"));
    const second = JSON.parse(readFileSync(join(root, "sealed", "two.json"), "utf8"));
    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
  });

  it("refuses to overwrite an existing holdout", () => {
    seal();
    expect(() => seal()).toThrow(/refusing to overwrite an existing holdout/u);
  });

  it("refuses a wrong key and a modified file without naming any content", () => {
    seal();
    const file = join(root, "sealed", "holdout.json");
    const otherKey = join(root, "keys", "other.key");
    mkdirSync(join(root, "keys"), { recursive: true });
    writeFileSync(otherKey, `${Buffer.alloc(32, 7).toString("base64")}\n`, { mode: 0o600 });
    expect(() => openHoldout(file, otherKey)).toThrow(/wrong key or modified file/u);
    const envelope = JSON.parse(readFileSync(file, "utf8"));
    for (const field of ["data", "tag", "iv"]) {
      const bytes = Buffer.from(envelope[field], "base64");
      bytes[0] ^= 1;
      const tampered = join(root, `tampered-${field}.json`);
      writeFileSync(tampered, JSON.stringify({ ...envelope, [field]: bytes.toString("base64") }));
      expect(() => openHoldout(tampered, join(root, "keys", "holdout.key"))).toThrow(HoldoutError);
      expect(() => openHoldout(tampered, join(root, "keys", "holdout.key"))).toThrow(
        /wrong key or modified file/u,
      );
    }
  });

  it("refuses a file that is not a holdout or has another format", () => {
    seal();
    const keyFile = join(root, "keys", "holdout.key");
    writeFileSync(join(root, "plain.json"), JSON.stringify(leakScenario()));
    expect(() => openHoldout(join(root, "plain.json"), keyFile)).toThrow(/unknown format/u);
    writeFileSync(join(root, "broken.json"), "{ nope");
    expect(() => openHoldout(join(root, "broken.json"), keyFile)).toThrow(/not a holdout/u);
    expect(() => openHoldout(join(root, "missing.json"), keyFile)).toThrow(/not a holdout/u);
    const envelope = JSON.parse(readFileSync(join(root, "sealed", "holdout.json"), "utf8"));
    writeFileSync(join(root, "v2.json"), JSON.stringify({ ...envelope, version: 2 }));
    expect(() => openHoldout(join(root, "v2.json"), keyFile)).toThrow(/unknown format/u);
  });

  it("refuses an unsafe key file", () => {
    seal();
    const file = join(root, "sealed", "holdout.json");
    const keyPath = join(root, "keys", "holdout.key");
    chmodSync(keyPath, 0o644);
    expect(() => openHoldout(file, keyPath)).toThrow(/must not be accessible to group or others/u);
    chmodSync(keyPath, 0o600);
    const link = join(root, "keys", "link.key");
    symlinkSync(keyPath, link);
    expect(() => openHoldout(file, link)).toThrow(/must be a regular file/u);
    writeFileSync(join(root, "keys", "short.key"), "c2hvcnQ=\n", { mode: 0o600 });
    expect(() => openHoldout(file, join(root, "keys", "short.key"))).toThrow(/32 bytes/u);
    expect(() => openHoldout(file, join(root, "keys", "absent.key"))).toThrow(/does not exist/u);
  });

  it("refuses paths inside the checkout and an empty or invalid scenario set", () => {
    expect(() =>
      sealHoldout({ scenarios, out: join(REPO_ROOT, "holdout.json"), keyFile: join(root, "k") }),
    ).toThrow(/--out must lie outside the checkout/u);
    expect(() =>
      sealHoldout({
        scenarios,
        out: join(root, "h.json"),
        keyFile: join(REPO_ROOT, "holdout.key"),
      }),
    ).toThrow(/--key-file must lie outside the checkout/u);
    expect(existsSync(join(REPO_ROOT, "holdout.key"))).toBe(false);
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(() =>
      sealHoldout({ scenarios: empty, out: join(root, "h.json"), keyFile: join(root, "k") }),
    ).toThrow(/holds no scenario/u);
    expect(existsSync(join(root, "k"))).toBe(false);
    writeFileSync(join(scenarios, "bad.json"), JSON.stringify({ ...leakScenario(), id: "Bad Id" }));
    expect(() => seal("bad.json")).toThrow(/slug/u);
    expect(existsSync(join(root, "keys"))).toBe(false);
    expect(() => openHoldout(join(REPO_ROOT, "holdout.json"), join(root, "k"))).toThrow(
      /--holdout must lie outside the checkout/u,
    );
  });

  it("seals from the command line", () => {
    const out = join(root, "cli", "holdout.json");
    const keyFile = join(root, "cli", "holdout.key");
    const run = (args) =>
      spawnSync(process.execPath, [HOLDOUT_SCRIPT, ...args], { encoding: "utf8", timeout: 60000 });
    const sealed = run(["seal", "--scenarios", scenarios, "--out", out, "--key-file", keyFile]);
    expect(sealed.status).toBe(0);
    expect(sealed.stdout).toMatch(/^PASS memory-lab-holdout sealed=1 setDigest=[0-9a-f]{64}$/mu);
    expect(openHoldout(out, keyFile)).toHaveLength(1);
    const usage = run(["seal", "--scenarios", scenarios]);
    expect(usage.status).not.toBe(0);
    expect(usage.stderr).toMatch(/usage: holdout\.mjs seal/u);
    const inside = run([
      "seal",
      "--scenarios",
      scenarios,
      "--out",
      join(REPO_ROOT, "x.json"),
      "--key-file",
      keyFile,
    ]);
    expect(inside.status).not.toBe(0);
    expect(inside.stderr).toMatch(/must lie outside the checkout/u);
  });
});

describe("what a sealed run may show", () => {
  const MASKING_KEY = Buffer.alloc(32, 7);

  it("names a scenario by its class, language and a keyed hash of its id", () => {
    const scenario = loadScenarioDirectory(DEFAULT_SCENARIO_DIR).find(
      (entry) => entry.id === "preference-tables-de",
    );
    const name = holdoutScenarioName(scenario, MASKING_KEY);
    expect(name).toMatch(/^holdout:preference:de:[0-9a-f]{12}$/u);
    expect(name).toBe(holdoutScenarioName(scenario, MASKING_KEY));
    expect(name).not.toContain("tables");
    expect(holdoutScenarioName({ ...scenario, id: "another-id" }, MASKING_KEY)).not.toBe(name);
  });

  it("cannot be checked against a guessed id without the key", () => {
    // The failure this pins: the digest was sha256(id), and ids are short and guessable, so anyone
    // who could read a report could confirm which scenario a masked name stood for.
    const scenario = loadScenarioDirectory(DEFAULT_SCENARIO_DIR).find(
      (entry) => entry.id === "preference-tables-de",
    );
    const unkeyed = createHash("sha256").update(scenario.id).digest("hex").slice(0, 12);
    const name = holdoutScenarioName(scenario, MASKING_KEY);
    expect(name.endsWith(`:${unkeyed}`)).toBe(false);
    const other = holdoutScenarioName(scenario, Buffer.alloc(32, 8));
    expect(other).not.toBe(name);
  });

  it("refuses to name a scenario without a masking key", () => {
    const scenario = loadScenarioDirectory(DEFAULT_SCENARIO_DIR)[0];
    expect(() => holdoutScenarioName(scenario)).toThrow(HoldoutError);
    expect(() => holdoutScenarioName(scenario, Buffer.alloc(8))).toThrow(/masking key/u);
  });

  it("derives the masking key from the holdout key, so one key file masks one holdout", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-lab-holdout-mask-"));
    try {
      const scenarios = join(root, "scenarios");
      mkdirSync(scenarios);
      writeFileSync(join(scenarios, "leak.json"), JSON.stringify(leakScenario()));
      sealHoldout({
        scenarios,
        out: join(root, "sealed", "holdout.json"),
        keyFile: join(root, "keys", "a.key"),
      });
      sealHoldout({
        scenarios,
        out: join(root, "sealed", "other.json"),
        keyFile: join(root, "keys", "b.key"),
      });
      const first = openSealedHoldout(
        join(root, "sealed", "holdout.json"),
        join(root, "keys", "a.key"),
      );
      const again = openSealedHoldout(
        join(root, "sealed", "holdout.json"),
        join(root, "keys", "a.key"),
      );
      const second = openSealedHoldout(
        join(root, "sealed", "other.json"),
        join(root, "keys", "b.key"),
      );
      expect(first.maskingKey).toHaveLength(32);
      expect(first.maskingKey.equals(again.maskingKey)).toBe(true);
      expect(first.maskingKey.equals(second.maskingKey)).toBe(false);
      expect(holdoutScenarioName(first.scenarios[0], first.maskingKey)).not.toBe(
        holdoutScenarioName(second.scenarios[0], second.maskingKey),
      );
      expect(readFileSync(join(root, "keys", "a.key"), "utf8")).not.toContain(
        first.maskingKey.toString("base64"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("masks every id in the manifest and keeps counts and one-way digests", () => {
    const scenarios = loadScenarioDirectory(DEFAULT_SCENARIO_DIR);
    const manifest = holdoutManifest(scenarios, MASKING_KEY);
    expect(manifest.count).toBe(scenarios.length);
    expect(manifest.setDigest).toMatch(/^[0-9a-f]{64}$/u);
    for (const [index, entry] of manifest.entries.entries()) {
      expect(entry.id).toBe(holdoutScenarioName(scenarios[index], MASKING_KEY));
      expect(entry.digest).toBe(scenarioDigest(scenarios[index]));
    }
    expect(JSON.stringify(manifest)).not.toContain("preference-tables");
  });

  it("replaces probe ids and fact keys by their position and drops everything that names a memory", () => {
    const result = {
      scenario: "reversal-spaces-en",
      language: "en",
      class: "reversal",
      arm: "oracle",
      repetition: 0,
      store: {
        stored: 1,
        live: 1,
        precision: 1,
        recall: 0.5,
        missing: ["indentation", "tabs-rule"],
        counters: { credential: 0 },
        verdicts: [{ id: "m1", key: "indentation" }],
        memories: [{ id: "m1", type: "preference" }],
      },
      probes: [
        { id: "related", kind: "answer", passed: true },
        { id: "unknown", kind: "abstain", passed: false },
      ],
      oracle: {
        seeded: [{ key: "indentation" }],
        mismatches: ["tabs-rule"],
        preconditionMet: false,
      },
      timing: { learnMs: 1, probeMs: 2 },
    };
    const masked = maskHoldoutResult(result, "holdout:reversal:en:abc");
    expect(masked.scenario).toBe("holdout:reversal:en:abc");
    expect(masked.store.missing).toEqual(["fact-1", "fact-2"]);
    expect(masked.store.verdicts).toEqual([]);
    expect(masked.store.memories).toEqual([]);
    expect(masked.store.recall).toBe(0.5);
    expect(masked.probes.map((probe) => probe.id)).toEqual(["probe-1", "probe-2"]);
    expect(masked.probes.map((probe) => probe.passed)).toEqual([true, false]);
    expect(masked.oracle).toEqual({ seeded: [], mismatches: ["fact-1"], preconditionMet: false });
    expect(maskHoldoutResult({ ...result, oracle: undefined }, "x").oracle).toBeUndefined();
    expect(JSON.stringify(masked)).not.toMatch(
      /indentation|tabs-rule|reversal-spaces|related|unknown/u,
    );
  });
});

describe("holdout options of the lab runner", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-holdout-options-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function values(extra = {}) {
    return {
      mode: "offline",
      out: join(root, "report"),
      holdout: join(root, "holdout.json"),
      "key-file": join(root, "holdout.key"),
      ...extra,
    };
  }

  it("takes a holdout instead of a scenario directory and never retains a body", () => {
    const options = normalizeOptions(values({ "retain-bodies": true }));
    expect(options.holdout).toEqual({
      file: join(root, "holdout.json"),
      keyFile: join(root, "holdout.key"),
    });
    expect(options.scenarios).toBeUndefined();
    expect(options.retainBodies).toBe(false);
    const plain = normalizeOptions({ mode: "offline", out: join(root, "plain") });
    expect(plain.holdout).toBeUndefined();
    expect(plain.scenarios).toBe(DEFAULT_SCENARIO_DIR.replace(/\/$/u, ""));
    expect(plain.retainBodies).toBe(true);
  });

  it.each([
    ["a scenario directory", { scenarios: "/somewhere" }, /mutually exclusive/u],
    ["kept instance state", { keep: true }, /--keep cannot be combined with --holdout/u],
    ["no key file", { "key-file": undefined }, /used together/u],
    ["a key file without a holdout", { holdout: undefined }, /used together/u],
    [
      "a holdout inside the checkout",
      { holdout: join(REPO_ROOT, "h.json") },
      /--holdout must lie outside/u,
    ],
    [
      "a key inside the checkout",
      { "key-file": join(REPO_ROOT, "h.key") },
      /--key-file must lie outside/u,
    ],
  ])("refuses a holdout together with %s", (_name, patch, pattern) => {
    expect(() => normalizeOptions(values(patch))).toThrow(pattern);
  });
});

describe("a sealed run against the real product", () => {
  let root;
  let temporary;
  let previousTmpdir;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-sealed-run-"));
    temporary = join(root, "tmp");
    mkdirSync(temporary);
    previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = temporary;
  });
  afterEach(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(root, { recursive: true, force: true });
  });

  function runOptions(name, extra) {
    return normalizeOptions({
      mode: "offline",
      out: join(root, name),
      repetitions: "1",
      "memory-mode": "governed-assist",
      ceiling: "governed-assist",
      "budget-tokens": "1200",
      keep: false,
      "generated-at": "0",
      "retain-bodies": true,
      "quiet-ms": "400",
      "max-wait-ms": "30000",
      "turn-timeout-ms": "60000",
      ...extra,
    });
  }

  it(
    "leaves aggregates under masked names and no text of the holdout in any file",
    async () => {
      const scenarios = join(root, "scenarios");
      mkdirSync(scenarios);
      writeFileSync(join(scenarios, "leak.json"), JSON.stringify(leakScenario()));
      const holdout = join(root, "sealed", "holdout.json");
      const keyFile = join(root, "keys", "holdout.key");
      sealHoldout({ scenarios, out: holdout, keyFile });
      rmSync(scenarios, { recursive: true });
      const lines = [];
      const options = runOptions("report", {
        holdout,
        "key-file": keyFile,
        arms: "product,oracle",
      });
      const summary = await runLab(options, (line) => lines.push(line));
      expect(summary.runs).toBe(2);
      expect(lines.at(-1)).toMatch(
        /^PASS memory-lab runs=2 hard-counters=\S+ oracle-counters=\S+ oracle=\S+$/u,
      );
      // The failure this pins: a sealed run printed `probes=x/y` for every unit, so a watcher saw
      // the result of each hidden conversation one by one. It shows that a unit finished, no more.
      expect(lines.slice(0, -1)).toEqual(["holdout unit 1 done", "holdout unit 2 done"]);
      expect(lines.join("\n").toLowerCase()).not.toContain("zebrafink");

      const report = join(root, "report");
      expect(readdirSync(report).toSorted()).toEqual([
        "evidence-scan.json",
        "manifest.json",
        "scorecard.json",
        "summary.json",
        "summary.md",
        "timing.json",
      ]);
      expect(leaks(report)).toEqual([]);
      // A hidden conversation's length must not show: no per-turn latencies, no call counts.
      const timing = JSON.parse(readFileSync(join(report, "timing.json"), "utf8"));
      expect(timing).toHaveLength(2);
      for (const row of timing) {
        expect(Object.keys(row).toSorted()).toEqual([
          "arm",
          "failed",
          "meanInstanceStartMs",
          "meanLearnMs",
          "meanProbeMs",
          "repetition",
          "units",
        ]);
      }
      // The failure this pins: the scorecard carried one entry per unit and probe under a stable
      // masked name, so an optimizer could follow single hidden scenarios from candidate to
      // candidate. A sealed run records groups, and one scenario is fewer than a group needs.
      const card = JSON.parse(readFileSync(join(report, "scorecard.json"), "utf8"));
      const names = card.scenarios.map((entry) => entry.name);
      expect(names.toSorted()).toEqual([
        "holdout:other:de:oracle:r0:group",
        "holdout:other:de:product:r0:group",
      ]);
      expect(names.some((name) => /[0-9a-f]{12}/u.test(name))).toBe(false);
      const group = card.scenarios.find((entry) => entry.name.includes(":product:"));
      expect(group.metrics.map((entry) => entry.name)).toEqual(
        expect.arrayContaining([
          "units",
          "precisionCount",
          "recallCount",
          "answerTotal",
          "abstainTotal",
          "noMemoryTotal",
        ]),
      );
      const manifest = JSON.parse(readFileSync(join(report, "manifest.json"), "utf8"));
      expect(manifest.metadata.holdout).toBe(true);
      expect(manifest.metadata.sealed).toBe(true);
      expect(manifest.entries[0].id).toMatch(/^holdout:preference:de:[0-9a-f]{12}$/u);
      const markdown = readFileSync(join(report, "summary.md"), "utf8");
      expect(markdown).toContain("| product/other |");
      expect(sealedStateDirectories(temporary)).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "finds the same words in an ordinary run of the same scenario, so the scan can fail",
    async () => {
      const scenarios = join(root, "scenarios");
      mkdirSync(scenarios);
      writeFileSync(join(scenarios, "leak.json"), JSON.stringify(leakScenario()));
      await runLab(runOptions("open", { scenarios, arms: "product" }), () => undefined);
      const found = leaks(join(root, "open"));
      expect(found.length).toBeGreaterThan(0);
      expect(new Set(found.map(([, needle]) => needle))).toContain("Zebrafink");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "records a sealed unit that cannot run by its masked name and the error's name alone",
    async () => {
      const scenarios = join(root, "scenarios");
      mkdirSync(scenarios);
      writeFileSync(join(scenarios, "leak.json"), JSON.stringify(leakScenario()));
      const holdout = join(root, "sealed", "holdout.json");
      const keyFile = join(root, "keys", "holdout.key");
      sealHoldout({ scenarios, out: holdout, keyFile });
      const options = runOptions("failing", { holdout, "key-file": keyFile, arms: "product" });
      const failing = { ...options, subjectRoot: join(root, "no-such-checkout") };
      const lines = [];
      const summary = await runLab(failing, (line) => lines.push(line));
      expect(summary.failedUnits).toBe(1);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^holdout unit 1 failed \(\w+\)$/u);
      expect(lines[1]).toMatch(/^FAIL memory-lab runs=1 .* failed-units=1$/u);
      const report = join(root, "failing");
      expect(leaks(report)).toEqual([]);
      expect(lines.join("\n").toLowerCase()).not.toContain("zebrafink");
      const card = JSON.parse(readFileSync(join(report, "scorecard.json"), "utf8"));
      expect(card.scenarios).toHaveLength(1);
      expect(card.scenarios[0].name).toBe("holdout:other:de:product:r0:group");
      expect(card.scenarios[0]).toMatchObject({ passed: false, evidence: "units=1 failed=1" });
      const unit = summary.failedUnitList[0];
      expect(unit.scenario).toMatch(/^holdout:preference:de:[0-9a-f]{12}$/u);
      expect(sealedStateDirectories(temporary)).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );
});
