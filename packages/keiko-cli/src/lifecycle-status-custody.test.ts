// #4358: `keiko status` states how the server keeps its credential vaults on Windows. Each closed
// state has its own sentence; "unattested" and "exposed" never read like "attested".
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import { runLifecycleCli } from "./lifecycle.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function status(credentialCustody: unknown): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-status-custody-")));
  roots.push(root);
  mkdirSync(join(root, ".keiko"), { recursive: true });
  writeFileSync(join(root, ".keiko", "ui.pid"), "12345\n");
  let out = "";
  const code = await runLifecycleCli(
    "status",
    [],
    {
      out: (text) => {
        out += text;
      },
      err: () => undefined,
    },
    {},
    {
      cwd: root,
      isProcessAlive: () => true,
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            status: "ok",
            version: KEIKO_PRODUCT_VERSION,
            diagnostics: {
              readiness: "ready",
              reasons: [],
              writer: "production-file",
              lostEvents: 0,
            },
            ...(credentialCustody === undefined ? {} : { credentialCustody }),
          }),
        ),
    },
  );
  expect(code).toBe(0);
  return out;
}

describe("keiko status reports credential custody", () => {
  it("says attested only for the attested state", async () => {
    const out = await status("attested");
    expect(out).toContain(
      "Credential custody: attested (the credential key file and its folder are private to this Windows account).",
    );
  });

  it("says unattested, and nothing that reads like attested, when Windows could not be asked", async () => {
    const out = await status("unattested");
    expect(out).toContain("Credential custody: unattested (");
    expect(out).toContain("nothing is claimed");
    expect(out).not.toContain("attested (the credential key file");
    expect(out).not.toContain("are private to this Windows account");
  });

  it("tells the person to replace stored tokens after an exposure", async () => {
    const out = await status("exposed");
    expect(out).toContain("Credential custody: exposed (");
    expect(out).toContain("replace stored tokens such as the Jira token");
    expect(out).not.toContain("are private to this Windows account");
  });

  it("says protected when only the folder had been open", async () => {
    const out = await status("protected");
    expect(out).toContain("Credential custody: protected (");
    expect(out).toContain("the key itself was not readable");
  });

  it.each([undefined, "ATTESTED", "ok", true, 1, { state: "attested" }, "attested "])(
    "prints no custody line for %j, which is not one of the closed states",
    async (value) => {
      expect(await status(value)).not.toContain("Credential custody");
    },
  );
});
