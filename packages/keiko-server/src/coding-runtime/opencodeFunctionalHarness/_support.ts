import { createHash } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";

import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";

import type { PortableSidecarRuntimeVerification } from "../../update-portable-sidecar-verification.js";
import type { FunctionalPortableOpenCodeRuntime } from "../productionOpenCodeRuntimeResolver.js";
import {
  createRuntimeProcessSupervisor,
  type RuntimeProcessBackend,
  type RuntimeProcessSupervisor,
  type RuntimeProcessTree,
  type RuntimeSupervisorLaunchRequest,
  type RuntimeTreeSignal,
} from "../runtimeProcessSupervisor.js";

const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const RECEIPT = `sha256:${"0".repeat(64)}`;
const PROTOCOL_SCHEMA_SHA256 = "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de";
const PROTOCOL_HANDSHAKE_DIGEST =
  "e1db492f2ac661f2b44da6ef3d7e58ed34856621a2c58de4610640e1291266f6";

interface DirectTree extends RuntimeProcessTree {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly exits: Set<(code: number | null) => void>;
  exited: boolean;
  exitCode: number | null;
}

export function functionalArtifactAvailable(): boolean {
  return BINARY !== undefined && RESOURCE_ROOT !== undefined;
}

export function stagedFunctionalPortable(testRoot: string): FunctionalPortableOpenCodeRuntime {
  const stagedRoot = required("KEIKO_OPENCODE_REAL_RESOURCE_ROOT", RESOURCE_ROOT);
  const stagedBinary = required("KEIKO_OPENCODE_REAL_BINARY", BINARY);
  const target = platformTarget();
  const executablePath = "payload/bin/opencode";
  const resources = [executablePath, "payload/evidence/LICENSE", "payload/evidence/sbom.cdx.json"];
  if (resolve(stagedBinary) !== join(resolve(stagedRoot), executablePath)) {
    throw new Error("functional-opencode-binary-not-staged");
  }
  const installRoot = join(testRoot, "portable-resource");
  for (const file of resources) copyResource(resolve(stagedRoot), installRoot, file);
  const binary = join(installRoot, executablePath);
  if (digest(resolve(stagedBinary)) !== digest(binary)) {
    throw new Error("functional-opencode-binary-copy-mismatch");
  }
  const sidecar = verification(installRoot, target);
  return {
    evidenceClass: "functional-not-platform-qualified",
    installRoot,
    target,
    sidecar,
    qualification: qualification(target),
    nativeHelperPath: join(installRoot, "runtime", "native", "functional-not-used"),
  };
}

export function createFunctionalSupervisor(
  portable: FunctionalPortableOpenCodeRuntime,
): RuntimeProcessSupervisor {
  return createRuntimeProcessSupervisor({
    backend: new DirectChildBackend(portable.qualification),
    qualifications: [portable.qualification],
  });
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0)
    throw new Error(`functional-opencode-env-missing:${name}`);
  return value;
}

function platformTarget(): UpdatePortableTarget {
  if (process.platform === "darwin" && process.arch === "arm64") return "macos-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "macos-x64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  throw new Error("functional-opencode-platform-unsupported");
}

function qualification(
  target: UpdatePortableTarget,
): FunctionalPortableOpenCodeRuntime["qualification"] {
  return target === "windows-x64"
    ? { platform: "win32", arch: "x64", backend: "windows-job-object", releaseReceipt: RECEIPT }
    : {
        platform: "darwin",
        arch: target === "macos-arm64" ? "arm64" : "x64",
        backend: "macos-app-sandbox",
        releaseReceipt: RECEIPT,
      };
}

function copyResource(sourceRoot: string, targetRoot: string, file: string): void {
  const source = join(sourceRoot, file);
  if (!existsSync(source) || !statSync(source).isFile())
    throw new Error("functional-opencode-staged-proof-missing");
  const target = join(targetRoot, file);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  chmodSync(target, statSync(source).mode & 0o777);
}

