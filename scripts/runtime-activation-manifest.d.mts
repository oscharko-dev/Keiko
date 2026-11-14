export const RUNTIME_ACTIVATION_RELATIVE_PATH: ".portable/runtime-activation.json";
export const RUNTIME_QUALIFICATION_SUITE: string;

/** One runtime file entry of a portable manifest, as the staging scripts write it. */
export interface RuntimeActivationSourceEntry {
  readonly name: string;
  readonly kind: string;
  readonly executablePath: string;
  readonly licensePath?: string;
  readonly payloadRootPath?: string;
}

/** The portable manifest fields the runtime-activation record is derived from. */
export interface RuntimeActivationSourceManifest {
  readonly product: { readonly packageName: string; readonly packageVersion: string };
  readonly release: { readonly commitSha: string };
  readonly artifact: { readonly platformTarget: string };
  readonly runtime: { readonly nodePlatform: string; readonly nodeArchitecture: string };
  readonly security: {
    readonly verificationPolicy: string;
    readonly verificationStatus: string;
    readonly verificationReasonCodes: readonly string[];
    readonly signatureKind: string;
    readonly signatureVerified: boolean;
    readonly notarizationRequired: boolean;
    readonly notarizationVerified: boolean;
    readonly verificationChecks: Readonly<Record<string, boolean>>;
  };
  readonly nativeHelpers: readonly RuntimeActivationSourceEntry[];
  readonly nativeAddons?: readonly RuntimeActivationSourceEntry[];
  readonly nativeTools?: readonly RuntimeActivationSourceEntry[];
  readonly sidecarRuntimes?: readonly RuntimeActivationSourceEntry[];
  readonly releaseImpact: {
    readonly reviewedBinding: { readonly platformSignatureLocallyVerified: boolean };
  };
  runtimeActivation?: {
    readonly schemaVersion: number;
    readonly path: string;
    readonly sha256: string;
    readonly trustAnchor: string;
  };
}

export function runtimeActivationManifest(
  manifest: RuntimeActivationSourceManifest,
): Record<string, unknown>;

export function writeRuntimeActivationManifest(
  resourceRoot: string,
  manifest: RuntimeActivationSourceManifest,
): { readonly path: string; readonly sha256: string };
