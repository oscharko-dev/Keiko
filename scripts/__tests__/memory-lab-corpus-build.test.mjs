// Corpus builder (#4208): scenarios and a manifest of versions and digests are written outside the
// checkout, never over an existing corpus, and nothing is written when a conversation fails.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blueprintDigest,
  loadBlueprintDirectory,
} from "../testing/memory-lab/corpus/blueprint.mjs";
import {
  DEFAULT_BLUEPRINT_DIR,
  GENERATOR_VERSION,
  normalizeBuildOptions,
  runBuild,
} from "../testing/memory-lab/corpus/build.mjs";
import { FACT_MARKER } from "../testing/memory-lab/corpus/writer-port.mjs";
import { createModelWriter } from "../testing/memory-lab/corpus/writer-model.mjs";
import { createScriptedWriter } from "../testing/memory-lab/corpus/writer-scripted.mjs";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import { corpusVariety } from "../testing/memory-lab/corpus/variety-report.mjs";
import { varietyReport } from "../testing/memory-lab/corpus/variety.mjs";
import { loadScenarioDirectory, scenarioSetManifest } from "../testing/memory-lab/scenario.mjs";
import { fixtureBlueprint } from "./support/memory-lab-corpus-fixture.mjs";

const BUILD_SCRIPT = fileURLToPath(
  new URL("../testing/memory-lab/corpus/build.mjs", import.meta.url),
);
const quiet = () => undefined;

function fixtureDirectory(root) {
  const directory = join(root, "blueprints");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "fixture.json"), JSON.stringify(fixtureBlueprint()));
  return directory;
}

