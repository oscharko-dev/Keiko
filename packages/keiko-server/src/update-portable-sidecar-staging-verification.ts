import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type {
  UpdatePortableSidecarFailureCode,
  UpdatePortableSidecarSummary,
} from "@oscharko-dev/keiko-contracts";
import {
  PortableSidecarVerificationError,
  type PortableSidecarRuntimeVerification,
} from "./update-portable-sidecar-verification.js";

function failedSummary(
  summary: UpdatePortableSidecarSummary,
  code: UpdatePortableSidecarFailureCode,
): UpdatePortableSidecarSummary {
  return { ...summary, status: "failed", failureCode: code };
}

function fail(
  code: UpdatePortableSidecarFailureCode,
  message: string,
  sidecar: PortableSidecarRuntimeVerification,
): never {
  throw new PortableSidecarVerificationError(code, message, failedSummary(sidecar.summary, code));
}

function resolvedContainedPath(
  root: string,
  relativePath: string,
  sidecar: PortableSidecarRuntimeVerification,
): string {
  const destination = resolve(root, ...relativePath.split("/"));
  const resolvedRoot = resolve(root);
  if (destination !== resolvedRoot && destination.startsWith(`${resolvedRoot}${sep}`)) {
    return destination;
  }
  fail("sidecar-payload-outside-root", "sidecar payload path escaped the resource root", sidecar);
}

function assertFile(
  path: string,
  sidecar: PortableSidecarRuntimeVerification,
  code: UpdatePortableSidecarFailureCode,
): void {
  if (!existsSync(path) || !statSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    fail(code, "sidecar staged file is missing or unsafe", sidecar);
  }
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256File(path: string): string {
  return sha256Buffer(readFileSync(path));
}

function listFiles(root: string, sidecar: PortableSidecarRuntimeVerification): readonly string[] {
  if (!existsSync(root) || !statSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    fail("sidecar-payload-missing", "sidecar payload root is missing", sidecar);
  }
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, sidecar));
    else if (entry.isFile() && !lstatSync(full).isSymbolicLink()) files.push(resolve(full));
    else {
      fail("sidecar-payload-outside-root", "sidecar payload contains unsupported entries", sidecar);
    }
  }
  return files.sort();
}

function hashDirectoryTree(root: string, sidecar: PortableSidecarRuntimeVerification): string {
  const hash = createHash("sha256");
  for (const file of listFiles(root, sidecar)) {
    const rel = relative(root, file).split(sep).join("/");
    hash.update(`${rel}\0${sha256File(file)}\0`);
  }
  return hash.digest("hex");
}

function verifySidecarFiles(
  resourceRoot: string,
  sidecar: PortableSidecarRuntimeVerification,
): void {
  const payloadRoot = resolvedContainedPath(resourceRoot, sidecar.payloadRootPath, sidecar);
  const executablePath = resolvedContainedPath(resourceRoot, sidecar.executablePath, sidecar);
  const licensePath = resolvedContainedPath(resourceRoot, sidecar.licenseEvidencePath, sidecar);
  const sbomPath = resolvedContainedPath(resourceRoot, sidecar.sbomEvidencePath, sidecar);
  assertFile(executablePath, sidecar, "sidecar-payload-missing");
  assertFile(licensePath, sidecar, "sidecar-license-evidence-incomplete");
  assertFile(sbomPath, sidecar, "sidecar-sbom-evidence-incomplete");
  if (sha256File(licensePath) !== sidecar.licenseEvidenceSha256) {
    fail("sidecar-license-evidence-incomplete", "sidecar license digest mismatch", sidecar);
  }
  if (sha256File(sbomPath) !== sidecar.sbomEvidenceSha256) {
    fail("sidecar-sbom-evidence-incomplete", "sidecar SBOM digest mismatch", sidecar);
  }
  if (hashDirectoryTree(payloadRoot, sidecar) !== sidecar.summary.payloadSha256) {
    fail("sidecar-digest-mismatch", "sidecar payload digest mismatch", sidecar);
  }
}

export function verifyStagedSidecarPayloads(input: {
  readonly resourceRoot: string;
  readonly sidecars: readonly PortableSidecarRuntimeVerification[];
}): void {
  for (const sidecar of input.sidecars) {
    verifySidecarFiles(input.resourceRoot, sidecar);
  }
}
