// The one order in which an installation's coding runtime is found (#4491, ADR-0043 D21): the
// packaged release, then the trusted dev launcher's checkout lane, then the npm runtime package.
// The Coding activation and the Windows verification step supervisor both resolve the runtime
// through it, so a lane the Workbench starts a run from is a lane a verification step is governed
// by, and the two never disagree about which installation they are standing in.

import {
  discoverDevLaneOpenCode,
  discoverNpmLaneOpenCode,
  discoverNpmLaneRuntimeSupervisor,
  type DevLaneOpenCodeDiscovery,
  type DevLaneOpenCodeDiscoveryInput,
} from "./devLanePortableCodingRuntime.js";
import {
  discoverPortableOpenCode,
  type PortableOpenCodeDiscovery,
  type PortableOpenCodeDiscoveryInput,
} from "./productionPortableCodingRuntime.js";
import type { ResolvedPortableOpenCodeRuntime } from "./productionOpenCodeBackend.js";

type PresentLane = Exclude<DevLaneOpenCodeDiscovery, { readonly outcome: "inactive" }>;

export type RuntimeLaneDiscovery =
  | { readonly lane: "packaged"; readonly discovery: NonNullable<PortableOpenCodeDiscovery> }
  | { readonly lane: "dev-checkout" | "npm-runtime-package"; readonly discovery: PresentLane };

function present(
  lane: "dev-checkout" | "npm-runtime-package",
  discovery: DevLaneOpenCodeDiscovery,
): RuntimeLaneDiscovery | undefined {
  return discovery.outcome === "inactive" ? undefined : { lane, discovery };
}

/**
 * The first lane that holds an installed runtime, its refusal included, or `undefined` when no lane
 * is present. A present-but-refused lane stops the walk: it is the installation's own outcome and
 * must not fall through to a lane left over from another installation.
 */
export function discoverRuntimeLane(
  host: PortableOpenCodeDiscoveryInput & DevLaneOpenCodeDiscoveryInput,
): RuntimeLaneDiscovery | undefined {
  const packaged = discoverPortableOpenCode(host);
  if (packaged !== undefined) return { lane: "packaged", discovery: packaged };
  return (
    present("dev-checkout", discoverDevLaneOpenCode(host)) ??
    present("npm-runtime-package", discoverNpmLaneOpenCode(host))
  );
}

/** The activated runtime of the first present lane, or `undefined` when it is absent or refused. */
export function discoverActivatedRuntime(
  host: PortableOpenCodeDiscoveryInput & DevLaneOpenCodeDiscoveryInput,
): ResolvedPortableOpenCodeRuntime | undefined {
  const found = discoverRuntimeLane(host);
  if (found === undefined) return undefined;
  if (found.lane === "packaged") {
    return "runtime" in found.discovery ? found.discovery.runtime : undefined;
  }
  return found.discovery.outcome === "activated" ? found.discovery.runtime : undefined;
}

/**
 * What a Windows verification step needs of the installed runtime: the activated runtime of the
 * packaged or dev-checkout lane, or, on the npm lane, only the supervisor's location and its
 * compiled pin. The caller attests the supervisor bytes itself, so the OpenCode payload tree is
 * never hashed for a verification (the sidecar is attested on its own launch path, #4491).
 */
export type SupervisorRuntimeDiscovery =
  | { readonly kind: "activated-runtime"; readonly runtime: ResolvedPortableOpenCodeRuntime }
  | {
      readonly kind: "npm-supervisor";
      readonly supervisorPath: string;
      readonly sha256: string;
      readonly sizeBytes: number;
    };

/** The same lane order as `discoverRuntimeLane`, with the npm lane narrowed to its supervisor. */
export function discoverSupervisorRuntime(
  host: PortableOpenCodeDiscoveryInput & DevLaneOpenCodeDiscoveryInput,
): SupervisorRuntimeDiscovery | undefined {
  const packaged = discoverPortableOpenCode(host);
  if (packaged !== undefined) {
    return "runtime" in packaged
      ? { kind: "activated-runtime", runtime: packaged.runtime }
      : undefined;
  }
  const dev = discoverDevLaneOpenCode(host);
  if (dev.outcome !== "inactive") {
    return dev.outcome === "activated"
      ? { kind: "activated-runtime", runtime: dev.runtime }
      : undefined;
  }
  const npm = discoverNpmLaneRuntimeSupervisor(host);
  return npm.outcome === "found"
    ? {
        kind: "npm-supervisor",
        supervisorPath: npm.supervisorPath,
        sha256: npm.sha256,
        sizeBytes: npm.sizeBytes,
      }
    : undefined;
}
