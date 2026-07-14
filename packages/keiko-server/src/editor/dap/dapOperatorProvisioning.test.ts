import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDapOperatorProvisioningDocument } from "./dapOperatorProvisioning.js";

const EXTERNAL_ADAPTER_NAME = ["js", "-", "debug"].join("");

function externalAdapterRoot(): string {
  return `/operator/${EXTERNAL_ADAPTER_NAME}`;
}

function artifact(name: string, capsulePath: string): Record<string, unknown> {
  return {
    hostPath: `/operator/provisioning/${name}`,
    approvedRoot: "/operator/provisioning",
    capsulePath,
  };
}

function document(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    adapter: {
      executableName: EXTERNAL_ADAPTER_NAME,
      executableArgs: ["--server=/run/keiko-debug/dap.sock"],
      trustedRoots: [externalAdapterRoot()],
      approvedPath: ["/operator/node/bin", "/usr/bin"].join(delimiter),
      envAllowlist: ["LANG", "LC_ALL"],
      fixedEnv: { DAP_MODE: "server" },
    },
    launch: {
      adapterApprovedRoot: externalAdapterRoot(),
      node: artifact("node", "/opt/keiko-runtime/node"),
      npm: artifact("npm", "/opt/keiko-runtime/npm/bin/npm-cli.js"),
      shell: artifact("shell", "/opt/keiko-runtime/shell"),
      npmUserConfig: artifact("npm-user-config", "/opt/keiko-debug/npm-user-config"),
      npmGlobalConfig: artifact("npm-global-config", "/opt/keiko-debug/npm-global-config"),
      backend: artifact("bwrap", "/opt/keiko-backend/bwrap"),
      runtimeClosure: [artifact("runtime", "/opt/keiko-runtime/lib")],
      containerImage: "registry.example/keiko-debug@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  };
}

function clone(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function rejected(value: unknown): void {
  expect(parseDapOperatorProvisioningDocument(value)).toStrictEqual({
    ok: false,
    error: { code: "INVALID_DAP_OPERATOR_PROVISIONING" },
  });
}

describe("parseDapOperatorProvisioningDocument", () => {
  it("normalizes a bounded declarative document into immutable DI-safe data", () => {
    const parsed = parseDapOperatorProvisioningDocument(document());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected parsed provisioning");
    expect(parsed.value).toMatchObject({
      schemaVersion: 1,
      adapter: {
        executableName: EXTERNAL_ADAPTER_NAME,
        approvedPath: ["/operator/node/bin", "/usr/bin"].join(delimiter),
        envAllowlist: ["LANG", "LC_ALL"],
        fixedEnv: { DAP_MODE: "server" },
      },
      launch: {
        containerImage: "registry.example/keiko-debug@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    expect(parsed.value.adapter.provisioningDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(parsed.value.adapter.executableArgs)).toBe(true);
    expect(Object.isFrozen(parsed.value.launch.runtimeClosure)).toBe(true);
    expect(parsed.value.adapter).not.toHaveProperty("adapterPreflight");
  });

  it("rejects every unknown key, including attempted function ports", () => {
    const withPort = document();
    const adapter = withPort.adapter as Record<string, unknown>;
    adapter.adapterPreflight = (): void => undefined;
    rejected(withPort);

    const withUnknownLaunchKey = document();
    const launch = withUnknownLaunchKey.launch as Record<string, unknown>;
    launch.commandAllowed = true;
    rejected(withUnknownLaunchKey);
  });

  it("rejects non-object documents and non-string map or array entries", () => {
    rejected('{"schemaVersion":1}');
    const badArgument = document();
    ((badArgument.adapter as Record<string, unknown>).executableArgs as unknown[]) = [
      "--server",
      1,
    ];
    rejected(badArgument);

    const badEnvironment = document();
    (
      (badEnvironment.adapter as Record<string, unknown>).fixedEnv as Record<string, unknown>
    ).DAP_MODE = 1;
    rejected(badEnvironment);
  });

  it("rejects unsupported schemas, duplicate values, and invalid executable strings", () => {
    const unsupported = document();
    unsupported.schemaVersion = 2;
    rejected(unsupported);

    const duplicateRoots = document();
    (duplicateRoots.adapter as Record<string, unknown>).trustedRoots = [
      externalAdapterRoot(),
      externalAdapterRoot(),
    ];
    rejected(duplicateRoots);

    const executablePath = document();
    (executablePath.adapter as Record<string, unknown>).executableName =
      `${externalAdapterRoot()}/server`;
    rejected(executablePath);
  });

  it("rejects relative, empty, NUL-bearing, and malformed PATH entries", () => {
    const relative = document();
    ((relative.launch as Record<string, unknown>).node as Record<string, unknown>).hostPath =
      "relative/node";
    rejected(relative);

    const nul = document();
    (nul.adapter as Record<string, unknown>).executableName = "js\u0000-debug";
    rejected(nul);

    const empty = document();
    (empty.launch as Record<string, unknown>).adapterApprovedRoot = "";
    rejected(empty);

    const malformedPath = document();
    (malformedPath.adapter as Record<string, unknown>).approvedPath =
      "/operator/node/bin" + delimiter;
    rejected(malformedPath);
  });

  it("rejects security-owned environment names and non-empty npm configuration declarations", () => {
    const protectedEnv = document();
    ((protectedEnv.adapter as Record<string, unknown>).fixedEnv as Record<string, unknown>).PATH =
      "/unsafe";
    rejected(protectedEnv);

    const invalidNpmConfig = document();
    (
      (invalidNpmConfig.launch as Record<string, unknown>).npmUserConfig as Record<string, unknown>
    ).capsulePath = "/opt/keiko-debug/other";
    rejected(invalidNpmConfig);
  });

  it("derives a stable content-free identity from normalized map ordering", () => {
    const first = document();
    const second = clone(first);
    (second.adapter as Record<string, unknown>).fixedEnv = { ZED: "z", ALPHA: "a" };
    (first.adapter as Record<string, unknown>).fixedEnv = { ALPHA: "a", ZED: "z" };
    const parsedFirst = parseDapOperatorProvisioningDocument(first);
    const parsedSecond = parseDapOperatorProvisioningDocument(second);
    expect(parsedFirst.ok && parsedSecond.ok).toBe(true);
    if (!parsedFirst.ok || !parsedSecond.ok) throw new Error("expected parsed provisioning");
    expect(parsedFirst.value.adapter.provisioningDigest).toBe(
      parsedSecond.value.adapter.provisioningDigest,
    );
  });
});
