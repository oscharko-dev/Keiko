export type DebugAdapterTargetKind = "catalog" | "file";
export type DebugAdapterLaunchKind = "launch";

export interface DebugAdapterSpec {
  readonly runtime: "node";
  readonly providerId: string;
  readonly executableName: string;
  readonly executableArgs: readonly string[];
  readonly requiredExecutables: readonly string[];
  readonly trustedRoots: readonly string[];
  readonly provisioningDigest: string;
  readonly envAllowlist: readonly string[];
  readonly fixedEnv: Readonly<Record<string, string>>;
  readonly networkPolicy: "none";
  readonly supportedTargetKinds: readonly DebugAdapterTargetKind[];
  readonly supportedLaunchKinds: readonly DebugAdapterLaunchKind[];
  readonly supportedAttachKinds: readonly never[];
  readonly reverseRequestAllowlist: readonly string[];
}

export interface DapAdapterProviderCatalog {
  forRuntime(runtime: string): DebugAdapterSpec | undefined;
  resolve(runtime: string, providerId: string): DebugAdapterSpec | undefined;
}

function frozenSpec(spec: DebugAdapterSpec): DebugAdapterSpec {
  return Object.freeze({
    ...spec,
    executableArgs: Object.freeze([...spec.executableArgs]),
    requiredExecutables: Object.freeze([...spec.requiredExecutables]),
    trustedRoots: Object.freeze([...spec.trustedRoots]),
    envAllowlist: Object.freeze([...spec.envAllowlist]),
    fixedEnv: Object.freeze({ ...spec.fixedEnv }),
    supportedTargetKinds: Object.freeze([...spec.supportedTargetKinds]),
    supportedLaunchKinds: Object.freeze([...spec.supportedLaunchKinds]),
    supportedAttachKinds: Object.freeze([...spec.supportedAttachKinds]),
    reverseRequestAllowlist: Object.freeze([...spec.reverseRequestAllowlist]),
  });
}

export function createDapAdapterProviderCatalog(
  specs: readonly DebugAdapterSpec[],
): DapAdapterProviderCatalog {
  const catalog = Object.freeze(specs.map(frozenSpec));
  return {
    forRuntime: (runtime): DebugAdapterSpec | undefined =>
      catalog.find((spec) => spec.runtime === runtime),
    resolve: (runtime, providerId): DebugAdapterSpec | undefined =>
      catalog.find((spec) => spec.runtime === runtime && spec.providerId === providerId),
  };
}