describe("corpus build", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-build-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function options(name, extra = {}) {
    return normalizeBuildOptions({
      blueprints: fixtureDirectory(root),
      out: join(root, name),
      sizes: "100,200",
      seed: "11",
      ...extra,
    });
  }

  it("writes one scenario per blueprint and size plus a manifest of versions and digests", async () => {
    const built = options("corpus");
    const manifest = await runBuild(built, quiet);
    expect(manifest.count).toBe(2);
    expect(manifest.sizes).toEqual([100, 200]);
    expect(manifest.seed).toBe(11);
    expect(manifest.generatorVersion).toBe(GENERATOR_VERSION);
    expect(manifest.setDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.corpusVersion).toBe(`corpus-v1-${manifest.setDigest.slice(0, 12)}`);
    expect(manifest.writer).toEqual({ kind: "scripted", id: "scripted", label: "scripted" });
    const onDisk = JSON.parse(readFileSync(join(built.out, "manifest.json"), "utf8"));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(manifest)));
    const loaded = loadScenarioDirectory(join(built.out, "scenarios"));
    expect(loaded.map((scenario) => scenario.id)).toEqual([
      "en-fixture-01-m100",
      "en-fixture-01-m200",
    ]);
    expect(scenarioSetManifest(loaded).setDigest).toBe(manifest.setDigest);
    for (const entry of manifest.entries) {
      expect(entry.file).toBe(`scenarios/${entry.id}.json`);
      // The size is a floor: a person with more parts than the turns can hold grows past it.
      expect(entry.messages).toBeGreaterThanOrEqual(entry.size);
      expect(entry.generator).toBe("scripted");
      expect(Object.keys(entry.hardness).toSorted()).toEqual([
        "embedded",
        "noisy",
        "plain",
        "split",
      ]);
    }
  });

  it("records the blueprints with their digests and the variety figures of the set", async () => {
    const manifest = await runBuild(options("corpus"), quiet);
    const [blueprint] = loadBlueprintDirectory(join(root, "blueprints"));
    expect(manifest.blueprints).toEqual([
      {
        id: "en-fixture-01",
        language: "en",
        role: "analyst",
        digest: blueprintDigest(blueprint),
        facts: 7,
        changes: 1,
        forgets: 1,
        traps: 4,
        relational: 1,
      },
    ]);
    expect(manifest.variety.userTurns).toBe(150);
    expect(manifest.variety.nearDuplicate.rate).toBeGreaterThanOrEqual(0);
    expect(manifest.variety.generators).toEqual([
      { generator: "scripted", scenarios: 2, userTurns: 150, share: 1 },
    ]);
    expect(manifest.variety.turnLength.min).toBeGreaterThan(0);
    expect(manifest.variety.typeTokenRatio).toBeGreaterThan(0);
  });

  it("is reproducible: the same options give the same corpus, another seed another version", async () => {
    const first = await runBuild(options("first"), quiet);
    const second = await runBuild(options("second"), quiet);
    expect(readFileSync(join(root, "first", "manifest.json"), "utf8")).toBe(
      readFileSync(join(root, "second", "manifest.json"), "utf8"),
    );
    expect(second.corpusVersion).toBe(first.corpusVersion);
    const reseeded = await runBuild(options("third", { seed: "12" }), quiet);
    expect(reseeded.corpusVersion).not.toBe(first.corpusVersion);
  });

  it("refuses to overwrite an existing corpus and leaves it untouched", async () => {
    const built = options("corpus");
    await runBuild(built, quiet);
    const before = readFileSync(join(built.out, "manifest.json"), "utf8");
    await expect(runBuild(built, quiet)).rejects.toThrow(
      /refusing to overwrite an existing corpus/u,
    );
    expect(readFileSync(join(built.out, "manifest.json"), "utf8")).toBe(before);
  });

  it("refuses to overwrite a scenario file even when no manifest exists", async () => {
    const built = options("partial");
    mkdirSync(join(built.out, "scenarios"), { recursive: true });
    writeFileSync(join(built.out, "scenarios", "en-fixture-01-m100.json"), "{}");
    await expect(runBuild(built, quiet)).rejects.toThrow(/refusing to overwrite the scenario/u);
    expect(readFileSync(join(built.out, "scenarios", "en-fixture-01-m100.json"), "utf8")).toBe(
      "{}",
    );
  });

  it("writes nothing when a conversation fails its validation", async () => {
    const built = options("failed");
    const base = createScriptedWriter();
    const dropping = {
      ...base,
      id: "faulty",
      paragraph: async (request) => (await base.paragraph(request)).replace(FACT_MARKER, ""),
    };
    await expect(runBuild(built, quiet, { createWriter: () => dropping })).rejects.toThrow(
      /fact marker/u,
    );
    expect(existsSync(join(built.out, "manifest.json"))).toBe(false);
    expect(existsSync(join(built.out, ".progress"))).toBe(false);
  });

  it("keeps completed scenarios on interruption and resumes without regenerating them (#4247)", async () => {
    const built = options("interrupted");
    await expect(
      runBuild(built, () => {
        throw new Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    expect(existsSync(join(built.out, ".progress", "manifest.json"))).toBe(true);
    expect(existsSync(join(built.out, "manifest.json"))).toBe(false);
    const lines = [];
    const resumed = await runBuild({ ...built, resume: true }, (line) => lines.push(line));
    expect(resumed.count).toBe(2);
    expect(lines.join("\n")).not.toContain("generated en-fixture-01-m100:");
    const fresh = await runBuild(options("fresh"), quiet);
    expect(resumed.setDigest).toBe(fresh.setDigest);
  });

  it("refuses an empty blueprint directory", async () => {
    const empty = join(root, "none");
    mkdirSync(empty);
    const built = normalizeBuildOptions({ blueprints: empty, out: join(root, "out") });
    await expect(runBuild(built, quiet)).rejects.toThrow(/holds no blueprint/u);
  });

  it("builds from the curated blueprints, one scenario per person and size", async () => {
    const built = normalizeBuildOptions({ out: join(root, "curated"), sizes: "100", seed: "5" });
    expect(built.blueprints).toBe(DEFAULT_BLUEPRINT_DIR);
    const manifest = await runBuild(built, quiet);
    const languages = manifest.blueprints.map((blueprint) => blueprint.language);
    expect(manifest.count).toBe(12);
    expect(languages.filter((language) => language === "de")).toHaveLength(6);
    expect(languages.filter((language) => language === "en")).toHaveLength(6);
    expect(readdirSync(join(built.out, "scenarios"))).toHaveLength(12);
  });
});

describe("corpus build with a model writer", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-build-model-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function fakeFetch(calls) {
    return async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, headers: init.headers, body });
      const prompt = body.messages.at(-1).content;
      const count = Number(/Write (\d+) /u.exec(prompt)?.[1] ?? 10);
      let items;
      if (prompt.includes("independent exchanges"))
        items = Array.from({ length: count }, (_, index) => ({
          user: `Could you outline step ${String(index)} of the rollout plan?`,
          assistant: `Here is an outline for step ${String(index)}.`,
        }));
      else if (prompt.includes(FACT_MARKER))
        items = Array.from(
          { length: count },
          (_, index) => `Today is busy number ${String(index)}. ${FACT_MARKER} Thanks for helping.`,
        );
      else
        items = Array.from({ length: count }, (_, index) => `Neutral sentence ${String(index)}.`);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(items) } }] }),
      };
    };
  }

  it("reads the API key from the named variable, labels the generator and keeps both secrets out of the manifest", async () => {
    const calls = [];
    vi.stubGlobal("fetch", fakeFetch(calls));
    const built = normalizeBuildOptions({
      blueprints: fixtureDirectory(root),
      out: join(root, "model"),
      sizes: "100",
      writer: "model",
      endpoint: "http://127.0.0.1:4000/v1",
      model: "lab-model-a",
      "api-key-env": "LAB_TEST_GENERATOR_KEY",
      "generator-label": "lab-model-a@4000",
    });
    const manifest = await runBuild(built, quiet, {
      env: { LAB_TEST_GENERATOR_KEY: "secret-key-123" },
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.headers.authorization === "Bearer secret-key-123")).toBe(
      true,
    );
    expect(manifest.writer).toEqual({
      kind: "model",
      id: "model:lab-model-a",
      label: "lab-model-a@4000",
      model: "lab-model-a",
      reasoningTokens: 8192,
    });
    expect(manifest.variety.generators[0].generator).toBe("lab-model-a@4000");
    const [scenario] = loadScenarioDirectory(join(built.out, "scenarios"));
    expect(scenario.description).toContain("Generator lab-model-a@4000;");
    const text = readFileSync(join(built.out, "manifest.json"), "utf8");
    expect(text).not.toContain("secret-key-123");
    expect(text).not.toContain("127.0.0.1");
  });

  it("can opt out of reasoning allowance for a capped nonreasoning endpoint", async () => {
    const calls = [];
    const fetchImpl = fakeFetch(calls);
    vi.stubGlobal("fetch", async (url, init) => {
      if (JSON.parse(init.body).max_tokens > 4096) return { ok: false, status: 400 };
      return fetchImpl(url, init);
    });
    const built = normalizeBuildOptions({
      blueprints: fixtureDirectory(root),
      out: join(root, "capped"),
      sizes: "100",
      writer: "model",
      endpoint: "http://127.0.0.1:4000/v1",
      model: "capped-model",
      "reasoning-tokens": "0",
    });
    const manifest = await runBuild(built, quiet);
    expect(calls.length).toBeGreaterThan(0);
    expect(manifest.writer.reasoningTokens).toBe(0);
  });

  it("works without a key and accepts an injected writer", async () => {
    const calls = [];
    const writer = createModelWriter({
      endpoint: "http://127.0.0.1:4000/v1",
      model: "lab-model-b",
      fetchImpl: fakeFetch(calls),
    });
    const built = normalizeBuildOptions({
      blueprints: fixtureDirectory(root),
      out: join(root, "injected"),
      sizes: "100",
    });
    const manifest = await runBuild(built, quiet, { createWriter: () => writer });
    expect(manifest.count).toBe(1);
    expect(calls.every((call) => call.headers.authorization === undefined)).toBe(true);
  });
});

