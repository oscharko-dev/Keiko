import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { dirname, join, relative } from "node:path";
import { compareStrings } from "./compare-strings.mjs";
import { policyDigest } from "./code-quality-inventory.mjs";
import { nativeCompilerExecutable } from "./code-quality-provenance.mjs";

// Reuse the existing enforcing-owner bounds; no policy-supplied commands or resource settings.
const PROOF_TIMEOUT_MS = 180_000;
const PROOF_OUTPUT_BYTES = 32 * 1024 * 1024;

export function responsibilityProofToolIdentity(root) {
  if (!process.env.npm_execpath) throw new TypeError("npm-invocation-required");
  const npm = realpathSync(process.env.npm_execpath);
  const npmPackage = join(dirname(dirname(npm)), "package.json");
  if (JSON.parse(readFileSync(npmPackage, "utf8")).name !== "npm")
    throw new TypeError("semantic-proof-tool-unavailable");
  const vitest = join(root, "node_modules/vitest/package.json");
  const installed = JSON.parse(readFileSync(vitest, "utf8"));
  if (
    realpathSync(join(root, "node_modules/.bin/vitest")) !==
    realpathSync(join(root, "node_modules/vitest/vitest.mjs"))
  )
    throw new TypeError("semantic-proof-tool-unavailable");
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  if (
    installed.name !== "vitest" ||
    installed.version !== lock.packages["node_modules/vitest"]?.version
  )
    throw new TypeError("semantic-proof-tool-unavailable");
  const entries = {
    node: process.execPath,
    npmCli: npm,
    npmPackage,
    vitestPackage: vitest,
    vitestCli: join(root, "node_modules/vitest/vitest.mjs"),
    typescript: join(root, "node_modules/typescript/lib/typescript.js"),
    nativeCompiler: nativeCompilerExecutable(),
  };
  return Object.fromEntries(
    Object.entries(entries).map(([kind, path]) => [kind, policyDigest(readFileSync(path))]),
  );
}

function groupState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(-pid, 0);
    return "present";
  } catch (error) {
    return error.code === "ESRCH" ? "absent" : "unknown";
  }
}

function stopProofGroup(state, reason) {
  state.reason ??= reason;
  if (Number.isSafeInteger(state.pid) && state.pid > 0) {
    try {
      process.kill(-state.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") state.reason = "semantic-proof-drain-unavailable";
    }
  }
  // An escaped descendant may retain inherited pipes. Close our owned readers on failure;
  // this permits actual direct-child close without claiming that descendant was drained.
  for (const stream of state.outputStreams) stream.destroy();
}

function retainProofOutput(state, chunk, stdout) {
  state.bytes += chunk.length;
  if (state.bytes > PROOF_OUTPUT_BYTES) stopProofGroup(state, "semantic-proof-output-limit");
  else if (stdout) state.stdout.push(chunk);
}

function closeProofProcess(state, code, signal) {
  clearTimeout(state.timer);
  const group = groupState(state.pid);
  if (group === "present") stopProofGroup(state, "semantic-proof-process-not-drained");
  const absent = groupState(state.pid) === "absent";
  return {
    status: state.reason || code !== 0 || signal !== null || !absent ? "failed" : "passed",
    reason: state.reason ?? (!absent ? "semantic-proof-drain-unavailable" : null),
    directChildClosed: true,
    groupAbsent: absent,
    outputBytes: state.bytes,
    stdout: Buffer.concat(state.stdout).toString("utf8"),
  };
}

async function runProofNpm(root, args) {
  if (process.platform === "win32") throw new TypeError("semantic-proof-drain-unavailable");
  responsibilityProofToolIdentity(root);
  const state = {
    pid: undefined,
    reason: null,
    bytes: 0,
    stdout: [],
    timer: undefined,
    outputStreams: [],
  };
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [realpathSync(process.env.npm_execpath), ...args], {
      cwd: root,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    state.pid = child.pid;
    state.outputStreams = [child.stdout, child.stderr];
    state.timer = setTimeout(
      () => stopProofGroup(state, "semantic-proof-timeout"),
      PROOF_TIMEOUT_MS,
    );
    child.stdout.on("data", (chunk) => retainProofOutput(state, chunk, true));
    child.stderr.on("data", (chunk) => retainProofOutput(state, chunk, false));
    child.on("error", () => {
      state.reason ??= "semantic-proof-spawn-failed";
    });
    child.on("close", (code, signal) => resolve(closeProofProcess(state, code, signal)));
  });
}

