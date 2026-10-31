import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { recordContinuityBuild } from "../testing/coding-workbench-lab/chat-continuity-build.mjs";

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
  put("scripts/testing/coding-workbench-lab/chat-continuity-runtime.mjs", runtime);
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
