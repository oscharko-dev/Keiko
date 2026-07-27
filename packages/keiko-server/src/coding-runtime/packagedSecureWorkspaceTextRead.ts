import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";

import {
  createSecureWorkspaceTextReadPort,
  type SecureWorkspaceTextReadPort,
} from "./secureWorkspaceTextRead.js";
import { createNodeSecureWorkspaceReadProcessFactory } from "./secureWorkspaceTextReadNodeProcess.js";
import {
  createPortableSecureWorkspaceReadVerifier,
  resolvePortableSecureWorkspaceReadBinding,
} from "./secureWorkspaceTextReadPortable.js";
import {
  createNodePortableSecureWorkspaceReadInspection,
  provePortableImmutableResourceTree,
} from "./secureWorkspaceTextReadPlatformNode.js";
import type { QualifiedPortableOpenCodeRuntime } from "./productionPortableCodingRuntime.js";

export interface PackagedSecureWorkspaceTextReadInput {
  readonly runtime: QualifiedPortableOpenCodeRuntime;
  readonly resolveWorkspaceRoot: () => string | undefined | Promise<string | undefined>;
  readonly safeCwd: string;
}

export function createPackagedSecureWorkspaceTextReadPort(
  input: PackagedSecureWorkspaceTextReadInput,
): SecureWorkspaceTextReadPort | undefined {
  const platform = platformForTarget(input.runtime.target);
  const binding = resolvePortableSecureWorkspaceReadBinding({
    manifest: input.runtime.manifest,
    platform,
    resourceRoot: input.runtime.installRoot,
  });
  if (binding === undefined) return undefined;
  return createSecureWorkspaceTextReadPort({
    resolveWorkspaceRoot: input.resolveWorkspaceRoot,
    artifact: binding.artifact,
    artifactVerifier: createPortableSecureWorkspaceReadVerifier(binding, {
      proveImmutableResourceTree: () =>
        provePortableImmutableResourceTree(
          input.runtime.installRoot,
          artifactTargetFor(input.runtime.target),
        ),
      platform: createNodePortableSecureWorkspaceReadInspection({
        resourceRoot: input.runtime.installRoot,
      }),
    }),
    processFactory: createNodeSecureWorkspaceReadProcessFactory({
      binding,
      safeCwd: input.safeCwd,
    }),
    platform,
  });
}

function artifactTargetFor(
  target: UpdatePortableTarget,
): "win32-x64" | "darwin-arm64" | "darwin-x64" {
  if (target === "windows-x64") return "win32-x64";
  return target === "macos-arm64" ? "darwin-arm64" : "darwin-x64";
}

function platformForTarget(target: UpdatePortableTarget): {
  readonly os: "darwin" | "win32";
  readonly arch: "arm64" | "x64";
} {
  return target === "windows-x64"
    ? { os: "win32", arch: "x64" }
    : { os: "darwin", arch: target === "macos-arm64" ? "arm64" : "x64" };
}
