import { describe, expect, it } from "vitest";

import { parseAuditArgs, runAuditCli } from "./audit.js";
import type { CliIo } from "./runner.js";

function makeIo(): { io: CliIo; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

const HEALTHY = {
  ok: true,
  stateDir: "/tmp/example/.keiko",
  classes: [{ id: "creds", title: "Credential references", status: "pass", findings: [] }],
};

const DRIFTED = {
  ok: false,
  stateDir: "/tmp/example/.keiko",
  classes: [
    {
      id: "creds",
      title: "Credential references",
      status: "fail",
      findings: ["keiko.config.json holds a plaintext value where a cred: reference belongs"],
    },
  ],
};

describe("parseAuditArgs", () => {
  it("accepts local-state with and without an explicit state dir", () => {
    expect(parseAuditArgs(["local-state"])).toEqual({ kind: "args", stateDir: undefined });
    expect(parseAuditArgs(["local-state", "--state-dir", "/srv/.keiko"])).toEqual({
      kind: "args",
      stateDir: "/srv/.keiko",
    });
  });

  it("refuses a --state-dir value that looks like a flag", () => {
    // Swallowing "-h" as the path would audit the wrong tree and report on a directory the
    // operator never named. Same guard as scripts/check-local-state.mjs's parser.
    expect(parseAuditArgs(["local-state", "--state-dir", "-h"])).toEqual({ kind: "usage" });
    expect(parseAuditArgs(["local-state", "--state-dir"])).toEqual({ kind: "usage" });
  });

  it("treats an unknown subcommand or stray flag as a usage error", () => {
    expect(parseAuditArgs([])).toEqual({ kind: "usage" });
    expect(parseAuditArgs(["everything"])).toEqual({ kind: "usage" });
    expect(parseAuditArgs(["local-state", "--deep"])).toEqual({ kind: "usage" });
  });

  it("routes help through", () => {
    expect(parseAuditArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseAuditArgs(["local-state", "-h"])).toEqual({ kind: "help" });
  });
});

describe("runAuditCli", () => {
  const env = { KEIKO_LOCAL_STATE_AUDITOR: "/opt/keiko/scripts/lib/local-state-audit.mjs" };

  it("reports a healthy tree and exits 0", async () => {
    const c = makeIo();
    const code = await runAuditCli(
      ["local-state", "--state-dir", "/tmp/example/.keiko"],
      c.io,
      env,
      {
        loadAuditor: () => Promise.resolve({ auditLocalState: () => HEALTHY }),
      },
    );
    expect(code).toBe(0);
    expect(c.out()).toContain("[PASS] Credential references");
    expect(c.out()).toContain("local-state: PASS");
  });

  it("reports each finding and exits 1 on a drifted tree", async () => {
    const c = makeIo();
    const code = await runAuditCli(
      ["local-state", "--state-dir", "/tmp/example/.keiko"],
      c.io,
      env,
      {
        loadAuditor: () => Promise.resolve({ auditLocalState: () => DRIFTED }),
      },
    );
    expect(code).toBe(1);
    expect(c.out()).toContain("plaintext value where a cred: reference belongs");
    expect(c.err()).toContain("local-state: FAIL");
  });

  it("defaults the state dir to <cwd>/.keiko", async () => {
    const c = makeIo();
    let audited: string | undefined;
    await runAuditCli(["local-state"], c.io, env, {
      cwd: "/home/operator",
      loadAuditor: () =>
        Promise.resolve({
          auditLocalState: (stateDir: string) => {
            audited = stateDir;
            return HEALTHY;
          },
        }),
    });
    expect(audited?.replaceAll("\\", "/")).toBe("/home/operator/.keiko");
  });

  it("fails closed when the auditor module cannot be loaded", async () => {
    const c = makeIo();
    const code = await runAuditCli(["local-state"], c.io, env, {
      loadAuditor: () => Promise.reject(new Error("ERR_MODULE_NOT_FOUND")),
    });
    expect(code).toBe(1);
    expect(c.err()).toContain("could not run");
    // The report must not claim anything about the tree it never read.
    expect(c.out()).toBe("");
  });
});
