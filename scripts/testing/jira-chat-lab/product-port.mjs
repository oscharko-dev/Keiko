import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAtlassianConnectorCredentialDeps } from "../../../packages/keiko-server/dist/atlassian/wiring.js";
import { readPrivateFile } from "./lab-client.mjs";

export async function withProductPort(tokenPath, tlsDirectory, run) {
  const state = mkdtempSync(join(realpathSync(tmpdir()), "keiko-jira-4081-"));
  const baseUrl = "https://127.0.0.1:18443";
  const network = { admitted: true, trusted: true };
  try {
    const deps = buildAtlassianConnectorCredentialDeps({
      configPath: join(state, "config.json"),
      env: { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
      networkConfig: () => ({
        privateTargets: network.admitted ? [{ baseUrl, addressClass: "loopback" }] : [],
      }),
      egress: () =>
        network.trusted ? { caBundlePath: join(resolve(tlsDirectory), "ca.pem") } : undefined,
    });
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
      return await run({ port, baseUrl, network });
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
