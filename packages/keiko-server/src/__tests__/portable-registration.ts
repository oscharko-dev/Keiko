import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import {
  portableRegistrationDocument,
  posixPortableActivationLayout,
  refreshPortableRegistration,
  type PortableActivationLayout,
} from "../update-portable-activation-files.js";
import { primaryLauncher, runtimeFor } from "../update-portable-staging-shared.js";

/** Registration fixture only: native file bytes are synthetic and never executed. */
export function writePosixRegistrationFixture(input: {
  readonly managedRoot: string;
  readonly stateDir: string;
  readonly target: Exclude<UpdatePortableTarget, "windows-x64">;
  readonly version: string;
  readonly home: string;
  readonly now: number;
  readonly launcherIdentitySha256?: string | undefined;
}): { readonly layout: PortableActivationLayout; readonly registration: string } {
  const layout = posixPortableActivationLayout(input.target, input.managedRoot);
  mkdirSync(dirname(layout.setupManifestPath), { recursive: true });
  mkdirSync(dirname(layout.launcherPath), { recursive: true });
  writeFileSync(layout.launcherPath, "synthetic non-executed launcher");
  writeFileSync(
    layout.setupManifestPath,
    JSON.stringify({
      schemaVersion: 1,
      packageName: "@oscharko-dev/keiko",
      packageVersion: input.version,
      platformTarget: input.target,
      stable: true,
      bootstrapUpdateEligible: false,
      primaryLauncher: primaryLauncher(input.target),
      runtime: runtimeFor(input.target),
    }),
  );
  const options = { ...input, layout, env: {} };
  refreshPortableRegistration(options);
  const path = join(input.stateDir, "portable-install-state.json");
  if (input.launcherIdentitySha256 !== undefined) {
    writeFileSync(path, portableRegistrationDocument(options), { mode: 0o600 });
  }
  return { layout, registration: readFileSync(path, "utf8") };
}
