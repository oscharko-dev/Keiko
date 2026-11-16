import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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

it("recovers an interrupted publication with a mismatched CA key before starting the front", async () => {
  const { copyFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "jira-lab-tls-partial-"));
  const other = mkdtempSync(join(tmpdir(), "jira-lab-tls-other-"));
  try {
    const paths = initializeLabTls(root);
    const replacement = initializeLabTls(other);
    copyFileSync(replacement["ca.key"], paths["ca.key"]);
    initializeLabTls(root);
    const ca = new X509Certificate(readFileSync(paths["ca.pem"]));
    expect(new X509Certificate(readFileSync(paths["server.pem"])).verify(ca.publicKey)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

it("renews exactly at seven days and retains the generation one second before that boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "jira-lab-tls-boundary-"));
  try {
    const paths = initializeLabTls(root);
    const deadline = Math.min(
      ...["ca.pem", "server.pem"].map((name) =>
        Date.parse(new X509Certificate(readFileSync(paths[name])).validTo),
      ),
    );
    let renewals = 0;
    initializeLabTls(root, {
      now: () => deadline - 7 * 86_400_000 - 1000,
      onRenew: () => {
        renewals += 1;
      },
    });
    expect(renewals).toBe(0);
    initializeLabTls(root, {
      now: () => deadline - 7 * 86_400_000,
      onRenew: () => {
        renewals += 1;
      },
    });
    expect(renewals).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("recovers on the next start after publication stops between the CA key and certificate", async () => {
  const { renameSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "jira-lab-tls-publish-failure-"));
  try {
    const paths = initializeLabTls(root);
    const deadline = Math.min(
      ...["ca.pem", "server.pem"].map((name) =>
        Date.parse(new X509Certificate(readFileSync(paths[name])).validTo),
      ),
    );
    expect(() =>
      initializeLabTls(root, {
        now: () => deadline - 7 * 86_400_000,
        publishFile: (from, to) => {
          renameSync(from, to);
          throw new Error("Synthetic interrupted publication");
        },
      }),
    ).toThrow("Synthetic interrupted publication");
    initializeLabTls(root);
    const ca = new X509Certificate(readFileSync(paths["ca.pem"]));
    expect(new X509Certificate(readFileSync(paths["server.pem"])).verify(ca.publicKey)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a broken certificate symlink before any generator can follow it", () => {
  const root = mkdtempSync(join(tmpdir(), "jira-lab-tls-link-"));
  const external = join(root, "external-secret");
  try {
    symlinkSync(external, join(root, "server.key"));
    expect(() => initializeLabTls(root)).toThrow();
    expect(existsSync(external)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
