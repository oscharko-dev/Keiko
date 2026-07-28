import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";

import { FILE_HISTORY_APP_SESSION_LAUNCHER_SECRET } from "./file-history-2531.js";

export function editorM11PairingFragment(journey: string): string {
  const issuedAtMs = Date.now();
  return encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: FILE_HISTORY_APP_SESSION_LAUNCHER_SECRET,
      requestId: `req_${journey}-${String(issuedAtMs)}`,
      issuedAtMs,
    }),
  );
}
