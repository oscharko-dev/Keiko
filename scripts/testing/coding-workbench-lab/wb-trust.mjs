#!/usr/bin/env node
// Grants or revokes package-script trust for a repository root (ADR-0147 D3), so a run does not
// pause for the operator's decision before it runs the project's own npm scripts. Trust is a
// security decision: the action is always named, and only a lab repository is accepted.
import { isMainModule } from "../../lib/is-main-module.mjs";
import {
  UsageError,
  labBaseUrl,
  labRepositoryPath,
  openApiSession,
  parseCli,
  runMain,
} from "./lab-common.mjs";

const USAGE = [
  "usage: node wb-trust.mjs grant|revoke (--repo <path> | KEIKO_LAB_REPO) [--base-url <origin>]",
  "",
  "The action has no default. The repository is --repo, else KEIKO_LAB_REPO; it must be a lab copy",
  "(its package.json names ledger-lab).",
  "Environment: KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET (required), KEIKO_LAB_BASE_URL.",
].join("\n");

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
  const response = await session.request(
    action === "grant" ? "POST" : "DELETE",
    "/api/editor/verification/trust",
    { projectId: repo },
  );
  console.log(action, response.status, JSON.stringify(response.json).slice(0, 300));
  return response.status < 300 ? 0 : 1;
}

if (isMainModule(import.meta.url)) runMain(main);
