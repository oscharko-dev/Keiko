import { join } from "node:path";

import { runGatewayServiceCli } from "./gateway-service.js";
import type { CliIo } from "./runner.js";

// One-step Windows uninstall (ADR-0043 D19): removing Keiko also removes the LocalSystem broker it
// installed, through the same `keiko gateway-service uninstall` the operator command runs. Windows
// asks the human through UAC and only the digest-checked native helper runs elevated. It runs
// before the installation's own files are removed, because the helper lives there. A declined
// approval or a broker that still guards a live tree keeps the service and says how to remove it
// later; the rest of the uninstall continues. Evidence is the existing `cli.gateway-service.*`.

export type GatewayServiceRemovalOutcome = "absent" | "would-remove" | "removed" | "kept";

export type GatewayServiceRemovalRunner = (
  args: readonly string[],
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
) => Promise<number>;

export interface GatewayServiceRemovalInput {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stateDir: string;
  readonly dryRun: boolean;
  readonly io: CliIo;
  readonly exists: (path: string) => boolean;
  readonly run?: GatewayServiceRemovalRunner | undefined;
}

const KEPT_MESSAGE =
  "keiko uninstall: the Windows runtime gateway service stays installed. Remove it later with: keiko gateway-service uninstall\n";

function serviceInstalled(input: GatewayServiceRemovalInput): boolean {
  const programFiles = input.env.ProgramFiles;
  return (
    input.platform === "win32" &&
    programFiles !== undefined &&
    input.exists(join(programFiles, "KeikoRuntimeGateway"))
  );
}

/** Remove the Windows gateway service as part of a full uninstall; `absent` when there is none. */
export async function removeWindowsGatewayServiceForUninstall(
  input: GatewayServiceRemovalInput,
): Promise<GatewayServiceRemovalOutcome> {
  if (!serviceInstalled(input)) return "absent";
  if (input.dryRun) {
    input.io.out(
      "would-remove: the Windows runtime gateway service (Windows asks for approval once)\n",
    );
    return "would-remove";
  }
  input.io.out("Removing the Windows runtime gateway service. Windows asks for approval once.\n");
  const code = await (input.run ?? runGatewayServiceCli)(["uninstall"], input.io, {
    ...input.env,
    KEIKO_STATE_DIR: input.stateDir,
  });
  if (code === 0) return "removed";
  input.io.out(KEPT_MESSAGE);
  return "kept";
}
