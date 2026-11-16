// Uses the existing lab owners before a long run binds credentials or starts a turn.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertSessionServerInfo, basicAuth, labRequest } from "./lab-client.mjs";
import { ensureFixtureToken } from "./fixture-tokens.mjs";
import { labTlsRemainingSeconds } from "./tls-front.mjs";
import { renewTlsWindow } from "./tls-window.mjs";
import { ensureLicenseWindow } from "./requirements/license-window.mjs";
import { registerLane } from "./requirements/lab-lanes.mjs";

export async function prepareLabRun(session, minimumSeconds = 2700) {
  if (!Number.isSafeInteger(minimumSeconds) || minimumSeconds < 1 || minimumSeconds > 6900)
    throw new TypeError("Invalid laboratory run window");
  // An expired or nearly expired certificate is renewed by the owned session itself; only a window
  // that is still too short afterwards withholds the run, before any Jira request or renewal.
  const tlsNeeded = minimumSeconds + 300;
  await renewTlsWindow(session, tlsNeeded + 1);
  if (labTlsRemainingSeconds(join(session.directory, "secrets", "tls")) <= tlsNeeded)
    throw new TypeError("The laboratory TLS certificate could not be renewed for this run");
  const release = registerLane(session.directory);
  try {
    const version = await labRequest(
      session,
      "GET",
      "/rest/api/2/serverInfo",
      basicAuth(session, "admin"),
    );
    if (version.status !== 200) throw new TypeError("Native laboratory version is unavailable");
    assertSessionServerInfo(session, version.value);
    await ensureLicenseWindow(session, session.directory, minimumSeconds + 300);
    const actors = ["admin", "api", "restricted", "editor", "assignee"].filter((actor) =>
      existsSync(join(session.directory, "secrets", `${actor}-token`)),
    );
    await actors.reduce(
      (previous, actor) =>
        previous.then(() =>
          ensureFixtureToken(session, actor, Math.max(minimumSeconds + 300, 43_200)),
        ),
      Promise.resolve(),
    );
    console.log(
      JSON.stringify({
        operation: "jira-lab-run-preflight",
        valid: true,
        minimumSeconds,
        actorCount: actors.length,
      }),
    );
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
