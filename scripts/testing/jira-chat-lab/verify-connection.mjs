// Real Jira/HTTPS qualification of production custody, adapter and domain verification.
import assert from "node:assert/strict";
import { withProductPort } from "./product-port.mjs";
import { loadSession } from "./lab-client.mjs";

const [tokenPath, tlsDirectory, sessionDirectory, ...extra] = process.argv.slice(2);
if (!tokenPath || !tlsDirectory || extra.length !== 0)
  throw new TypeError(
    "Usage: verify-connection.mjs <private-pat-file> <private-tls-directory> [private-session-directory]",
  );
const session = sessionDirectory === undefined ? undefined : loadSession(sessionDirectory);

await withProductPort(
  tokenPath,
  tlsDirectory,
  async ({ verify, network }) => {
    for (const scenario of [
      { name: "trusted-https", trusted: true, expected: "ok" },
      { name: "untrusted-certificate", trusted: false, expected: "tls-failed" },
      { name: "stored-connection-reused", trusted: true, expected: "ok" },
    ]) {
      network.trusted = scenario.trusted;
      const outcome = await verify();
      console.log(
        JSON.stringify({
          operation: "jira-lab-connection",
          case: scenario.name,
          outcome,
          passed: outcome === scenario.expected,
        }),
      );
      assert.equal(outcome, scenario.expected);
    }
  },
  session,
).catch(() => {
  console.error("jira-lab-connection: qualification failed");
  process.exitCode = 1;
});
