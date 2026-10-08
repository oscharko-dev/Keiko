import { isAbsolute, join, resolve } from "node:path";

import {
  copyOpenCodeServiceHostApproval,
  type OpenCodeServiceHostApproval,
} from "@oscharko-dev/keiko-contracts/runtime/opencode-service-host";

export interface OpenCodeServiceHostLaunchInput {
  readonly payloadRoot: string;
  readonly approval: unknown;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type OpenCodeServiceHostLaunchShape =
  | {
      readonly ok: true;
      readonly executable: string;
      readonly args: readonly [string];
      readonly approval: OpenCodeServiceHostApproval;
    }
  | {
      readonly ok: false;
      readonly reason:
        "host-metadata-invalid" | "host-program-invalid" | "host-environment-invalid";
    };

/**
 * Inactive fixed program producer, not disk attestation or launch authorization. Callers must
 * separately bind the approved final tree, Node, bootstrap, platform qualification and current run
 * through the existing portable/supervisor owners before admitting this shape to an actual launch.
 */
export function buildOpenCodeServiceHostLaunchShape(
  input: OpenCodeServiceHostLaunchInput,
): OpenCodeServiceHostLaunchShape {
  const approval = copyOpenCodeServiceHostApproval(input.approval);
  if (approval === undefined) return { ok: false, reason: "host-metadata-invalid" };
  if (!isAbsolute(input.payloadRoot) || resolve(input.payloadRoot) !== input.payloadRoot) {
    return { ok: false, reason: "host-program-invalid" };
  }
  const bootstrap = join(input.payloadRoot, approval.bootstrapPath);
  if (input.args !== undefined && (input.args.length !== 1 || input.args[0] !== bootstrap)) {
    return { ok: false, reason: "host-program-invalid" };
  }
  if (!closedHostEnvironment(input.env)) return { ok: false, reason: "host-environment-invalid" };
  return Object.freeze({
    ok: true,
    executable: join(input.payloadRoot, approval.nodeExecutablePath),
    args: Object.freeze([bootstrap] as const),
    approval,
  });
}

function closedHostEnvironment(env: Readonly<Record<string, string>> | undefined): boolean {
  if (env === undefined) return true;
  // Ambient Node options/loaders or injected native libraries can substitute the fixed program
  // before bootstrap validation. The existing runtime environment owner must omit these names.
  try {
    return Reflect.ownKeys(env).every((key) => {
      if (typeof key !== "string" || /^(?:NODE_|LD_|DYLD_)/iu.test(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(env, key);
      return (
        descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      );
    });
  } catch {
    return false;
  }
}
