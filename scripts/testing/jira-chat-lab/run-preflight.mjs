// Uses the existing lab owners before a long run binds credentials or starts a turn.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertSessionServerInfo, basicAuth, labRequest } from "./lab-client.mjs";
import { ensureFixtureToken } from "./fixture-tokens.mjs";
import { labTlsRemainingSeconds } from "./tls-front.mjs";
import { ensureLicenseWindow } from "./requirements/license-window.mjs";
import { registerLane } from "./requirements/lab-lanes.mjs";

export async function prepareLabRun(session, minimumSeconds = 2700) {
  if (!Number.isSafeInteger(minimumSeconds) || minimumSeconds < 1 || minimumSeconds > 6900)
    throw new TypeError("Invalid laboratory run window");
  if (labTlsRemainingSeconds(join(session.directory, "secrets", "tls")) <= minimumSeconds + 300)
    throw new TypeError("Restart the owned laboratory to renew TLS before this run");
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
