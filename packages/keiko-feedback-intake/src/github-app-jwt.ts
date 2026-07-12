import type { GithubAppSignerSnapshot } from "./github-app-key.js";

const APP_ID = /^[1-9][0-9]{0,19}$/u;

function encode(value: Uint8Array | string): string {
  return Buffer.from(value).toString("base64url");
}

export function createGithubAppJwt(
  appId: string,
  signer: GithubAppSignerSnapshot,
  trustedNow: Date,
  lifetimeSeconds = 540,
): string {
  if (!APP_ID.test(appId) || lifetimeSeconds < 1 || lifetimeSeconds > 600) {
    throw new Error("GitHub App authentication is unavailable");
  }
  const now = Math.floor(trustedNow.getTime() / 1000);
  if (!Number.isSafeInteger(now)) throw new Error("GitHub App authentication is unavailable");
  const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = encode(JSON.stringify({ iat: now - 30, exp: now + lifetimeSeconds, iss: appId }));
  const signingInput = `${header}.${claims}`;
  return `${signingInput}.${encode(signer.signRs256(Buffer.from(signingInput)))}`;
}
