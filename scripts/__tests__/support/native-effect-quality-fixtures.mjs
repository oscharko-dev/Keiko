import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runNativePolicy, runnerIdentity } from "../../lib/code-quality-runner.mjs";

// Historical #3988 Effect syntax/process controls only. No replacement-runtime qualification.
const imports = 'import { Context, Data, Effect, Exit, Layer, Match, Predicate } from "effect";';
const serviceModule = JSON.stringify("./services.mjs");

export const nativeEffectQualityFixtures = [
  {
    rule: "no-manual-effect-error-tag",
    expected: ["refused", true],
    safe: `${imports}
class Refused extends Data.TaggedError("Refused") {}
class Unhandled extends Data.TaggedError("Unhandled") {}
const recover = error => Effect.fail(error).pipe(
  Effect.catchTag("Refused", () => Effect.succeed("refused")));
export const qualify = async () => [await Effect.runPromise(recover(new Refused())),
  Exit.isFailure(await Effect.runPromiseExit(recover(new Unhandled())))];`,
    bad: `${imports}
class Refused extends Data.TaggedError("Refused") {}
class Unhandled extends Data.TaggedError("Unhandled") {}
const recover = error => Effect.fail(error).pipe(
  Effect.catch(error => error._tag === "Refused" ? Effect.succeed("refused") : Effect.fail(error)));
export const qualify = async () => [await Effect.runPromise(recover(new Refused())),
  Exit.isFailure(await Effect.runPromiseExit(recover(new Unhandled())))];`,
  },
  {
    rule: "no-manual-tag-comparison",
    expected: [true, false],
    safe: `${imports}
const { Ready, Refused } = Data.taggedEnum();
export const qualify = () => [Ready({ value: 1 }), Refused()].map(value => Match.value(value).pipe(
  Match.tagsExhaustive({ Ready: () => true, Refused: () => false })));`,
    bad: `${imports}
const { Ready, Refused } = Data.taggedEnum();
export const qualify = () => [Ready({ value: 1 }), Refused()].map(value => value._tag === "Ready");`,
  },
  {
    rule: "no-manual-tagged-construction",
    expected: 1,
    safe: `${imports}
const { Ready } = Data.taggedEnum();
export const qualify = () => Ready({ value: 1 }).value;`,
    bad: `${imports}
export const qualify = () => ({ _tag: "Ready", value: 1 }).value;`,
  },
  {
    rule: "no-service-constructor-imports",
    expected: 42,
    safe: `${imports}
import { Database, DatabaseLive } from ${serviceModule};
export const qualify = () => Effect.runPromise(Effect.gen(function* () {
  const database = yield* Database;
  return database.read();
}).pipe(Effect.provide(DatabaseLive)));`,
    bad: `${imports}
import { Database, makeDatabase } from ${serviceModule};
export const qualify = () => Effect.runPromise(Effect.gen(function* () {
  const database = yield* Database;
  return database.read();
}).pipe(Effect.provideService(Database, makeDatabase())));`,
  },
  {
    rule: "prefer-effect-match",
    expected: "ready",
    safe: `${imports}
export const qualify = () => Match.value("ready").pipe(
  Match.when("ready", () => "ready"), Match.when("refused", () => "refused"),
  Match.exhaustive);`,
    bad: `${imports}
export const qualify = () => {
  const state = "ready";
  return state === "ready" ? "ready" : state === "refused" ? "refused" : "invalid";
};`,
  },
];

export const nativeEffectServiceFixture = `${imports}
export const Database = Context.Service("KeikoNativeQualityDatabase");
export const makeDatabase = () => ({ read: () => 42 });
export const DatabaseLive = Layer.succeed(Database, makeDatabase());`;

// The archived harness refuses missing modules; injected outputs attest no product execution.
export function runNativeHostQualityProcess(executable, args, options) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.signal || result.status !== 0)
    throw new TypeError("native-host-qualification-process-failed");
  return result.stdout;
}

export function nativeHostQualityTarget(platform = process.platform, architecture = process.arch) {
  if (platform === "linux" && architecture === "x64") return "linux-x64";
  if (platform === "darwin" && ["arm64", "x64"].includes(architecture))
    return `macos-${architecture}`;
  throw new TypeError("native-host-qualification-platform-unsupported");
}

function writeFixtures(root) {
  writeFileSync(join(root, "services.mjs"), nativeEffectServiceFixture);
  const files = [{ path: "services.mjs" }];
  for (const fixture of nativeEffectQualityFixtures) {
    for (const category of ["safe", "bad"]) {
      const path = `${fixture.rule}-${category}.mjs`;
      writeFileSync(join(root, path), fixture[category]);
      files.push({ path });
    }
  }
  return files;
}

export function assertNativeEffectFixtureDiagnostics(result) {
  const findings = result.diagnostics.filter(({ rule }) => rule.startsWith("anti-slop-effect/"));
  for (const fixture of nativeEffectQualityFixtures) {
    if (findings.some(({ path }) => path === `${fixture.rule}-safe.mjs`))
      throw new TypeError("native-effect-safe-fixture-rejected");
    if (
      !findings.some(
        ({ path, rule }) =>
          path === `${fixture.rule}-bad.mjs` && rule === `anti-slop-effect/${fixture.rule}`,
      )
    )
      throw new TypeError("native-effect-rejected-fixture-accepted");
  }
}

export function qualifyNativeEffectFixtures(
  moduleRoot,
  nodeExecutable = process.execPath,
  execution = runNativeHostQualityProcess,
) {
  runnerIdentity();
  const root = mkdtempSync(join(tmpdir(), "keiko-native-effect-quality-"));
  try {
    symlinkSync(moduleRoot, join(root, "node_modules"), "junction");
    const files = writeFixtures(root);
    const result = runNativePolicy(root, files);
    assertNativeEffectFixtureDiagnostics(result);
    executeFixtures(root, nodeExecutable, execution);
    writeFileSync(join(root, "malformed.mjs"), "export const broken = (");
    let refused = false;
    try {
      runNativePolicy(root, [{ path: "malformed.mjs" }]);
    } catch (error) {
      // Syntax failures must not produce a visited/qualified fixture receipt.
      if (!(error instanceof TypeError) || error.message !== "unknown-diagnostic") throw error;
      refused = true;
    }
    if (!refused) throw new TypeError("native-effect-malformed-fixture-accepted");
    return {
      rules: nativeEffectQualityFixtures.length,
      visited: result.visited,
      malformedRefused: true,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function executeFixtures(root, nodeExecutable, execution) {
  for (const fixture of nativeEffectQualityFixtures) {
    for (const category of ["safe", "bad"]) {
      const path = `${fixture.rule}-${category}.mjs`;
      const moduleSpecifier = JSON.stringify("./" + path);
      const output = execution(
        nodeExecutable,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${moduleSpecifier}); console.log(JSON.stringify(await m.qualify()));`,
        ],
        { cwd: root, timeout: 30_000 },
      );
      if (!isDeepStrictEqual(JSON.parse(output), fixture.expected))
        throw new TypeError("native-effect-fixture-execution-mismatch");
    }
  }
}