describe("corpus build options", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-build-options-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(["-1", "1.5", "65537", "NaN", "Infinity"])(
    "refuses invalid reasoning allowance %s",
    (value) => {
      expect(() =>
        normalizeBuildOptions({ out: join(root, "out"), "reasoning-tokens": value }),
      ).toThrow(/reasoning tokens/u);
    },
  );

  it("accepts a complete scripted configuration with defaults", () => {
    const built = normalizeBuildOptions({ out: join(root, "out") });
    expect(built).toMatchObject({ sizes: [100], seed: 1, writer: "scripted", timeoutMs: 120000 });
    expect(built.generatorLabel).toBeUndefined();
  });

  it("refuses an output directory inside the checkout, also through a symbolic link", () => {
    expect(() => normalizeBuildOptions({ out: join(REPO_ROOT, "corpus-out") })).toThrow(
      /--out must lie outside the checkout/u,
    );
    const link = join(root, "link");
    symlinkSync(join(REPO_ROOT, "scripts"), link);
    expect(() => normalizeBuildOptions({ out: join(link, "corpus-out") })).toThrow(
      /--out must lie outside the checkout/u,
    );
    const dangling = join(root, "dangling");
    symlinkSync(join(REPO_ROOT, "scripts", "not-yet-created"), dangling);
    expect(() => normalizeBuildOptions({ out: join(dangling, "corpus-out") })).toThrow(
      /--out must lie outside the checkout/u,
    );
    expect(normalizeBuildOptions({ out: "/memory-lab-root-level-output" }).out).toBe(
      "/memory-lab-root-level-output",
    );
    expect(() => normalizeBuildOptions({ out: "" })).toThrow(/--out is required/u);
    expect(() => normalizeBuildOptions({})).toThrow(/--out is required/u);
  });

  it.each([
    [{ sizes: "abc" }, /--sizes must be an integer/u],
    [{ sizes: "5" }, /--sizes must be an integer >= 10/u],
    [{ sizes: "100,300000" }, /must not exceed/u],
    [{ seed: "-1" }, /--seed must be an integer/u],
    [{ seed: "x" }, /--seed must be an integer/u],
    [{ writer: "guess" }, /--writer must be one of/u],
    [{ writer: "model" }, /needs --endpoint and --model/u],
    [{ writer: "model", endpoint: "file:///tmp/endpoint", model: "m" }, /http\(s\) URL/u],
    [{ writer: "model", endpoint: "not a url", model: "m" }, /http\(s\) URL/u],
    [{ "timeout-ms": "0" }, /--timeout-ms must be an integer >= 1/u],
    [{ "generator-label": "bad\nlabel" }, /generator label/u],
  ])("refuses %j", (patch, pattern) => {
    expect(() => normalizeBuildOptions({ out: join(root, "out"), ...patch })).toThrow(pattern);
  });

  it("sorts and de-duplicates the sizes", () => {
    expect(normalizeBuildOptions({ out: join(root, "out"), sizes: "1000, 100,100" }).sizes).toEqual(
      [100, 1000],
    );
  });
});

