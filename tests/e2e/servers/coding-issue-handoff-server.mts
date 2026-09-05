// #3389 — production-composed server for the read-only journey observation/handoff lane. Reuses
// the #3387 draft-delivery server (managed workspace, scripted runtime, git push and PR-create
// transport) verbatim, coordinated onto this lane's own state directory through
// KEIKO_E2E_STATE_DIR (the same mechanism the #3388 CI lane already uses to reuse it), then layers
// the journey GraphQL read fixture over it. No merge or issue-close capability is added anywhere.

import { mkdirSync, writeFileSync } from "node:fs";
import { runIssueDeliveryServer } from "./coding-issue-delivery-server.mjs";
import { installHandoffTransport } from "./coding-issue-handoff-transport.mjs";
import {
  HANDOFF_PORT,
  handoffProviderPath,
  handoffStateDir,
} from "../support/coding-issue-handoff.js";

const stateDir = handoffStateDir();
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  handoffProviderPath(stateDir),
  JSON.stringify({ mode: "open", reads: 0, deniedCalls: 0 }),
);
await runIssueDeliveryServer({ port: HANDOFF_PORT });
installHandoffTransport(stateDir);
