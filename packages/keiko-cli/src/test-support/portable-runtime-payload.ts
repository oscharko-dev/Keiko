import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  writeRuntimeActivationManifest,
  type RuntimeActivationSourceEntry,
  type RuntimeActivationSourceManifest,
} from "../../../../scripts/runtime-activation-manifest.mjs";

export type PortableRuntimePayloadTarget =
  "windows-x64" | "linux-x64" | "macos-arm64" | "macos-x64";

const NODE_PLATFORM: Readonly<Record<PortableRuntimePayloadTarget, string>> = {
  "windows-x64": "win32",
  "linux-x64": "linux",
  "macos-arm64": "darwin",
  "macos-x64": "darwin",
};
// A file below the sidecar's root that the record names only through that root.
const SIDECAR_ROOT_ONLY_FILE = "share/notice.txt";

const UNSIGNED_EVALUATION_SECURITY: RuntimeActivationSourceManifest["security"] = {
  verificationPolicy: "evaluation",
  verificationStatus: "unverified",
  verificationReasonCodes: [],
  signatureKind: "none",
  signatureVerified: false,
  notarizationRequired: false,
  notarizationVerified: false,
  verificationChecks: {},
};

type RuntimeSections = Pick<
  RuntimeActivationSourceManifest,
  "nativeHelpers" | "nativeAddons" | "nativeTools" | "sidecarRuntimes"
>;

// The runtime files of a real payload: two helpers, the vector add-on, the search tool and the
// coding sidecar. `suffix` is the platform's executable suffix.
function runtimeSections(suffix: string): RuntimeSections {
  const helper = (name: string, kind: string): RuntimeActivationSourceEntry => ({
    name,
    kind,
    executablePath: `runtime/native/${name}${suffix}`,
  });
  return {
    nativeHelpers: [
      helper("keiko-secure-workspace-read", "secure-workspace-text-read"),
      helper("keiko-runtime-supervisor", "runtime-process-supervisor"),
    ],
    nativeAddons: [
      {
        name: "usearch",
        kind: "node-native-addon",
        executablePath: "runtime/native/usearch.node",
        licensePath: "runtime/licenses/usearch/LICENSE",
      },
    ],
    nativeTools: [
      {
        name: "ripgrep",
        kind: "native-tool",
        executablePath: `runtime/native/rg${suffix}`,
        licensePath: "runtime/licenses/ripgrep/LICENSE-MIT",
      },
    ],
    sidecarRuntimes: [
      {
        name: "opencode-compatible",
        kind: "coding-runtime",
        payloadRootPath: "runtime/sidecars/opencode-compatible",
        executablePath: `runtime/sidecars/opencode-compatible/bin/opencode${suffix}`,
      },
    ],
  };
}

function runtimeManifest(
  target: PortableRuntimePayloadTarget,
  version: string,
): RuntimeActivationSourceManifest {
  return {
    product: { packageName: "@oscharko-dev/keiko", packageVersion: version },
    release: { commitSha: "0".repeat(40) },
    artifact: { platformTarget: target },
    runtime: {
      nodePlatform: NODE_PLATFORM[target],
      nodeArchitecture: target.endsWith("arm64") ? "arm64" : "x64",
    },
    security: UNSIGNED_EVALUATION_SECURITY,
    ...runtimeSections(target === "windows-x64" ? ".exe" : ""),
    releaseImpact: { reviewedBinding: { platformSignatureLocallyVerified: false } },
  };
}

function namedFiles(manifest: RuntimeActivationSourceManifest): readonly string[] {
  const entries = [
    ...manifest.nativeHelpers,
    ...(manifest.nativeAddons ?? []),
    ...(manifest.nativeTools ?? []),
    ...(manifest.sidecarRuntimes ?? []),
  ];
  return entries.flatMap((entry) => [
    entry.executablePath,
    ...(entry.licensePath === undefined ? [] : [entry.licensePath]),
    ...(entry.payloadRootPath === undefined
      ? []
      : [`${entry.payloadRootPath}/${SIDECAR_ROOT_ONLY_FILE}`]),
  ]);
}

/**
 * Writes what a real portable payload carries below its resource root besides the app and Node:
 * the runtime files, and the record that names each of them, written by its producer
 * (`scripts/runtime-activation-manifest.mjs`). Returns the relative paths of the runtime files.
 */
export function writePortableRuntimePayload(
  resourceRoot: string,
  target: PortableRuntimePayloadTarget,
  version = "0.2.11",
): readonly string[] {
  const manifest = runtimeManifest(target, version);
  writeRuntimeActivationManifest(resourceRoot, manifest);
  const files = namedFiles(manifest);
  for (const file of files) {
    const path = join(resourceRoot, ...file.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture runtime file\n");
  }
  return files;
}
