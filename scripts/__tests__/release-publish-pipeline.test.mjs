// Regression gate for the publish/verify pipeline in scripts/release-publish.mjs
// (finding GEN-TEST-RELEASE-GATE-006). release-publish.mjs is THE production npm
// publish orchestrator invoked by .github/workflows/release.yml. Its publish path —
// the "already published?" E404 heuristic, the publish-then-tag ordering, and the
// post-publish dist-tag verification — is only reachable by shelling out to `npm`,
// `gh`, and `git`, and the module exports nothing. Prior coverage only exercised
// argument validation.
//
// This suite drives the REAL orchestrator as a subprocess (the same seam the existing
// release-impact governance test uses) but prepends a temp dir of stub `npm`/`gh`/`git`
// executables to PATH. Because release-publish.mjs spawns every external tool by name
// (commandResult("npm", ...), gh([...]), commandResult("git", ...)), the stubs intercept
// all of them. The stubs record every invocation to a log file and emit scripted
// stdout/exit codes, so we can assert on the DECISIONS the orchestrator makes and the
// ORDER of the calls — never on source text.
//
// The stubs also gate off the network entirely: `npm view/publish/dist-tag` never touch
// a registry, and the GitHub release-owner approval check (which normally runs
// `gh api repos/.../reviews/...`) is answered by the stub `gh`. The registry stays a
// bogus default and no real credentials are used. Nothing can be published anywhere.
//
// Scenarios exercised against the real code:
//   A. Fresh publish — `npm view <spec> version` returns E404 (unpublished) -> the
//      orchestrator PUBLISHes, then adds the dist-tag, then verifies. Red-on-defect:
//      if the E404 heuristic were broken (treating E404 as "already there"), publish
//      would be skipped and the recorded call sequence would lose the `npm publish`.
//   B. Already published — `npm view <spec> version` already returns the target version
//      -> the orchestrator SKIPs publish but still verifies the dist-tag. Red-on-defect:
//      a broken skip-path would re-invoke `npm publish` (the stub fails hard if it does).
//   C. Dist-tag mismatch — after publish, `npm view <name> dist-tags.<tag>` keeps
//      pointing at the wrong version -> verifyPackage MUST fail the release (exit 1).
//      Red-on-defect: if the dist-tag comparison were dropped, the release would
//      falsely report PASS.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The orchestrator reads the release version from the live root manifest at runtime,
// so the stubs must answer with that same version rather than a hardcoded one. This
// keeps the gate correct across version bumps.
const ROOT_MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const RELEASE_VERSION = ROOT_MANIFEST.version;
const RELEASE_NAME = ROOT_MANIFEST.name;
const RELEASE_SPEC = `${RELEASE_NAME}@${RELEASE_VERSION}`;

// A deterministic sha the stub `git` returns for both `rev-parse HEAD` and
// `rev-parse v<version>^{}`, so ensureReleaseTag() sees HEAD === tag and proceeds.
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

// Shared prologue injected into each stub: append-only call log + tiny JSON state file
// so a stub can flip "published"/"tagged" as the orchestrator drives it.
function stubPrologue(logFile, stateFile) {
  return [
    'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
    `const LOG = ${JSON.stringify(logFile)};`,
    `const STATE = ${JSON.stringify(stateFile)};`,
    `const VERSION = ${JSON.stringify(RELEASE_VERSION)};`,
    "const argv = process.argv.slice(2);",
    "function log(bin) { appendFileSync(LOG, bin + ' ' + JSON.stringify(argv) + '\\n'); }",
    "function state() { return JSON.parse(readFileSync(STATE, 'utf8')); }",
    "function setState(patch) { writeFileSync(STATE, JSON.stringify({ ...state(), ...patch })); }",
    "",
  ].join("\n");
}

// Stub `gh`: answers the release-owner approval probe (gh api .../reviews/...) with an
// APPROVED review by the allowed owner, reports the GitHub release as absent so the
// create path runs, and accepts create/edit. All offline.
function ghStubBody() {
  return [
    'log("gh");',
    "const sub = argv[0];",
    'if (sub === "api") {',
    '  process.stdout.write(JSON.stringify({ state: "APPROVED", user: { login: "release-owner" } }));',
    "  process.exit(0);",
    "}",
    'if (sub === "release" && argv[1] === "view") { process.exit(1); }',
    "process.exit(0);",
  ].join("\n");
}

// Stub `git`: a clean tree (diff --quiet exits 0) and a matching HEAD/tag sha so the
// pre-publish safety checks pass without touching the real repository state.
function gitStubBody() {
  return [
    'log("git");',
    "const sub = argv[0];",
    'if (sub === "diff") { process.exit(0); }',
    'if (sub === "rev-parse") { process.stdout.write(' +
      JSON.stringify(HEAD_SHA) +
      ' + "\\n"); process.exit(0); }',
    'if (sub === "remote") { process.stdout.write("git@github.com:oscharko-dev/Keiko.git\\n"); process.exit(0); }',
    "process.exit(0);",
  ].join("\n");
}

