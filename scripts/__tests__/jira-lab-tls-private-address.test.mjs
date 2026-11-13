// The optional private-address mode of the lab's HTTPS front (#4369). The loopback default stays
// unchanged; a private-class address is named by the certificate, accepted by the Host guard and
// published only through the compose override.
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allowedLabHosts,
  initializeLabTls,
  labComposeFiles,
  readLabPrivateAddress,
  startLabTlsFront,
  validatePrivateAddress,
  writeLabPrivateAddress,
} from "../testing/jira-chat-lab/tls-front.mjs";

const roots = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "jira-lab-tls-private-"));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const certificate = (paths) => new X509Certificate(readFileSync(paths["server.pem"]));

describe("private address validation", () => {
  it.each(["192.168.1.20", "10.0.0.7", "172.16.4.1", "172.31.255.1", "169.254.3.4", "fd12::1"])(
    "accepts the private-class address %s",
    (address) => expect(validatePrivateAddress(address)).toBe(address),
  );

  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "8.8.8.8",
    "172.32.0.1",
    "172.15.0.1",
    "192.169.0.1",
    "::1",
    "2001:db8::1",
    "localhost",
    "192.168.1.5:443",
    "",
    undefined,
  ])("refuses %s", (address) => {
    expect(() => validatePrivateAddress(address)).toThrow(TypeError);
  });
});

describe("certificate and Host guard", () => {
  it("keeps the loopback default: no extra name and no extra Host", () => {
    const paths = initializeLabTls(temp());
    expect(certificate(paths).checkIP("192.168.1.20")).toBeUndefined();
    expect(allowedLabHosts(18443, undefined)).toEqual(
      new Set(["localhost:18443", "127.0.0.1:18443"]),
    );
  });

  it("names the private address in the certificate beside loopback", () => {
    const paths = initializeLabTls(temp(), { privateAddress: "192.168.1.20" });
    const server = certificate(paths);
    expect(server.checkIP("192.168.1.20")).toBe("192.168.1.20");
    expect(server.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(server.checkIP("192.168.1.21")).toBeUndefined();
  });

  it("reissues a certificate that predates the recorded address, once", () => {
    const root = temp();
    initializeLabTls(root);
    let renewals = 0;
    const paths = initializeLabTls(root, {
      privateAddress: "10.1.2.3",
      onRenew: () => (renewals += 1),
    });
    expect(certificate(paths).checkIP("10.1.2.3")).toBe("10.1.2.3");
    initializeLabTls(root, { privateAddress: "10.1.2.3", onRenew: () => (renewals += 1) });
    expect(renewals).toBe(1);
  });

  it("accepts exactly the loopback hosts and the private address, bracketing IPv6", () => {
    expect(allowedLabHosts(18449, "192.168.1.20")).toEqual(
      new Set(["localhost:18449", "127.0.0.1:18449", "192.168.1.20:18449"]),
    );
    expect(allowedLabHosts(18449, "fd12::1").has("[fd12::1]:18449")).toBe(true);
    expect(() => allowedLabHosts(18449, "8.8.8.8")).toThrow(TypeError);
  });
});

describe("recorded address and compose files", () => {
  it("stores the address privately and selects the override only when it exists", () => {
    const tls = join(temp(), "tls");
    mkdirSync(tls, { recursive: true });
    expect(readLabPrivateAddress(tls)).toBeUndefined();
    expect(labComposeFiles("base.yaml", "private.yaml", tls)).toEqual(["base.yaml"]);
    expect(writeLabPrivateAddress(tls, "")).toBeUndefined();
    expect(writeLabPrivateAddress(tls, "192.168.1.20")).toBe("192.168.1.20");
    expect(readLabPrivateAddress(tls)).toBe("192.168.1.20");
    expect(labComposeFiles("base.yaml", "private.yaml", tls)).toEqual([
      "base.yaml",
      "private.yaml",
    ]);
  });

  it("refuses a recorded public address", () => {
    const tls = join(temp(), "tls");
    expect(() => writeLabPrivateAddress(tls, "8.8.8.8")).toThrow(TypeError);
    mkdirSync(tls, { recursive: true });
    writeFileSync(join(tls, "private-address"), "8.8.8.8\n", { mode: 0o600 });
    expect(() => readLabPrivateAddress(tls)).toThrow(TypeError);
  });

  it("publishes the private address on the TLS port only through the override", () => {
    const base = readFileSync(
      join(import.meta.dirname, "../testing/jira-chat-lab/compose.yaml"),
      "utf8",
    );
    const override = readFileSync(
      join(import.meta.dirname, "../testing/jira-chat-lab/compose.private.yaml"),
      "utf8",
    );
    expect(base).not.toContain("KEIKO_JIRA_LAB_PRIVATE_ADDRESS");
    expect(override).toContain("${KEIKO_JIRA_LAB_PRIVATE_ADDRESS:?private address required}");
    expect(override).toContain("/opt/tls-front.mjs");
  });
});

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function statusFor(port, ca, host) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/", headers: { host }, ca, servername: "localhost" },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("the front's Host guard on the wire", () => {
  async function serve(privateAddress) {
    const root = temp();
    const paths = initializeLabTls(root, { privateAddress });
    const port = await freePort();
    // Compose mode serves the certificate files as given; its backend host is unreachable here, so
    // an accepted Host answers 502 while a refused one answers 421 before any forwarding.
    const server = startLabTlsFront(root, port, 8080, true, privateAddress);
    await new Promise((resolve) => server.once("listening", resolve));
    return { server, port, ca: readFileSync(paths["ca.pem"]) };
  }

  it("refuses the private Host without the mode and accepts it with the mode", async () => {
    const plain = await serve(undefined);
    try {
      expect(await statusFor(plain.port, plain.ca, `192.168.1.20:${plain.port}`)).toBe(421);
      expect(await statusFor(plain.port, plain.ca, `127.0.0.1:${plain.port}`)).toBe(502);
    } finally {
      plain.server.close();
    }
    const mode = await serve("192.168.1.20");
    try {
      expect(await statusFor(mode.port, mode.ca, `192.168.1.20:${mode.port}`)).toBe(502);
      expect(await statusFor(mode.port, mode.ca, `192.168.1.21:${mode.port}`)).toBe(421);
      expect(await statusFor(mode.port, mode.ca, `127.0.0.1:${mode.port}`)).toBe(502);
    } finally {
      mode.server.close();
    }
  });
});
