// Reuse ordinary lab seeding; never runs first-time setup, restarts Jira or configures a model.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSession, requireLicense } from "./lab-client.mjs";
import { ensureFixtureAdminToken } from "./seed-identities.mjs";

export async function prepareApiQualification(directory) {
  const session = loadSession(directory);
  await requireLicense(session);
  execFileSync(process.execPath, [join(import.meta.dirname, "seed.mjs"), session.directory], {
    stdio: "inherit",
    env: { ...process.env, KEIKO_OS_KEYCHAIN: "off" },
    timeout: 600_000,
  });
  await ensureFixtureAdminToken(session);
  await requireLicense(session);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [directory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length)
      throw new TypeError("Usage: api-qualification-prepare.mjs <private-session>");
    await prepareApiQualification(directory);
    console.log(JSON.stringify({ operation: "jira-api-qualification-prepare", completed: true }));
  } catch (error) {
    console.log(
      JSON.stringify({
        operation: "jira-api-qualification-prepare",
        completed: false,
        errorType: error instanceof Error ? error.name : "unknown",
        reconcileRequired: true,
      }),
    );
    process.exitCode = 1;
  }
}
