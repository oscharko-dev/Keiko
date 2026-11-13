// Keeps the lab's HTTPS certificate usable for a run (#4369), the way the license window keeps the
// test license usable. A run that starts with an expired or nearly expired certificate renews it
// itself: the owned session's own `start` regenerates the whole certificate generation and
// recreates only the owned TLS front. It happens at a boundary where no other lane uses Jira,
// never inside a turn. Nothing here changes clocks or touches a foreign Compose project.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { labTlsRemainingSeconds } from "./tls-front.mjs";
import { withExclusiveRestart } from "./requirements/lab-lanes.mjs";

const SESSION_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "session.mjs");

function restartOwnedSession(directory) {
  const result = spawnSync(process.execPath, [SESSION_SCRIPT, "start", directory], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.status !== 0) throw new TypeError("Laboratory session start failed");
}

/** Remaining seconds of the certificate generation; an invalid or expired one counts as none. */
function remainingOf(tlsDirectory, read) {
  try {
    return Math.max(0, read(tlsDirectory));
  } catch {
    return 0;
  }
}

/**
 * Renews the certificate when fewer than `minimumSeconds` remain, and reports what happened. The
 * ports are injectable so the decision is testable without Docker or OpenSSL.
 */
export async function renewTlsWindow(
  session,
  minimumSeconds,
  {
    remaining = labTlsRemainingSeconds,
    restart = restartOwnedSession,
    exclusive = withExclusiveRestart,
    log = (line) => console.log(line),
  } = {},
) {
  const tlsDirectory = join(session.directory, "secrets", "tls");
  const before = remainingOf(tlsDirectory, remaining);
  if (before >= minimumSeconds) return { renewed: false, remainingBefore: before, remainingAfter: before };
  const renewed = await exclusive(
    session.directory,
    async () => remainingOf(tlsDirectory, remaining) < minimumSeconds,
    async () => {
      restart(session.directory);
      return remainingOf(tlsDirectory, remaining);
    },
  );
  const after = renewed ?? remainingOf(tlsDirectory, remaining);
  log(
    JSON.stringify({
      operation: "jira-lab-tls-window",
      renewed: renewed !== undefined,
      sufficient: after >= minimumSeconds,
    }),
  );
  return { renewed: renewed !== undefined, remainingBefore: before, remainingAfter: after };
}