describe("corpus build command line", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-build-cli-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(args) {
    return spawnSync(process.execPath, [BUILD_SCRIPT, ...args], {
      encoding: "utf8",
      timeout: 60000,
    });
  }

  it("prints its usage", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/usage: node scripts\/testing\/memory-lab\/corpus\/build\.mjs/u);
  });

  it("refuses an output directory inside the checkout with a plain message", () => {
    const result = run(["--out", join(REPO_ROOT, "corpus-out")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--out must lie outside the checkout/u);
    expect(existsSync(join(REPO_ROOT, "corpus-out"))).toBe(false);
  });

  it("builds a corpus and ends with the deterministic harness line", () => {
    const out = join(root, "cli");
    const result = run(["--blueprints", fixtureDirectory(root), "--out", out, "--sizes", "100"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^PASS memory-lab-corpus scenarios=1 version=corpus-v1-[0-9a-f]{12} nearDuplicateRate=\S+$/mu,
    );
    expect(existsSync(join(out, "manifest.json"))).toBe(true);
    expect(run(["--blueprints", fixtureDirectory(root), "--out", out]).status).not.toBe(0);
  });
});

describe("variety report over several corpora", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-variety-report-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function built(name, extra) {
    const options = normalizeBuildOptions({
      blueprints: fixtureDirectory(root),
      out: join(root, name),
      sizes: "100,200",
      ...extra,
    });
    await runBuild(options, quiet);
    return options.out;
  }

  it("reports the union of two generators' corpora, with each generator's share", async () => {
    const first = await built("first", { seed: "1", "generator-label": "generator-a" });
    const second = await built("second", { seed: "2", "generator-label": "generator-b" });
    const report = corpusVariety([first, second]);
    expect(report.corpusVersions).toHaveLength(2);
    expect(report.userTurns).toBe(300);
    expect(report.generators).toEqual([
      { generator: "generator-a", scenarios: 2, userTurns: 150, share: 0.5 },
      { generator: "generator-b", scenarios: 2, userTurns: 150, share: 0.5 },
    ]);
    const records = [first, second].flatMap((directory, index) =>
      loadScenarioDirectory(join(directory, "scenarios")).map((scenario) => ({
        generator: index === 0 ? "generator-a" : "generator-b",
        userTexts: scenario.turns.map((turn) => turn.user),
      })),
    );
    expect(report).toMatchObject(varietyReport(records));
    const alone = corpusVariety([first]);
    expect(alone.nearDuplicate.turns).toBe(150);
    expect(report.nearDuplicate.turns).toBe(300);
  });

  it("refuses a corpus without a manifest, an edited scenario and an entry outside the corpus", async () => {
    const corpus = await built("corpus", {});
    expect(() => corpusVariety([])).toThrow(/at least one directory/u);
    expect(() => corpusVariety([join(root, "nothing")])).toThrow(/manifest\.json is missing/u);
    const manifestPath = join(corpus, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        entries: [{ ...manifest.entries[0], file: "../manifest.json" }],
      }),
    );
    expect(() => corpusVariety([corpus])).toThrow(/points outside/u);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const scenarioFile = join(corpus, manifest.entries[0].file);
    const scenario = JSON.parse(readFileSync(scenarioFile, "utf8"));
    scenario.turns[0].user = "An edited first turn.";
    writeFileSync(scenarioFile, JSON.stringify(scenario));
    expect(() => corpusVariety([corpus])).toThrow(/differs from the digest in its manifest/u);
  });

  it("prints the report from the command line", async () => {
    const corpus = await built("cli", {});
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../testing/memory-lab/corpus/variety-report.mjs", import.meta.url)),
        "--corpus",
        corpus,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).userTurns).toBe(150);
  });
});
