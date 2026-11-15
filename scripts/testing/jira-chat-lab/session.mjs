// Owns disposable synthetic sessions only; never deletes volumes or touches an existing lab.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeLabTls,
  labComposeFiles,
  readLabPrivateAddress,
  writeLabPrivateAddress,
} from "./tls-front.mjs";
import { DEFAULT_LAB_CONNECTION, loadSession, normalizeLabSession } from "./lab-client.mjs";
import { assertLabDirectoryOutsideTemporary } from "./lab-directory.mjs";
import {
  MISSING_NETWORK_REMEDY,
  containersOfMissingNetwork,
  requireExclusiveLab,
} from "./lab-services.mjs";

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
  // A new session is never created in a temporary directory; existing ones keep working as they are.
  assertLabDirectoryOutsideTemporary(directory);
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
  // Optional (#4369): one private-class address the HTTPS front also serves. Without it the lab
  // stays loopback-only; the address is recorded privately and every later start reads it back.
  const privateAddress = writeLabPrivateAddress(
    join(directory, "secrets", "tls"),
    process.env.KEIKO_JIRA_LAB_PRIVATE_ADDRESS,
  );
  initializeLabTls(join(directory, "secrets", "tls"), { privateAddress });
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
  let tlsRenewed = false;
  const tlsDirectory = join(directory, "secrets", "tls");
  const privateAddress = readLabPrivateAddress(tlsDirectory);
  if (action === "start") {
    await requireExclusiveLab(session);
    const orphaned = await containersOfMissingNetwork(session);
    if (orphaned.length > 0)
      throw new TypeError(
        `${MISSING_NETWORK_REMEDY} Containers: ${orphaned.map((entry) => `${entry.container} (network ${entry.network})`).join(", ")}`,
      );
    initializeLabTls(tlsDirectory, {
      privateAddress,
      onRenew: () => {
        tlsRenewed = true;
      },
    });
  }
  const commands = [command];
  if (tlsRenewed) commands.push(["up", "-d", "--no-deps", "--force-recreate", "tls"]);
  for (const selected of commands)
    execFileSync(
      "docker",
      [
        "compose",
        "-p",
        session.project,
        ...labComposeFiles(
          join(dirname(fileURLToPath(import.meta.url)), "compose.yaml"),
          join(dirname(fileURLToPath(import.meta.url)), "compose.private.yaml"),
          tlsDirectory,
        ).flatMap((file) => ["-f", file]),
        ...selected,
      ],
      {
        env: {
          ...process.env,
          KEIKO_OS_KEYCHAIN: "off",
          KEIKO_JIRA_LAB_STATE_DIR: directory,
          KEIKO_JIRA_LAB_HTTP_PORT: String(session.httpPort),
          KEIKO_JIRA_LAB_HTTPS_PORT: String(session.httpsPort),
          ...(privateAddress === undefined
            ? {}
            : { KEIKO_JIRA_LAB_PRIVATE_ADDRESS: privateAddress }),
          KEIKO_JIRA_LAB_JIRA_VERSION: session.jiraVersion,
          KEIKO_JIRA_LAB_JIRA_SHA256: session.jiraImageDigest,
        },
        stdio: "inherit",
      },
    );
}
