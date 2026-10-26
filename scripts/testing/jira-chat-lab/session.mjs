// Owns disposable synthetic sessions only; never deletes volumes or touches an existing lab.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [action, requestedDirectory, requestedPort = "18081"] = process.argv.slice(2);
if (!requestedDirectory || !new Set(["init", "start", "stop", "status"]).has(action))
  throw new TypeError(
    "Usage: session.mjs <init|start|stop|status> <private-state-directory> [http-port]",
  );
const directory = resolve(requestedDirectory);
const port = Number(requestedPort);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
  throw new TypeError("Invalid lab port");
if (action === "init") {
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });
  for (const name of ["database-password", "admin-password", "api-user-password"])
    writeFileSync(join(directory, "secrets", name), randomBytes(24).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
  writeFileSync(
    join(directory, "session.json"),
    JSON.stringify({
      schemaVersion: 1,
      project: `keiko-jira-4081-${randomBytes(6).toString("hex")}`,
      httpPort: port,
      syntheticOnly: true,
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify({ operation: "jira-lab-session", initialized: true }));
} else {
  const session = JSON.parse(readFileSync(join(directory, "session.json"), "utf8"));
  if (
    session.schemaVersion !== 1 ||
    session.syntheticOnly !== true ||
    !/^keiko-jira-4081-[a-z0-9-]{1,32}$/.test(session.project) ||
    !Number.isSafeInteger(session.httpPort) ||
    session.httpPort < 1024 ||
    session.httpPort > 65535
  )
    throw new TypeError("Invalid synthetic session manifest");
  const command = action === "start" ? ["up", "-d"] : [action === "status" ? "ps" : "stop"];
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
        KEIKO_JIRA_LAB_STATE_DIR: directory,
        KEIKO_JIRA_LAB_HTTP_PORT: String(session.httpPort),
      },
      stdio: "inherit",
    },
  );
}
