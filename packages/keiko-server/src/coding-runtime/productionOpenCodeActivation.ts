import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type {
  CodingWorkbenchRuntimeEvidenceClass,
  CodingWorkbenchRuntimeUnavailableReason,
} from "@oscharko-dev/keiko-contracts";
import {
  createFetchEditorAgentHttpTransport,
  EditorAgentHttpClient,
} from "@oscharko-dev/keiko-tools";

import { codingSidecarDisabledByPolicy } from "../coding-sidecar-gateway.js";
import type { OpenCodeGatewayReadinessRegistry } from "../coding-sidecar-gateway.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { ServerDiagnosticSink } from "../diagnostics-log.js";
import type { ServerLogSink } from "../observability/index.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { CodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import {
  discoverDevLaneOpenCode,
  type DevLaneOpenCodeDiscovery,
  type DevLaneOpenCodeRefusalReason,
  type DevLanePortableOpenCodeRuntime,
} from "./devLanePortableCodingRuntime.js";
import { createDevLaneSecureWorkspaceTextReadPort } from "./devLaneSecureWorkspaceTextRead.js";
import { createProductionOpenCodeBackend } from "./productionOpenCodeBackend.js";
import type { ResolvedPortableOpenCodeRuntime } from "./productionOpenCodeBackend.js";
import { createPackagedSecureWorkspaceTextReadPort } from "./packagedSecureWorkspaceTextRead.js";
import type { ProductionCodingRuntimeResolverInput } from "./productionCodingRuntimeResolver.js";
import { discoverQualifiedPortableOpenCode } from "./productionPortableCodingRuntime.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";

type ProductionOpenCodePorts = Pick<
  ProductionCodingRuntimeResolverInput,
  "backend" | "editorAgentClient" | "secureWorkspaceTextRead"
>;

export interface ProductionOpenCodeActivationInput {
  readonly env: NodeJS.ProcessEnv;
  /** Host identity injection for deterministic tests; production omits both. */
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
  readonly runtimeStateDir: string;
  readonly runtimeEvidence: Pick<CodingRuntimeEvidenceAggregator, "observe">;
  readonly gatewayReadiness: Pick<
    OpenCodeGatewayReadinessRegistry,
    "waitForObservedRequest" | "verifyObserved" | "clear"
  >;
  /** Explicit test/composition override; packaged production constructs its own verified port. */
  readonly secureWorkspaceTextRead?: SecureWorkspaceTextReadPort | undefined;
  /** Live active-task-workspace root resolution for the dev-lane secure-read port. */
  readonly resolveWorkspaceRoot?:
    (() => string | undefined | Promise<string | undefined>) | undefined;
  readonly editorAgentClient?:
    ProductionCodingRuntimeResolverInput["editorAgentClient"] | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  /** Body-free lifecycle evidence for the chosen dev-lane outcome. */
  readonly activityLog?: ServerLogSink | undefined;
}

export type ProductionOpenCodeActivationResult =
  | {
      readonly ports: ProductionOpenCodePorts;
      /** How strong the activated runtime's evidence is; never optional on the success branch. */
      readonly evidenceClass: CodingWorkbenchRuntimeEvidenceClass;
      readonly unavailableReason?: undefined;
    }
  | {
      readonly ports?: undefined;
      readonly evidenceClass?: undefined;
      readonly unavailableReason: CodingWorkbenchRuntimeUnavailableReason;
    };

export interface ProductionOpenCodeLoopbackEndpoints {
  readonly gatewayUrl: string;
  readonly toolFacadeUrl: string;
}

/** Derives both sidecar endpoints from the one attested BFF loopback origin. */
export function productionOpenCodeLoopbackEndpoints(
  env: NodeJS.ProcessEnv,
): ProductionOpenCodeLoopbackEndpoints | undefined {
  const loopback = loopbackBaseUrl(env);
  return loopback === undefined
    ? undefined
    : {
        gatewayUrl: `${loopback}/api/coding-sidecar/gateway`,
        toolFacadeUrl: `${loopback}/api/coding-sidecar/tool`,
      };
}

/**
 * Assembles the production OpenCode runtime ports from a discovered runtime: the attested
 * packaged portable artifact where one exists, otherwise the explicitly opted-in supported dev-lane
 * payload. Every prerequisite is mandatory; the first missing one names the content-free
 * unavailability reason and keeps the runtime host unqualified and the Code surface unavailable.
 */
export function resolveProductionOpenCodeActivation(
  input: ProductionOpenCodeActivationInput,
): ProductionOpenCodeActivationResult {
  if (codingSidecarDisabledByPolicy(input.env)) {
    return { unavailableReason: "runtime-disabled" };
  }
  const runtime = resolveRuntime(input);
  if (runtime.unavailableReason !== undefined) {
    return { unavailableReason: runtime.unavailableReason };
  }
  const endpoints = productionOpenCodeLoopbackEndpoints(input.env);
  if (endpoints === undefined) return { unavailableReason: "loopback-unavailable" };
  const secureWorkspaceTextRead = resolveSecureRead(input, runtime.portable);
  if (secureWorkspaceTextRead === undefined) {
    return { unavailableReason: "secure-read-unavailable" };
  }
  return {
    evidenceClass: runtimeEvidenceClass(runtime.portable),
    ports: {
      backend: createProductionOpenCodeBackend({
        portable: runtime.portable,
        runtimeStateRoot: input.runtimeStateDir,
        gatewayUrl: endpoints.gatewayUrl,
        // ADR-0043 D11-D14 (#3390): the SAME single attested loopback origin as the model
        // gateway above, never a second listener's own port.
        toolFacadeUrl: endpoints.toolFacadeUrl,
        runtimeEvidence: input.runtimeEvidence,
        gatewayReadiness: input.gatewayReadiness,
        ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
        ...(input.fetch ? { fetch: input.fetch } : {}),
      }),
      secureWorkspaceTextRead,
      editorAgentClient:
        input.editorAgentClient ??
        new EditorAgentHttpClient({
          baseUrl: new URL(endpoints.gatewayUrl).origin,
          transport: createFetchEditorAgentHttpTransport(input.fetch ?? fetch),
        }),
    },
  };
}

