import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { recordContinuityBuild } from "../testing/coding-workbench-lab/chat-continuity-build.mjs";
import { replayContinuityCases } from "../testing/coding-workbench-lab/chat-continuity-replay.mjs";
import { continuityCorpusManifest } from "../testing/coding-workbench-lab/chat-continuity-corpus.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function subject(runtime) {
  const root = mkdtempSync(join(tmpdir(), "keiko-continuity-subject-"));
  roots.push(root);
  const put = (path, body) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  put(".gitignore", "node_modules\npackages/probe/dist\n");
  put("package.json", '{"name":"synthetic-subject","private":true}');
  put("tsconfig.packages.json", '{"references":[{"path":"./packages/probe/tsconfig.json"}]}');
  put("packages/probe/tsconfig.json", "{}");
  put("packages/probe/dist/index.js", "export const probe = 1;");
  put("node_modules/@typescript/native/package.json", '{"version":"7.0.2"}');
  put("scripts/testing/helper.mjs", "export const helper = true;");
  put(
    "scripts/testing/coding-workbench-lab/chat-continuity-runtime.mjs",
    `import "../helper.mjs";\n${runtime}`,
  );
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git(["init"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "synthetic fixture",
  ]);
  recordContinuityBuild(root, () => undefined);
  return root;
}

function run(root) {
  const config = join(root, "config.private.json");
  writeFileSync(config, "{}");
  const output = join(root, "result");
  const script = fileURLToPath(
    new URL("../testing/coding-workbench-lab/chat-continuity-run.mjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--subject-root",
      root,
      "--phase",
      "baseline",
      "--config",
      config,
      "--output",
      output,
      "--duration-ms",
      "0",
      "--cycles",
      "0",
      "--repetitions",
      "0",
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  return { result, output };
}

const COMMON = `import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
export const privateContinuityOutput = value => value;
export async function snapshotContinuityState() {throw new Error('unused');}`;

it("loads the explicit attested subject runtime without starting the observer's model stack", () => {
  const root = subject(
    `${COMMON}\nexport async function startContinuityRuntime(dir) {writeFileSync(join(dir,'..','selected.flag'),'selected');throw new Error('synthetic-stop');}`,
  );
  const { result, output } = run(root);
  expect(result.status).toBe(1);
  expect(existsSync(join(output, "selected.flag"))).toBe(true);
  expect(JSON.parse(readFileSync(join(output, "ledger.json"))).status).toBe("failed");
});

it("refuses input drift before any Chat or provider request", () => {
  const root = subject(`${COMMON}\nexport async function startContinuityRuntime(dir,config) {
    writeFileSync(config,'{"changed":true}');
    return {models:['synthetic'],async request(){writeFileSync(join(dir,'..','dispatch.flag'),'bad');return {status:500};},async drain(){return undefined;},async close(){return undefined;}};
  }`);
  const { result, output } = run(root);
  expect(result.status).toBe(1);
  expect(existsSync(join(output, "dispatch.flag"))).toBe(false);
  expect(JSON.parse(readFileSync(join(output, "ledger.json"))).status).toBe("failed");
});

it.each(["configuration", "subject", "helper"])(
  "rejects %s drift at the final campaign boundary",
  (kind) => {
    const mutation =
      kind === "configuration"
        ? "writeFileSync(config,'changed')"
        : kind === "subject"
          ? "writeFileSync(join(dir,'..','..','package.json'),'changed')"
          : "writeFileSync(join(dir,'..','..','scripts','testing','helper.mjs'),'changed')";
    const root = subject(`${COMMON}\nexport async function startContinuityRuntime(dir,config) {
    return {models:[],async restart(){${mutation};},async drain(){return undefined;},async close(){return undefined;}};
  }`);
    const { result, output } = run(root);
    expect(result.status).toBe(1);
    expect(JSON.parse(readFileSync(join(output, "ledger.json"))).status).toBe("failed");
  },
);

it("rejects replay output in a separate subject checkout before creating it", async () => {
  const runtime = COMMON.replace(
    "value => value",
    "() => {throw new TypeError('subject-output-rejected');}",
  );
  const root = subject(runtime),
    output = join(root, "private-replay");
  const ledger = join(root, "source-ledger.json"),
    config = join(root, "input.json");
  writeFileSync(
    ledger,
    JSON.stringify({ corpus: continuityCorpusManifest(), ledger: [{ kind: "plain", score: {} }] }),
  );
  writeFileSync(config, "{}");
  await expect(
    replayContinuityCases({ ledger, subject: root, config, output, indices: "0" }),
  ).rejects.toThrow("subject-output-rejected");
  expect(existsSync(output)).toBe(false);
});

it("rejects configuration drift before the first replay snapshot or model call", async () => {
  const runtime = COMMON.replace(
    "value => value",
    "value => {writeFileSync(new URL('../../../input.json',import.meta.url),'changed');return value;}",
  );
  const root = subject(runtime),
    output = join(root, "replay-result");
  const ledger = join(root, "source-ledger.json"),
    config = join(root, "input.json");
  writeFileSync(
    ledger,
    JSON.stringify({ corpus: continuityCorpusManifest(), ledger: [{ kind: "plain", score: {} }] }),
  );
  writeFileSync(config, "{}");
  await expect(
    replayContinuityCases({ ledger, subject: root, config, output, indices: "0" }),
  ).rejects.toThrow("replay-input-configuration-changed");
  expect(JSON.parse(readFileSync(join(output, "replay.json"))).status).toBe("failed");
});

it("rejects a helper changed during subject import before starting a runtime", () => {
  const root = subject(
    `${COMMON}\nwriteFileSync(new URL('../helper.mjs',import.meta.url),'changed');\nexport async function startContinuityRuntime(dir){writeFileSync(join(dir,'..','dispatch.flag'),'bad');throw Error('unexpected-start');}`,
  );
  const { result, output } = run(root);
  expect(result.status).toBe(1);
  expect(existsSync(join(output, "dispatch.flag"))).toBe(false);
  expect(JSON.parse(readFileSync(join(output, "ledger.json"))).status).toBe("failed");
});