function verification(
  installRoot: string,
  target: UpdatePortableTarget,
): PortableSidecarRuntimeVerification {
  const payloadRootPath = "payload";
  const executablePath = "payload/bin/opencode";
  const executable = join(installRoot, executablePath);
  const executableDigest = digest(executable);
  const payloadRoot = join(installRoot, payloadRootPath);
  const relativeExecutable = relative(payloadRoot, executable).split("\\").join("/");
  const payloadSha256 = payloadDigest(payloadRoot, [
    relativeExecutable,
    "evidence/LICENSE",
    "evidence/sbom.cdx.json",
  ]);
  return {
    payloadRootPath,
    executablePath,
    shippedExecutableSha256: executableDigest,
    executableTreeSha256: digestText(`${relativeExecutable}\0${executableDigest}\0`),
    licenseEvidencePath: "payload/evidence/LICENSE",
    licenseEvidenceSha256: digest(join(installRoot, "payload/evidence/LICENSE")),
    sbomEvidencePath: "payload/evidence/sbom.cdx.json",
    sbomEvidenceSha256: digest(join(installRoot, "payload/evidence/sbom.cdx.json")),
    protocolSchemaRawSha256: PROTOCOL_SCHEMA_SHA256,
    protocolHandshakeDigest: PROTOCOL_HANDSHAKE_DIGEST,
    protocolHandshakeAlgorithm: "keiko-opencode-protocol-surface-v1",
    availability: {
      redistributionApproved: true,
      payloadPresent: true,
      archiveDigestVerified: true,
      executableTreeDigestVerified: true,
      runtimeVersionVerified: true,
      protocolSchemaVerified: true,
      signatureVerified: true,
      qualificationVerified: true,
    },
    summary: verificationSummary(target, payloadSha256, executable),
  };
}

function verificationSummary(
  target: UpdatePortableTarget,
  payloadSha256: string,
  executable: string,
): PortableSidecarRuntimeVerification["summary"] {
  return {
    name: "opencode-compatible",
    kind: "coding-runtime",
    upstreamName: "opencode",
    upstreamVersion: "1.17.17",
    adapterName: "keiko-coding-sidecar",
    adapterVersion: "1",
    protocolVersion: "http-sse",
    platformTarget: target,
    payloadSha256,
    payloadSha256Prefix: payloadSha256.slice(0, 12),
    sizeBytes: statSync(executable).size,
    status: "verified",
  };
}

function payloadDigest(root: string, files: readonly string[]): string {
  return digestText(
    [...files]
      .sort()
      .map((file) => `${file}\0${digest(join(root, file))}\0`)
      .join(""),
  );
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

class DirectChildBackend implements RuntimeProcessBackend {
  public constructor(public readonly identity: RuntimeProcessBackend["identity"]) {}

  public spawnOwnedTree(request: RuntimeSupervisorLaunchRequest): RuntimeProcessTree {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tree: DirectTree = {
      treeId: request.recoveryHandle,
      child,
      stdout: child.stdout,
      stderr: child.stderr,
      exits: new Set(),
      exited: false,
      exitCode: null,
      onTreeExit(callback): void {
        if (tree.exited) callback(tree.exitCode);
        else tree.exits.add(callback);
      },
    };
    child.once("exit", (code) => {
      settle(tree, code);
    });
    child.once("error", () => {
      settle(tree, null);
    });
    return tree;
  }

  public signalTree(tree: RuntimeProcessTree, signal: RuntimeTreeSignal): void {
    const direct = tree as DirectTree;
    if (!direct.exited) direct.child.kill(signal === "graceful" ? "SIGTERM" : "SIGKILL");
  }

  public async waitForCompleteTreeExit(
    tree: RuntimeProcessTree,
    timeoutMs: number,
  ): Promise<boolean> {
    const direct = tree as DirectTree;
    if (direct.exited) return true;
    return await new Promise<boolean>((resolveWait) => {
      const timeout = setTimeout(() => {
        resolveWait(direct.exited);
      }, timeoutMs);
      timeout.unref();
      direct.exits.add(() => {
        clearTimeout(timeout);
        resolveWait(true);
      });
    });
  }

  public reconcileTreeExit(tree: RuntimeProcessTree): Promise<boolean> {
    return Promise.resolve((tree as DirectTree).exited);
  }
}

function settle(tree: DirectTree, code: number | null): void {
  if (tree.exited) return;
  tree.exited = true;
  tree.exitCode = code;
  for (const listener of tree.exits) listener(code);
  tree.exits.clear();
}
