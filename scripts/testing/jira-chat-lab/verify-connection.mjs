// Real Jira/HTTPS qualification of production custody, adapter and domain verification.
// Run after build:packages and tls-front.mjs. No model or Jira write qualification is implied.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyJiraDataCenterConnection } from "@oscharko-dev/keiko-connectors";
import { buildAtlassianConnectorCredentialDeps } from "../../../packages/keiko-server/dist/atlassian/wiring.js";

const [tokenPath, tlsDirectory] = process.argv.slice(2);
if (!tokenPath || !tlsDirectory)
  throw new TypeError("Usage: verify-connection.mjs <private-pat-file> <private-tls-directory>");
const tokenStat = lstatSync(tokenPath);
if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || (tokenStat.mode & 0o077) !== 0)
  throw new TypeError("Lab token file must be private and regular");
const state = mkdtempSync(join(realpathSync(tmpdir()), "keiko-jira-4081-"));
const baseUrl = "https://127.0.0.1:18443";
let admitted = true;
let trusted = true;
const deps = buildAtlassianConnectorCredentialDeps({
  configPath: join(state, "config.json"),
  env: { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
  networkConfig: () => ({
    privateTargets: admitted ? [{ baseUrl, addressClass: "loopback" }] : [],
  }),
  egress: () => (trusted ? { caBundlePath: join(resolve(tlsDirectory), "ca.pem") } : undefined),
});

try {
  const metadata = deps.custody.create({
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    displayName: "Synthetic connectivity qualification",
    baseUrl,
    apiToken: readFileSync(tokenPath, "utf8").trim(),
  });
  for (const scenario of [
    { name: "trusted-https", admitted: true, trusted: true, expected: "ok" },
    { name: "untrusted-certificate", admitted: true, trusted: false, expected: "tls-failed" },
    { name: "admission-revoked", admitted: false, trusted: true, expected: "unreachable" },
  ]) {
    admitted = scenario.admitted;
    trusted = scenario.trusted;
    const outcome = await verifyJiraDataCenterConnection(
      deps.httpBodyPortFactory(metadata, "jira-lab-connection"),
      baseUrl,
    );
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
  deps.custody.delete(metadata.authRef);
} finally {
  rmSync(state, { recursive: true, force: true });
}
