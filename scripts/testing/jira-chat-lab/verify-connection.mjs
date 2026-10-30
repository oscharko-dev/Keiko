// Real Jira/HTTPS qualification of production custody, adapter and domain verification.
import assert from "node:assert/strict";
import { verifyJiraDataCenterConnection } from "@oscharko-dev/keiko-connectors";
import { withProductPort } from "./product-port.mjs";

const [tokenPath, tlsDirectory] = process.argv.slice(2);
if (!tokenPath || !tlsDirectory)
  throw new TypeError("Usage: verify-connection.mjs <private-pat-file> <private-tls-directory>");

await withProductPort(tokenPath, tlsDirectory, async ({ port, baseUrl, network }) => {
  for (const scenario of [
    { name: "trusted-https", admitted: true, trusted: true, expected: "ok" },
    { name: "untrusted-certificate", admitted: true, trusted: false, expected: "tls-failed" },
    { name: "admission-revoked", admitted: false, trusted: true, expected: "unreachable" },
  ]) {
    network.admitted = scenario.admitted;
    network.trusted = scenario.trusted;
    const outcome = await verifyJiraDataCenterConnection(port, baseUrl);
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
}).catch(() => {
  console.error("jira-lab-connection: qualification failed");
  process.exitCode = 1;
});
