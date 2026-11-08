import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { initializeLabTls } from "../testing/jira-chat-lab/tls-front.mjs";

it("gives both verified lab certificates at least 180 days of remaining validity", () => {
  const root = mkdtempSync(join(tmpdir(), "jira-lab-tls-lifetime-"));
  try {
    const paths = initializeLabTls(root);
    for (const name of ["ca.pem", "server.pem"]) {
      const cert = new X509Certificate(readFileSync(paths[name]));
      expect(Date.parse(cert.validTo) - Date.now()).toBeGreaterThan(180 * 86_400_000);
    }
    expect(
      new X509Certificate(readFileSync(paths["server.pem"])).verify(
        new X509Certificate(readFileSync(paths["ca.pem"])).publicKey,
      ),
    ).toBe(true);
    expect(readFileSync(initializeLabTls(root)["ca.pem"], "utf8")).toBe(
      readFileSync(paths["ca.pem"], "utf8"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("renews an existing certificate before a long run can cross its expiry", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "jira-lab-tls-renewal-"));
  try {
    const paths = initializeLabTls(root);
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        "server.csr",
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        "server.pem",
        "-days",
        "1",
        "-sha256",
        "-extfile",
        "server.ext",
      ],
      { cwd: root, stdio: "ignore" },
    );
    let renewed = false;
    initializeLabTls(root, {
      onRenew: () => {
        renewed = true;
      },
    });
    expect(renewed).toBe(true);
    expect(
      Date.parse(new X509Certificate(readFileSync(paths["server.pem"])).validTo) - Date.now(),
    ).toBeGreaterThan(180 * 86_400_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