function makeStub(binDir, name, body, logFile, stateFile) {
  const path = join(binDir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${stubPrologue(logFile, stateFile)}${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

// Run the real scripts/release-publish.mjs with stub npm/gh/git prepended to PATH.
// `npmBody` is the stub-`npm` behaviour under test; `initState` seeds the publish state.
// Returns the exit status, stdout/stderr, and the ordered list of intercepted calls.
function runPublish({ npmBody, initState }) {
  const binDir = mkdtempSync(join(tmpdir(), "keiko-release-publish-stub-"));
  const logFile = join(binDir, "calls.log");
  const stateFile = join(binDir, "state.json");
  writeFileSync(logFile, "", "utf8");
  writeFileSync(stateFile, JSON.stringify(initState), "utf8");

  makeStub(binDir, "npm", npmBody, logFile, stateFile);
  makeStub(binDir, "gh", ghStubBody(), logFile, stateFile);
  makeStub(binDir, "git", gitStubBody(), logFile, stateFile);

  const env = {
    ...process.env,
    PATH: binDir + delimiter + process.env.PATH,
    // Satisfy the release-owner approval gate offline: the repository must match the
    // approval references in the live catalog, and the reviewer login must be allowed.
    GITHUB_REPOSITORY: "oscharko-dev/Keiko",
    KEIKO_RELEASE_OWNER_GITHUB_LOGINS: "release-owner",
    // Deterministic npmrc generation; the stub npm never uses this token.
    NPM_CONFIG_STRICT_SSL: "true",
    NODE_AUTH_TOKEN: "stub-token-never-sent",
    KEIKO_RELEASE_VERIFY_ATTEMPTS: "3",
    KEIKO_RELEASE_VERIFY_DELAY_MS: "0",
  };
  // GH_TOKEN would be forwarded to the stub gh; drop it so nothing real is carried.
  Reflect.deleteProperty(env, "GH_TOKEN");

  const result = spawnSync(process.execPath, ["scripts/release-publish.mjs", "--tag", "latest"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });

  const calls = readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  rmSync(binDir, { recursive: true, force: true });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

// A stub `npm` that shares the config/gate scaffolding and lets each scenario plug in the
// `view` behaviour that is actually under test.
function npmStub(viewBody, { failOnPublish = false } = {}) {
  return [
    'log("npm");',
    "const sub = argv[0];",
    // strict-ssl probe from createNpmEnvironment().
    'if (sub === "config" && argv[1] === "get" && argv[2] === "strict-ssl") { process.stdout.write("true\\n"); process.exit(0); }',
    // All `npm run <gate>` invocations (version-consistency, publish-manifests,
    // release-impact, prepack, smoke) succeed so control reaches the publish loop.
    'if (sub === "run") { process.exit(0); }',
    'if (sub === "view") {',
    viewBody,
    "}",
    'if (sub === "publish") {',
    failOnPublish
      ? '  process.stderr.write("stub npm: publish must not run when the version already exists\\n"); process.exit(97);'
      : "  setState({ published: true }); process.exit(0);",
    "}",
    'if (sub === "dist-tag" && argv[1] === "add") { setState({ tagged: true }); process.exit(0); }',
    'process.stderr.write("stub npm: unhandled " + JSON.stringify(argv) + "\\n");',
    "process.exit(3);",
  ].join("\n");
}

const indexOfCall = (calls, predicate) => calls.findIndex(predicate);
const isView = (line) => line.startsWith('npm ["view"');
const isVersionView = (line) => isView(line) && line.includes('"version"');
const isDistTagView = (line) => isView(line) && line.includes("dist-tags.");

describe("release-publish pipeline (real orchestrator, stubbed npm/gh/git)", () => {
  let lastRun;

  afterEach(() => {
    lastRun = undefined;
  });

  it("treats an E404 from `npm view … version` as unpublished and publishes, tags, then verifies", () => {
    // `npm view <spec> version` fails with E404 until a publish has happened; the
    // dist-tag view reports the wrong version until `npm dist-tag add` runs.
    const viewBody = [
      "  const s = state();",
      '  if (argv.includes("version")) {',
      "    if (!s.published) {",
      // Real npm E404 shape; the heuristic scans for "E404" / "No match found".
      '      process.stderr.write("npm error code E404\\nnpm error 404 Not Found - GET " + argv[1] + "\\n");',
      "      process.exit(1);",
      "    }",
      '    process.stdout.write(VERSION + "\\n");',
      "    process.exit(0);",
      "  }",
      '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
      '    process.stdout.write((s.tagged ? VERSION : "0.0.0-stale") + "\\n");',
      "    process.exit(0);",
      "  }",
    ].join("\n");

    lastRun = runPublish({ npmBody: npmStub(viewBody), initState: { published: false } });

    expect(lastRun.status).toBe(0);
    expect(lastRun.stdout).toContain(`PUBLISH ${RELEASE_SPEC}`);
    expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
    // It must NOT have short-circuited as already-present.
    expect(lastRun.stdout).not.toContain(`SKIP ${RELEASE_SPEC} already exists`);

    // Decision order: check existence -> publish -> add dist-tag -> re-verify existence -> re-verify dist-tag.
    const firstVersionView = indexOfCall(lastRun.calls, isVersionView);
    const publishCall = indexOfCall(lastRun.calls, (l) => l.startsWith('npm ["publish"'));
    const distTagAdd = indexOfCall(lastRun.calls, (l) => l.startsWith('npm ["dist-tag","add"'));

    expect(firstVersionView).toBeGreaterThanOrEqual(0);
    expect(publishCall).toBeGreaterThan(firstVersionView);
    expect(distTagAdd).toBeGreaterThan(publishCall);

    // Publish carries the release-safety flags on the real command line.
    const publishLine = lastRun.calls.find((l) => l.startsWith('npm ["publish"'));
    expect(publishLine).toContain('"--access","public"');
    expect(publishLine).toContain('"--tag","latest"');
    expect(publishLine).toContain('"--provenance"');
    expect(publishLine).toContain('"--ignore-scripts"');
    expect(publishLine).not.toContain('"--dry-run"');

    // The post-publish verification pass re-reads BOTH the version and the dist-tag.
    const versionViews = lastRun.calls.filter(isVersionView).length;
    const distTagViews = lastRun.calls.filter(isDistTagView).length;
    expect(versionViews).toBeGreaterThanOrEqual(2);
    expect(distTagViews).toBeGreaterThanOrEqual(2);
  });

  it("skips publishing when `npm view … version` already reports the target version, yet still verifies the dist-tag", () => {
    // Version is already present and the dist-tag already points at it. A correct
    // orchestrator must NOT publish again; the stub publish path fails hard if it does.
    const viewBody = [
      '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
    ].join("\n");

    lastRun = runPublish({
      npmBody: npmStub(viewBody, { failOnPublish: true }),
      initState: { published: true, tagged: true },
    });

    expect(lastRun.status).toBe(0);
    expect(lastRun.stdout).toContain(`SKIP ${RELEASE_SPEC} already exists`);
    expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);

    // Proof the skip actually held: `npm publish` was never invoked.
    expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);

    // Verification still runs: the dist-tag is re-read even on the skip path.
    expect(lastRun.calls.some(isDistTagView)).toBe(true);
  });

  it("retries post-publish registry visibility before failing the release", () => {
    // Real npm can accept the publish and dist-tag update before every registry view
    // endpoint sees the new version. The release must wait for propagation instead of
    // turning a successful publish into a red workflow.
    const viewBody = [
      "  const s = state();",
      '  if (argv.includes("version")) {',
      "    if (!s.published) { process.stderr.write('npm error code E404\\n'); process.exit(1); }",
      "    const attempts = s.versionVerifyAttempts ?? 0;",
      "    if (attempts === 0) {",
      "      setState({ versionVerifyAttempts: attempts + 1 });",
      "      process.stderr.write('npm error code E404\\n');",
      "      process.exit(1);",
      "    }",
      '    process.stdout.write(VERSION + "\\n");',
      "    process.exit(0);",
      "  }",
      '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
      '    process.stdout.write(VERSION + "\\n");',
      "    process.exit(0);",
      "  }",
    ].join("\n");

    lastRun = runPublish({ npmBody: npmStub(viewBody), initState: { published: false } });

    expect(lastRun.status).toBe(0);
    expect(lastRun.stdout).toContain(`PUBLISH ${RELEASE_SPEC}`);
    expect(lastRun.stdout).toContain(`VERIFY pending ${RELEASE_SPEC}`);
    expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
    expect(lastRun.calls.filter(isVersionView).length).toBeGreaterThanOrEqual(3);
  });

  it("fails the release when the dist-tag never resolves to the published version", () => {
    // Version publishes fine, but `npm view <name> dist-tags.latest` keeps pointing at a
    // different version — verifyPackage() must reject this and exit non-zero.
    const viewBody = [
      "  const s = state();",
      '  if (argv.includes("version")) {',
      '    if (!s.published) { process.stderr.write("npm error code E404\\n"); process.exit(1); }',
      '    process.stdout.write(VERSION + "\\n");',
      "    process.exit(0);",
      "  }",
      // Deliberately wrong dist-tag forever, even after `dist-tag add`.
      '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write("9.9.9-wrong\\n"); process.exit(0); }',
    ].join("\n");

    lastRun = runPublish({ npmBody: npmStub(viewBody), initState: { published: false } });

    expect(lastRun.status).toBe(1);
    expect(lastRun.stderr).toContain(`${RELEASE_NAME}@latest points to 9.9.9-wrong`);
    expect(lastRun.stderr).toContain(`expected ${RELEASE_VERSION}`);
    // It must not have reported success.
    expect(lastRun.stdout).not.toContain("PASS -");
  });
});
