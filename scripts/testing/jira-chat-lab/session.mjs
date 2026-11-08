// Owns disposable synthetic sessions only; never deletes volumes or touches an existing lab.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeLabTls } from "./tls-front.mjs";
import { DEFAULT_LAB_CONNECTION, loadSession, normalizeLabSession } from "./lab-client.mjs";
import { requireExclusiveLab } from "./lab-services.mjs";

const [
  action,
  requestedDirectory,
  requestedPort = "18081",
  requestedHttpsPort = "18443",
  requestedVersion,
  requestedDigest,
  ...extra
] = process.argv.slice(2);
if (!requestedDirectory || !new Set(["init", "start", "stop", "status"]).has(action))
  throw new TypeError(
    "Usage: session.mjs init <private-state-directory> [http-port] [https-port] [exact-jira-version] [sha256-hex]; start|stop|status <private-state-directory>",
  );
if (extra.length !== 0 || (action !== "init" && process.argv.length !== 4))
  throw new TypeError("Existing laboratory sessions are controlled only by their manifest");
const directory = resolve(requestedDirectory);
if (action === "init") {
  if ((requestedVersion === undefined) !== (requestedDigest === undefined))
    throw new TypeError("Supply both the exact Jira release and image digest");
  const manifest = {
    schemaVersion: 1,
    project: `keiko-jira-4081-${randomBytes(6).toString("hex")}`,
    httpPort: Number(requestedPort),
    httpsPort: Number(requestedHttpsPort),
    jiraVersion: requestedVersion ?? DEFAULT_LAB_CONNECTION.jiraVersion,
    jiraImageDigest: requestedDigest ?? DEFAULT_LAB_CONNECTION.jiraImageDigest,
    syntheticOnly: true,
  };
  normalizeLabSession(manifest, directory);
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });
  initializeLabTls(join(directory, "secrets", "tls"));
  for (const name of ["database-password", "admin-password", "api-user-password"])
    writeFileSync(join(directory, "secrets", name), randomBytes(24).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
  writeFileSync(join(directory, "session.json"), JSON.stringify(manifest) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify({ operation: "jira-lab-session", initialized: true }));
} else {
  const session = loadSession(directory);
  const command = action === "start" ? ["up", "-d"] : [action === "status" ? "ps" : "stop"];
  if (action === "start") {
    await requireExclusiveLab(session);
    initializeLabTls(join(directory, "secrets", "tls"));
  }
  execFileSync(
    "docker",
    [
      "compose",
      "-p",
      session.project,
      "-f",
      join(dirname(fileURLToPath(import.meta.url)), "compose.yaml"),
      ...command,
    ],
    {
      env: {
        ...process.env,
        KEIKO_OS_KEYCHAIN: "off",
        KEIKO_JIRA_LAB_STATE_DIR: directory,
        KEIKO_JIRA_LAB_HTTP_PORT: String(session.httpPort),
        KEIKO_JIRA_LAB_HTTPS_PORT: String(session.httpsPort),
        KEIKO_JIRA_LAB_JIRA_VERSION: session.jiraVersion,
        KEIKO_JIRA_LAB_JIRA_SHA256: session.jiraImageDigest,
      },
      stdio: "inherit",
    },
  );
}
