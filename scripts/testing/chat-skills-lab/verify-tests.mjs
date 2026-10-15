// Execute generated code only inside a disposable, unprivileged, offline Linux container.
// The mounted dependency tree must have been installed for Linux from this checkout's lockfile.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { APP } from "./cases.mjs";

const IMAGE = "node:24.18.0-bookworm";
const COMMAND = `set -eu
mkdir /tmp/qualified
cp /input/* /tmp/qualified/
ln -s /opt/qualification/node_modules /tmp/qualified/node_modules
cd /tmp/qualified
node node_modules/typescript/bin/tsc --noEmit > typecheck.log 2>&1 || { cat typecheck.log; exit 20; }
set +e
node node_modules/vitest/vitest.mjs run --config vitest.config.mjs --configLoader native --reporter=json --outputFile=result.json > test.log 2>&1
result=$?
set -e
if [ -f result.json ]; then cat result.json; else cat test.log; fi
exit "$result"`;

export function extractGeneratedTest(text) {
  const matches = [...text.matchAll(/```(?:tsx|typescript|ts)\s*\n([\s\S]*?)```/gu)];
  if (matches.length !== 1 || matches[0][1].trim().length === 0)
    throw new Error("one-complete-test-file-required");
  return matches[0][1];
}

function prepareInput(directory, code, mutant) {
  mkdirSync(directory, { mode: 0o700 });
  const files = {
    "SensorBadge.tsx": mutant ? APP.replace("value < 20", "value <= 20") : APP,
    "SensorBadge.test.tsx": code,
    "setup.ts": 'import "@testing-library/jest-dom/vitest";\n',
    "package.json": JSON.stringify({ private: true, type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        lib: ["ES2022", "DOM"],
        types: ["vitest/globals", "@testing-library/jest-dom"],
      },
      include: ["*.ts", "*.tsx"],
    }),
    "vitest.config.mjs":
      'export default {esbuild:{jsx:"automatic"},test:{environment:"jsdom",setupFiles:["./setup.ts"],maxWorkers:1,fileParallelism:false}};\n',
  };
  for (const [name, contents] of Object.entries(files))
    writeFileSync(join(directory, name), contents, { mode: 0o600 });
}

export function containerArguments(directory, dependencies, name) {
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--memory=1g",
    "--cpus=2",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--tmpfs",
    "/tmp:rw,nosuid,size=256m",
    "--mount",
    `type=bind,source=${directory},target=/input,readonly`,
    "--mount",
    `type=bind,source=${dependencies},target=/opt/qualification/node_modules,readonly`,
    IMAGE,
    "sh",
    "-c",
    COMMAND,
  ];
}

function executeContainer(args, name) {
  let status = 0,
    output;
  try {
    output = execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    status = Number.isInteger(error.status) ? error.status : -1;
    output = String(error.stdout ?? "");
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      /* --rm already removed a completed container. */
    }
  }
  return { status, output };
}

function runContainer(directory, dependencies) {
  const name = `keiko-skill-tests-${randomUUID()}`;
  const { status, output } = executeContainer(
    containerArguments(directory, dependencies, name),
    name,
  );
  writeFileSync(join(directory, "execution.private.log"), output, { mode: 0o600 });
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    result = undefined;
  }
  return {
    status,
    ...resultCounts(result),
    typechecks: status !== 20 && result !== undefined,
  };
}

function resultCounts(result) {
  return {
    tests: result?.numTotalTests ?? 0,
    passed: result?.numPassedTests ?? 0,
    failed: result?.numFailedTests ?? 0,
    runtimeErrors: result?.numRuntimeErrorTestSuites ?? 0,
  };
}

export function verifyGeneratedTests(text, directory, dependencyDirectory) {
  const dependencies = realpathSync(resolve(dependencyDirectory));
  const code = extractGeneratedTest(text);
  mkdirSync(directory, { mode: 0o700 });
  const correct = join(directory, "correct"),
    mutant = join(directory, "mutant");
  prepareInput(correct, code, false);
  prepareInput(mutant, code, true);
  const baseline = runContainer(correct, dependencies);
  const mutation = baseline.status === 0 ? runContainer(mutant, dependencies) : undefined;
  return {
    image: IMAGE,
    network: "none",
    baseline,
    mutation,
    passed:
      baseline.typechecks &&
      baseline.status === 0 &&
      baseline.tests > 0 &&
      mutation?.status === 1 &&
      mutation.typechecks &&
      mutation.failed > 0 &&
      mutation.runtimeErrors === 0,
  };
}

if (process.argv[1]?.endsWith("/verify-tests.mjs")) {
  const [source, directory, dependencies] = process.argv.slice(2);
  if (!source || !directory || !dependencies)
    throw new Error(
      "Supply a private response, new private result directory and Linux dependencies directory.",
    );
  const result = verifyGeneratedTests(readFileSync(source, "utf8"), directory, dependencies);
  writeFileSync(join(directory, "verification.json"), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
