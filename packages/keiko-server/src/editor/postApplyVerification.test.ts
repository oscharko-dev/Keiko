// Issue #1204 — post-apply verification: content-free summaries, the network-isolation probe, and a
// live proof that the enforced `network:"none"` boundary the orchestrator emits denies egress
// (ADR-0043 AC8/AC15). The egress proof is host-adaptive: it runs the keiko-tools `runCommand` boundary
// the verification orchestrator uses, asserting an outbound connection from inside `network:"none"`
// fails while it succeeds without isolation (the negative control). It self-skips loudly when no
// enforcing backend is available, mirroring keiko-sandbox/egress.test.ts.

import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_POLICY, runCommand, type CommandRule } from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  defaultPostApplyVerification,
  notRunVerificationSummary,
  probeNetworkIsolation,
  requiresPostApplyVerificationPreflight,
  skippedVerificationSummary,
} from "./postApplyVerification.js";

const CONNECT_SNIPPET = [
  "const net = require('net');",
  "const s = net.connect({ host: '1.1.1.1', port: 443 });",
  "s.setTimeout(5000);",
  "s.on('connect', () => { process.stdout.write('CONNECTED'); s.destroy(); process.exit(0); });",
  "s.on('error', () => { process.stdout.write('BLOCKED'); process.exit(3); });",
  "s.on('timeout', () => { process.stdout.write('TIMEOUT'); s.destroy(); process.exit(3); });",
].join("");

const NODE_RULES: readonly CommandRule[] = [{ executable: "node" }];

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

function workspaceOf(
  root: string,
  testFramework: WorkspaceInfo["testFramework"] = "unknown",
): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework,
    sourceDirs: ["src"],
    testDirs: ["test"],
    languages: [],
    ignoreLines: [],
  };
}

describe("post-apply verification summaries (content-free)", () => {
  it("not-run summary is post-apply, redacted, and carries the bounded envelope", () => {
    const s = notRunVerificationSummary();
    expect(s.outcome).toBe("not-run");
    expect(s.preApply).toBe(false);
    expect(s.secretsRedacted).toBe(true);
    expect(s.networkEnforced).toBe(false);
    expect(s.bounds.envAllowlistCount).toBeGreaterThan(0);
    expect(s.bounds.wallTimeMs).toBeGreaterThan(0);
  });

  it("skipped summary reflects an explicit policy skip", () => {
    const s = skippedVerificationSummary();
    expect(s.outcome).toBe("skipped");
    expect(s.preApply).toBe(false);
  });
});

describe("probeNetworkIsolation", () => {
  it("returns a backend label and availability for the host", () => {
    const probe = probeNetworkIsolation(process.cwd());
    expect(typeof probe.backend).toBe("string");
    expect(probe.backend.length).toBeGreaterThan(0);
    expect(typeof probe.available).toBe("boolean");
  });
});

describe("defaultPostApplyVerification", () => {
  it("reports not-run when no targeted test resolves for the applied files", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-postapply-")));
    try {
      const result = await defaultPostApplyVerification({
        realRoot: root,
        appliedTestFiles: [],
        signal: new AbortController().signal,
      });
      expect(result.summary.outcome).toBe("not-run");
      expect(result.command).toBe("none");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("requiresPostApplyVerificationPreflight", () => {
  it("requires sandbox preflight for newly-created direct targets before they exist", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-postapply-preflight-")));
    try {
      expect(
        requiresPostApplyVerificationPreflight(workspaceOf(root, "vitest"), ["src/new.test.ts"]),
      ).toBe(true);
      expect(
        requiresPostApplyVerificationPreflight(workspaceOf(root, "vitest"), ["src/source.ts"]),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not require sandbox preflight for empty targets or unknown test frameworks", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-postapply-preflight-")));
    try {
      expect(requiresPostApplyVerificationPreflight(workspaceOf(root, "vitest"), [])).toBe(false);
      expect(
        requiresPostApplyVerificationPreflight(workspaceOf(root, "unknown"), [
          "src/new.test.ts",
        ]),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("enforced egress denial through the verification command boundary (ADR-0043 AC8/AC15)", () => {
  it("blocks an outbound connection under the network:'none' runCommand the orchestrator emits", async () => {
    const cwd = process.cwd();
    const probe = probeNetworkIsolation(cwd);
    if (!probe.available) {
      note(
        `[1204-egress-proof] no enforcing network backend on this host (backend=${probe.backend}); ` +
          `network:'none' verification fails closed by construction.`,
      );
      return;
    }
    const signal = new AbortController().signal;
    // Negative control: without isolation the same child reaches the remote host.
    const control = await runCommand(
      { command: "node", args: ["-e", CONNECT_SNIPPET], cwd: undefined, timeoutMs: 20_000, signal },
      {
        workspace: workspaceOf(cwd),
        policy: { ...DEFAULT_SANDBOX_POLICY, network: "inherit" },
        commandRules: NODE_RULES,
        spawn: nodeSpawnFn,
        processEnv: process.env,
        now: () => Date.now(),
      },
    );
    if (control.stdout.trim() !== "CONNECTED") {
      note(
        `[1204-egress-proof] negative control could not reach the probe host (got ` +
          `"${control.stdout.trim()}"); environment has no egress, nothing to prove.`,
      );
      return;
    }
    // The enforced run: identical command under network:'none' must be unable to reach the host.
    const isolated = await runCommand(
      { command: "node", args: ["-e", CONNECT_SNIPPET], cwd: undefined, timeoutMs: 20_000, signal },
      {
        workspace: workspaceOf(cwd),
        policy: { ...DEFAULT_SANDBOX_POLICY, network: "none" },
        commandRules: NODE_RULES,
        spawn: nodeSpawnFn,
        processEnv: process.env,
        now: () => Date.now(),
      },
    );
    expect(isolated.attestation?.networkEnforced).toBe(true);
    expect(isolated.stdout.trim()).not.toBe("CONNECTED");
    expect(["BLOCKED", "TIMEOUT"]).toContain(isolated.stdout.trim());
  }, 60_000);
});
