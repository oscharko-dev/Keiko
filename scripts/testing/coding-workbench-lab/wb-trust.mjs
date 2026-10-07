#!/usr/bin/env node
// Grants or revokes package-script trust for a repository root (ADR-0147 D3), so a run does not
// pause for the operator's decision before it runs the project's own npm scripts. Trust is a
// security decision: the action is always named, and only a lab repository is accepted. The trust
// route names a registered project only, so the lab copy is registered first (once or again, with
// no selection intent: registering itself grants nothing).
import { isMainModule } from "../../lib/is-main-module.mjs";
import {
  UsageError,
  labBaseUrl,
  labRepositoryPath,
  openApiSession,
  parseCli,
  registerLabRepository,
  runMain,
} from "./lab-common.mjs";

const USAGE = [
  "usage: node wb-trust.mjs grant|revoke (--repo <path> | KEIKO_LAB_REPO) [--base-url <origin>]",
  "",
  "The action has no default. The repository is --repo, else KEIKO_LAB_REPO; it must be a lab copy",
  "(its package.json names ledger-lab). The copy is registered with the dev server first, so the",
  "command also works on a state directory that has never seen it.",
  "Environment: KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET (required), KEIKO_LAB_BASE_URL.",
].join("\n");

/** Registers the lab copy, then grants or revokes its trust; the exit code is 0 when the server agreed. */
export async function applyTrust(session, action, repo) {
  const root = await registerLabRepository(
    (path, body) => session.request("POST", path, body),
    repo,
  );
  const response = await session.request(
    action === "grant" ? "POST" : "DELETE",
    "/api/editor/verification/trust",
    { projectId: root },
  );
  console.log(action, response.status, JSON.stringify(response.json).slice(0, 300));
  return response.status < 300 ? 0 : 1;
}

async function main() {
  const cli = parseCli({
    usage: USAGE,
    options: { repo: { type: "string" }, "base-url": { type: "string" } },
    positionals: true,
  });
  if (cli.help) return 0;
  const action = cli.positionals[0];
  if (action !== "grant" && action !== "revoke") {
    throw new UsageError(
      `pass the action, grant or revoke (got ${JSON.stringify(action ?? null)})\n\n${USAGE}`,
    );
  }
  const repo = labRepositoryPath(cli.values.repo);
  const session = await openApiSession(labBaseUrl(cli.values["base-url"]));
  return applyTrust(session, action, repo);
}

if (isMainModule(import.meta.url)) runMain(main);
