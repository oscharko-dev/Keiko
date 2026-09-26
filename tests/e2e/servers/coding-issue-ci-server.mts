import { mkdirSync, writeFileSync } from "node:fs";
import { CI_PORT, ciStateDir, ciProviderPath } from "../support/coding-issue-ci.js";
import { runIssueDeliveryServer } from "./coding-issue-delivery-server.mjs";
import { createCiFixtureReader } from "./coding-issue-ci-fixture.mjs";

const stateDir = ciStateDir();
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  ciProviderPath(stateDir),
  JSON.stringify({ mode: "pending", reads: 0, rejectedTargets: 0 }),
);
await runIssueDeliveryServer({ port: CI_PORT, ciReader: () => createCiFixtureReader(stateDir) });
