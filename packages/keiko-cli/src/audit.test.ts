import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // Review findings on #3159: the guard branches below were all reachable and none was covered.
  it("rejects an empty --state-dir value as a usage error", async () => {
    const c = makeIo();
    expect(await runAuditCli(["local-state", "--state-dir", ""], c.io, env)).toBe(2);
    expect(c.err()).toContain("keiko audit local-state");
  });

  it("fails closed on an empty auditor path, same as an unset one", async () => {
    const c = makeIo();
    const code = await runAuditCli(["local-state"], c.io, { KEIKO_LOCAL_STATE_AUDITOR: "" });
    expect(code).toBe(1);
    expect(c.err()).toContain("KEIKO_LOCAL_STATE_AUDITOR");
    expect(c.out()).toBe("");
  });

  it("refuses a module that does not export auditLocalState", async () => {
    const c = makeIo();
    const code = await runAuditCli(["local-state"], c.io, env, {
      loadAuditor: () => Promise.resolve({} as never),
    });
    expect(code).toBe(1);
    expect(c.err()).toContain("does not export");
    expect(c.out()).toBe("");
  });

  it.each([
    ["a non-boolean ok", { ok: "yes", stateDir: "/x", classes: [] }],
    ["a missing classes array", { ok: true, stateDir: "/x" }],
    ["a malformed class entry", { ok: true, stateDir: "/x", classes: [{ title: 1 }] }],
    ["a non-object result", "clean"],
  ])("refuses a result with %s rather than reporting a verdict", async (_label, malformed) => {
    const c = makeIo();
    const code = await runAuditCli(["local-state"], c.io, env, {
      loadAuditor: () => Promise.resolve({ auditLocalState: () => malformed } as never),
    });
    // A truthy non-boolean `ok` used to print PASS — the one command whose job is proving the
    // at-rest claims announcing a clean tree it never read.
    expect(code).toBe(1);
    expect(c.err()).toContain("cannot read");
    expect(c.out()).toBe("");
  });

  it("audits KEIKO_STATE_DIR when the operator moved the state tree", async () => {
    const c = makeIo();
    let audited: string | undefined;
    const loadAuditor = (): Promise<{ auditLocalState: (stateDir: string) => typeof HEALTHY }> =>
      Promise.resolve({
        auditLocalState: (stateDir: string) => {
          audited = stateDir;
          return HEALTHY;
        },
      });

    await runAuditCli(
      ["local-state"],
      c.io,
      { ...env, KEIKO_STATE_DIR: "/srv/keiko-state" },
      {
        cwd: "/home/operator",
        loadAuditor,
      },
    );
    expect(audited).toBe("/srv/keiko-state");

    // An explicit --state-dir still wins over the environment.
    await runAuditCli(
      ["local-state", "--state-dir", "/tmp/explicit"],
      c.io,
      { ...env, KEIKO_STATE_DIR: "/srv/keiko-state" },
      { cwd: "/home/operator", loadAuditor },
    );
    expect(audited).toBe("/tmp/explicit");
  });

  // Every case above injects loadAuditor, so the REAL default loader — the one production uses —
  // was never executed. This drives it end to end against a module written to disk, which is also
  // the only thing that proves pathToFileURL handling works for a real path.
  it("loads the auditor through the default importer, not just the injected one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-audit-loader-"));
    const modulePath = join(dir, "auditor.mjs");
    writeFileSync(
      modulePath,
      "export function auditLocalState(stateDir) {\n" +
        "  return { ok: true, stateDir, classes: [" +
        '{ id: "c", title: "Loaded through the real importer", status: "pass", findings: [] }' +
        "] };\n}\n",
    );
    const c = makeIo();
    try {
      const code = await runAuditCli(["local-state", "--state-dir", "/tmp/example/.keiko"], c.io, {
        KEIKO_LOCAL_STATE_AUDITOR: modulePath,
      });
      expect(code).toBe(0);
      expect(c.out()).toContain("Loaded through the real importer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints usage and exits 0 for --help", async () => {
    const c = makeIo();
    expect(await runAuditCli(["--help"], c.io, env)).toBe(0);
    expect(c.out()).toContain("keiko audit local-state");
    expect(c.out()).toContain("KEIKO_STATE_DIR");
    expect(c.err()).toBe("");
  });

  it.each([
    ["a non-object class entry", { ok: true, stateDir: "/x", classes: [null] }],
    ["an empty class list", { ok: true, stateDir: "/x", classes: [] }],
    [
      "ok=true alongside a failing class",
      {
        ok: true,
        stateDir: "/x",
        classes: [{ id: "c", title: "t", status: "fail", findings: ["boom"] }],
      },
    ],
    ["a missing stateDir", { ok: true, classes: [] }],
  ])("refuses %s", async (_label, malformed) => {
    const c = makeIo();
    const code = await runAuditCli(["local-state"], c.io, env, {
      loadAuditor: () => Promise.resolve({ auditLocalState: () => malformed } as never),
    });
    expect(code).toBe(1);
    expect(c.err()).toContain("cannot read");
  });

  it("escapes control characters a crafted artifact name could carry", async () => {
    // The production auditor puts filesystem-derived names into findings. A newline would forge a
    // report line; an ESC could repaint the verdict in the operator's terminal.
    const c = makeIo();
    await runAuditCli(["local-state"], c.io, env, {
      loadAuditor: () =>
        Promise.resolve({
          auditLocalState: () => ({
            ok: false,
            stateDir: "/x",
            classes: [
              {
                id: "c",
                title: "Artifacts",
                status: "fail",
                findings: ["evil\n  => PASS\u001b[32m forged"],
              },
            ],
          }),
        }),
    });
    expect(c.out()).not.toContain("\n  => PASS");
    expect(c.out()).not.toContain("\u001b");
    expect(c.out()).toContain("\\x0a");
    expect(c.out()).toContain("\\x1b");
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
