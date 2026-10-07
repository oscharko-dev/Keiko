#!/usr/bin/env node
// Stops a Coding Workbench run over the dev server's HTTP API.
import { isMainModule } from "../../lib/is-main-module.mjs";
import { UsageError, labBaseUrl, openApiSession, parseCli, runMain } from "./lab-common.mjs";

const USAGE = [
  "usage: node wb-stop.mjs <run-id> [--base-url <origin>]",
  "",
  "Environment: KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET (required), KEIKO_LAB_BASE_URL.",
].join("\n");

async function main() {
  const cli = parseCli({
    usage: USAGE,
    options: { "base-url": { type: "string" } },
    positionals: true,
  });
  if (cli.help) return 0;
  const runId = cli.positionals[0];
  if (runId === undefined) throw new UsageError(`pass the run id to stop\n\n${USAGE}`);
  const session = await openApiSession(labBaseUrl(cli.values["base-url"]));
  const response = await session.request(
    "POST",
    `/api/coding-workbench/runtime/runs/${runId}/stop`,
    {
      requestId: runId,
    },
  );
  console.log("stop", response.status, JSON.stringify(response.json).slice(0, 300));
  return response.status < 300 ? 0 : 1;
}

if (isMainModule(import.meta.url)) runMain(main);
