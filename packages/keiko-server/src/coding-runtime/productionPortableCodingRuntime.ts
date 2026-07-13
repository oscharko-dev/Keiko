import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import type { LongLivedRuntimeQualification } from "@oscharko-dev/keiko-sandbox";

import { productionUpdateFacts } from "../update-install-mode.js";
import {
  evaluatePortableSidecarAvailability,
  verifyPortableManifestSidecars,
  type PortableSidecarRuntimeVerification,
} from "../update-portable-sidecar-verification.js";
import { inspectStagedSidecarPayload } from "../update-portable-sidecar-staging-verification.js";
import { loadInstalledNativeRuntimeQualification } from "./nativeRuntimeProcessBackend.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

export interface QualifiedPortableOpenCodeRuntime {
  readonly installRoot: string;
  readonly target: "windows-x64";
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly sidecar: PortableSidecarRuntimeVerification;
  readonly qualification: LongLivedRuntimeQualification;
  readonly nativeHelperPath: string;
}

export interface PortableOpenCodeDiscoveryInput {
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
  readonly installRoot?: string | undefined;
}

interface PortableRuntimeCandidate {
  readonly root: string;
  readonly target: "windows-x64";
  readonly manifest: Record<string, unknown>;
  readonly sourceCommitSha: string;
  readonly artifactSha256: string;
  readonly sidecar: PortableSidecarRuntimeVerification;
}

interface PortableManifestProvenance {
  readonly sourceCommitSha: string;
  readonly artifactSha256: string;
}

export function discoverQualifiedPortableOpenCode(
  input: PortableOpenCodeDiscoveryInput,
): QualifiedPortableOpenCodeRuntime | undefined {
  try {
    const candidate = portableRuntimeCandidate(input);
    return candidate === undefined ? undefined : qualifiedRuntime(candidate);
  } catch {
    return undefined;
  }
}

function portableRuntimeCandidate(
  input: PortableOpenCodeDiscoveryInput,
): PortableRuntimeCandidate | undefined {
  const target = runtimeTarget(input.platform ?? process.platform, input.arch ?? process.arch);
  if (target === undefined) return undefined;
  const root = trustedInstallRoot(input);
  if (root === undefined || !setupMatches(root, target)) return undefined;
  const manifest = readRecord(join(root, ".portable", "update-portable-manifest.json"));
  if (manifest === undefined || manifestTarget(manifest) !== target) return undefined;
  const provenance = manifestProvenance(manifest);
  if (provenance === undefined) return undefined;
  const sidecar = qualifiedSidecar(root, manifest, target);
  if (sidecar === undefined) return undefined;
  return { root, target, manifest, ...provenance, sidecar };
}

function manifestProvenance(
  manifest: Record<string, unknown>,
): PortableManifestProvenance | undefined {
  const sourceCommitSha = sourceCommit(manifest);
  const artifactSha256 = artifactDigest(manifest);
  return sourceCommitSha === undefined || artifactSha256 === undefined
    ? undefined
    : { sourceCommitSha, artifactSha256 };
}

function qualifiedRuntime(
  candidate: PortableRuntimeCandidate,
): QualifiedPortableOpenCodeRuntime | undefined {
  const qualification = loadInstalledNativeRuntimeQualification({
    installRoot: candidate.root,
    sourceCommitSha: candidate.sourceCommitSha,
    artifactSha256: candidate.artifactSha256,
    sidecars: [
      { name: candidate.sidecar.summary.name, sha256: candidate.sidecar.summary.payloadSha256 },
    ],
  });
  return qualification === undefined
    ? undefined
    : {
        installRoot: candidate.root,
        target: candidate.target,
        manifest: candidate.manifest,
        sidecar: candidate.sidecar,
        qualification,
        nativeHelperPath: join(candidate.root, "runtime", "native", "keiko-runtime-supervisor.exe"),
      };
}

function trustedInstallRoot(input: PortableOpenCodeDiscoveryInput): string | undefined {
  const candidate = input.installRoot ?? productionUpdateFacts(input.env).packageRoot;
  if (candidate === undefined) return undefined;
  const root = realpathSync(candidate);
  return statSync(root).isDirectory() ? root : undefined;
}

function runtimeTarget(platform: NodeJS.Platform, arch: string): "windows-x64" | undefined {
  return platform === "win32" && arch === "x64" ? "windows-x64" : undefined;
}

function setupMatches(root: string, target: UpdatePortableTarget): boolean {
  const setup = readRecord(join(root, ".portable", "setup-manifest.json"));
  return setup?.platformTarget === target && setup.stable === true;
}

function qualifiedSidecar(
  root: string,
  manifest: Record<string, unknown>,
  target: "windows-x64",
): PortableSidecarRuntimeVerification | undefined {
  const sidecars = verifyPortableManifestSidecars(manifest, target).sidecars;
  if (sidecars.length !== 1 || sidecars[0]?.summary.name !== "opencode-compatible")
    return undefined;
  const sidecar = sidecars[0];
  const disk = inspectStagedSidecarPayload(root, sidecar);
  const availability = evaluatePortableSidecarAvailability(sidecar, { target, ...disk });
  return availability.available ? sidecar : undefined;
}

function readRecord(path: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isRecord(parsed) ? parsed : undefined;
}

function manifestTarget(manifest: Record<string, unknown>): unknown {
  return record(manifest.artifact)?.platformTarget;
}

function sourceCommit(manifest: Record<string, unknown>): string | undefined {
  const value = record(manifest.release)?.commitSha;
  return typeof value === "string" && COMMIT.test(value) ? value : undefined;
}

function artifactDigest(manifest: Record<string, unknown>): string | undefined {
  const value = record(manifest.artifact)?.sha256;
  return typeof value === "string" && SHA256.test(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
