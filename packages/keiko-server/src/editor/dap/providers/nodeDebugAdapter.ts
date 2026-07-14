import type {
  DebugAdapterLaunchKind,
  DebugAdapterSpec,
  DebugAdapterTargetKind,
} from "./dapAdapterProviders.js";

const NODE_ENV_ALLOWLIST = Object.freeze(["LANG", "LC_ALL", "LC_CTYPE"]);
const NODE_TARGET_KINDS: readonly DebugAdapterTargetKind[] = Object.freeze(["catalog", "file"]);
const NODE_LAUNCH_KINDS: readonly DebugAdapterLaunchKind[] = Object.freeze(["launch"]);
const NODE_ATTACH_KINDS: readonly never[] = Object.freeze([]);

export function createNodeDebugAdapterSpec(
  executableName: string,
  executableArgs: readonly string[],
  trustedRoots: readonly string[],
  provisioningDigest: string,
  envAllowlist: readonly string[] = NODE_ENV_ALLOWLIST,
  fixedEnv: Readonly<Record<string, string>> = {},
): DebugAdapterSpec {
  return Object.freeze({
    runtime: "node",
    providerId: "node",
    executableName,
    executableArgs: Object.freeze([...executableArgs]),
    requiredExecutables: Object.freeze([executableName]),
    trustedRoots: Object.freeze([...trustedRoots]),
    provisioningDigest,
    envAllowlist: Object.freeze([...envAllowlist]),
    fixedEnv: Object.freeze({ ...fixedEnv }),
    networkPolicy: "none",
    supportedTargetKinds: NODE_TARGET_KINDS,
    supportedLaunchKinds: NODE_LAUNCH_KINDS,
    supportedAttachKinds: NODE_ATTACH_KINDS,
    reverseRequestAllowlist: Object.freeze([]),
  });
}