/**
 * The single junction where all three runtime union members converge into ports, and therefore the
 * one place the readiness evidence class is derived. ONLY the release-signed packaged artifact is
 * platform-qualified; the packaged evaluation lane, supported dev lane and functional-harness
 * stand-in all report the honest weaker class (ADR-0140 D1, ADR-0163 D9).
 */
function runtimeEvidenceClass(
  portable: ResolvedPortableOpenCodeRuntime,
): CodingWorkbenchRuntimeEvidenceClass {
  return "platformAssurance" in portable && portable.platformAssurance === "release-qualified"
    ? "platform-qualified"
    : "functional-not-platform-qualified";
}

type ResolvedRuntime =
  | { readonly portable: ResolvedPortableOpenCodeRuntime; readonly unavailableReason?: undefined }
  | {
      readonly portable?: undefined;
      readonly unavailableReason: CodingWorkbenchRuntimeUnavailableReason;
    };

function resolveRuntime(
  input: Pick<
    ProductionOpenCodeActivationInput,
    "env" | "platform" | "arch" | "diagnostics" | "activityLog"
  >,
): ResolvedRuntime {
  const host = {
    env: input.env,
    platform: input.platform,
    arch: input.arch,
    diagnostics: input.diagnostics,
  };
  const packaged = discoverQualifiedPortableOpenCode(host);
  if (packaged !== undefined) return { portable: packaged };
  const discovery = discoverDevLaneOpenCode(host);
  recordDevLaneDiscovery(input.activityLog ?? processServerLogSink(), discovery);
  return devLaneRuntime(discovery);
}

function recordDevLaneDiscovery(
  activityLog: ServerLogSink,
  discovery: DevLaneOpenCodeDiscovery,
): void {
  if (discovery.outcome === "inactive") return;
  if (discovery.outcome === "activated") {
    activityLog.write({
      category: "process",
      op: "coding-runtime.dev-lane.activated",
      correlationId: UNKNOWN_CORRELATION_ID,
      extra: {
        lane: discovery.runtime.lane,
        target: discovery.runtime.target,
        evidenceClass: discovery.runtime.evidenceClass,
        ...(discovery.runtime.nativeHelperSha256 === undefined
          ? {}
          : { runtimeSupervisorSha256: discovery.runtime.nativeHelperSha256 }),
      },
    });
    return;
  }
  activityLog.write({
    category: "process",
    op: "coding-runtime.dev-lane.refused",
    correlationId: UNKNOWN_CORRELATION_ID,
    extra: { lane: "dev-checkout", reason: discovery.reason },
  });
}

function devLaneRuntime(discovery: DevLaneOpenCodeDiscovery): ResolvedRuntime {
  if (discovery.outcome === "activated") return { portable: discovery.runtime };
  if (discovery.outcome === "inactive") return { unavailableReason: "platform-unqualified" };
  return { unavailableReason: devLaneRefusalReason(discovery.reason) };
}

function devLaneRefusalReason(
  reason: DevLaneOpenCodeRefusalReason,
): CodingWorkbenchRuntimeUnavailableReason {
  switch (reason) {
    case "platform-unsupported":
    case "packaged-install-present":
    case "not-a-dev-checkout":
      return "dev-lane-refused";
    case "secure-read-helper-missing":
    case "secure-read-helper-stale":
      return "secure-read-unavailable";
    case "payload-missing":
    case "payload-unapproved":
    case "payload-tampered":
      return reason;
    case "native-helper-directory-untrusted":
      return "payload-tampered";
  }
}

function resolveSecureRead(
  input: ProductionOpenCodeActivationInput,
  portable: ResolvedPortableOpenCodeRuntime,
): SecureWorkspaceTextReadPort | undefined {
  if (input.secureWorkspaceTextRead !== undefined) return input.secureWorkspaceTextRead;
  if (input.resolveWorkspaceRoot === undefined) return undefined;
  try {
    const safeCwd = join(input.runtimeStateDir, "coding-runtime", "secure-read");
    mkdirSync(safeCwd, { recursive: true, mode: 0o700 });
    if (isDevLaneRuntime(portable)) {
      return createDevLaneSecureWorkspaceTextReadPort({
        binding: portable.secureRead,
        resolveWorkspaceRoot: input.resolveWorkspaceRoot,
        safeCwd,
      });
    }
    if ("evidenceClass" in portable) return undefined;
    return createPackagedSecureWorkspaceTextReadPort({
      runtime: portable,
      resolveWorkspaceRoot: input.resolveWorkspaceRoot,
      safeCwd,
    });
  } catch {
    return undefined;
  }
}

/** Only the dev-lane union member carries the structural `lane` marker. */
function isDevLaneRuntime(
  portable: ResolvedPortableOpenCodeRuntime,
): portable is DevLanePortableOpenCodeRuntime {
  return "lane" in portable;
}

function loopbackBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const port = Number(env.KEIKO_UI_PORT);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) return undefined;
  return `http://127.0.0.1:${String(port)}`;
}
