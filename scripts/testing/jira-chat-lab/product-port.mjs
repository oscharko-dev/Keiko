import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { URL } from "node:url";
import { verifyStoredCredential } from "../../../packages/keiko-server/dist/atlassian/credentialVerification.js";
import { buildAtlassianConnectorCredentialDeps } from "../../../packages/keiko-server/dist/atlassian/wiring.js";
import { parseAtlassianVerificationProbe } from "../../../packages/keiko-connectors/dist/atlassian-verification-probe.js";
import { assertSessionServerInfo, labSessionConnection, readPrivateFile } from "./lab-client.mjs";

/** Observe the verifier's real response without changing requests, native failures or custody. */
export function sessionVerificationPort(session, port) {
  const origin = labSessionConnection(session).httpsOrigin;
  const serverInfoUrl = `${origin}/rest/api/2/serverInfo`;
  return async (request) => {
    if (new URL(request.url).origin !== origin)
      throw new TypeError("Laboratory product request does not belong to the selected session");
    const result = await port(request);
    if (request.method !== "GET" || request.url !== serverInfoUrl) return result;
    if (result.kind !== "response" || result.status !== 200) return result;
    const parsed = parseAtlassianVerificationProbe(result);
    if ("failure" in parsed) return result;
    assertSessionServerInfo(session, parsed.value);
    return result;
  };
}

export async function withProductPort(tokenPath, tlsDirectory, run, session) {
  const baseUrl = labSessionConnection(session).httpsOrigin;
  const state = mkdtempSync(join(realpathSync(tmpdir()), "keiko-jira-4081-"));
  const network = { trusted: true };
  try {
    const deps = buildAtlassianConnectorCredentialDeps({
      configPath: join(state, "config.json"),
      env: { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
      egress: () =>
        network.trusted ? { caBundlePath: join(resolve(tlsDirectory), "ca.pem") } : undefined,
    });
    const factory = deps.httpBodyPortFactory.bind(deps);
    deps.httpBodyPortFactory = (metadata, correlationId, lifecycle) =>
      sessionVerificationPort(session, factory(metadata, correlationId, lifecycle));
    const metadata = deps.custody.create({
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      displayName: "Synthetic laboratory qualification",
      baseUrl,
      apiToken: readPrivateFile(tokenPath),
    });
    const port = deps.httpBodyPortFactory(metadata, "jira-lab-qualification");
    try {
      return await run({
        port,
        baseUrl,
        network,
        verify: () => verifyStoredCredential(deps, metadata, "jira-lab-qualification"),
      });
    } finally {
      deps.custody.delete(metadata.authRef);
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

export async function productRequest(connection, name, method, path, body, expected = 200) {
  if (!/^\/rest\/api\/2\//.test(path)) throw new TypeError("Unexpected product fixture route");
  const result = await connection.port({
    method,
    url: connection.baseUrl + path,
    timeoutMs: 30_000,
    maxBodyBytes: 65_536,
    ...(body === undefined ? {} : { bodyJson: JSON.stringify(body) }),
  });
  const passed = result.kind === "response" && result.status === expected && !result.truncated;
  console.log(JSON.stringify({ operation: "jira-lab-product", case: name, passed }));
  if (!passed) throw new TypeError("Production Jira fixture request failed");
  return result.bodyText.length === 0 ? undefined : JSON.parse(result.bodyText);
}