export async function buildResponsibilityProofPackages(root) {
  const result = await runProofNpm(root, ["run", "build:packages"]);
  if (result.status !== "passed")
    throw new TypeError(result.reason ?? "semantic-proof-build-failed");
}

function reachedAssertions(root, report, paths) {
  if (!report || !Array.isArray(report.testResults))
    throw new TypeError("semantic-proof-report-invalid");
  const files = new Map();
  for (const file of report.testResults) {
    if (typeof file.name !== "string" || !Array.isArray(file.assertionResults))
      throw new TypeError("semantic-proof-report-invalid");
    const path = relative(root, file.name).replaceAll("\\", "/");
    if (!paths.includes(path) || files.has(path) || file.status !== "passed")
      throw new TypeError("semantic-proof-report-invalid");
    files.set(path, file.assertionResults);
  }
  if (files.size !== paths.length) throw new TypeError("semantic-proof-assertion-missing");
  return files;
}

function selectedAssertions(records, files) {
  return records.map((record) => {
    const assertions = (record.proofAssertions ?? []).map((selector) => {
      const matches = files
        .get(selector.path)
        .filter((test) => test.fullName === selector.testName);
      if (matches.length !== 1 || matches[0].status !== "passed")
        throw new TypeError("semantic-proof-assertion-missing");
      return { ...selector, status: "passed" };
    });
    if (assertions.length === 0) throw new TypeError("semantic-proof-assertion-missing");
    for (const path of record.proofs) {
      if (!assertions.some((assertion) => assertion.path === path))
        throw new TypeError("semantic-proof-assertion-missing");
    }
    return { id: record.id, assertions, executedPaths: record.proofs };
  });
}

// Malformed reporter bodies are intentionally not forwarded as an error cause or message.
function parseProofReport(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new TypeError("semantic-proof-report-invalid");
  }
}

export async function executeResponsibilityProofs(root, records) {
  const canonicalRoot = realpathSync(root);
  const paths = [...new Set(records.flatMap((record) => record.proofs))].sort(compareStrings);
  if (paths.length === 0 || records.some((record) => !record.proofAssertions?.length))
    throw new TypeError("semantic-proof-assertion-missing");
  // Relative file prefixes prevent a declared path from becoming a Vitest option.
  const temporary = mkdtempSync(join(tmpdir(), "keiko-responsibility-proof-"));
  chmodSync(temporary, 0o700);
  const report = join(temporary, "result.json");
  try {
    const result = await runProofNpm(canonicalRoot, [
      "exec",
      "--offline",
      "--",
      "vitest",
      "run",
      "--reporter=json",
      `--outputFile=${report}`,
      ...paths.map((path) => `./${path}`),
    ]);
    if (result.status !== "passed")
      throw new TypeError(result.reason ?? "semantic-proof-execution-failed");
    const stat = lstatSync(report);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      stat.size + result.outputBytes > PROOF_OUTPUT_BYTES
    )
      throw new TypeError("semantic-proof-report-invalid");
    chmodSync(report, 0o600);
    const files = reachedAssertions(
      canonicalRoot,
      parseProofReport(readFileSync(report, "utf8")),
      paths,
    );
    return {
      records: selectedAssertions(records, files),
      process: {
        directChildClosed: result.directChildClosed,
        groupAbsent: result.groupAbsent,
        outputBytes: result.outputBytes,
        reportBytes: stat.size,
      },
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
