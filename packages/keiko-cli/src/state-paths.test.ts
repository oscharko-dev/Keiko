import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STATE_DIR_NAME,
  KEIKO_STATE_FILES,
  classifyPid,
  defaultIsProcessAlive,
  isInsidePath,
  readPidFile,
  resolveStateDir,
  scanRuntimeState,
  type RuntimeStateCategory,
} from "./state-paths.js";

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-state-paths-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveStateDir", () => {
  it("uses an explicit --state-dir argument over env and default", () => {
    const dir = resolveStateDir("/cwd", { KEIKO_STATE_DIR: "/env/state" }, "/explicit/state");
    expect(dir).toBe("/explicit/state");
  });

  it("resolves a relative --state-dir argument against cwd", () => {
    const dir = resolveStateDir("/cwd", {}, "custom-state");
    expect(dir).toBe(join("/cwd", "custom-state"));
  });

  it("falls back to KEIKO_STATE_DIR when no argument is given", () => {
    const dir = resolveStateDir("/cwd", { KEIKO_STATE_DIR: "/env/state" });
    expect(dir).toBe("/env/state");
  });

  it("ignores an empty-string argument and uses env", () => {
    const dir = resolveStateDir("/cwd", { KEIKO_STATE_DIR: "/env/state" }, "");
    expect(dir).toBe("/env/state");
  });

  it("defaults to <cwd>/.keiko when neither argument nor env is set", () => {
    const dir = resolveStateDir("/cwd", {});
    expect(dir).toBe(join("/cwd", DEFAULT_STATE_DIR_NAME));
    expect(isAbsolute(dir)).toBe(true);
  });

  it("resolves a relative KEIKO_STATE_DIR against cwd", () => {
    const dir = resolveStateDir("/cwd", { KEIKO_STATE_DIR: "rel" });
    expect(dir).toBe(join("/cwd", "rel"));
  });
});

describe("readPidFile", () => {
  it("returns undefined when the file is absent", () => {
    expect(readPidFile(join(makeRoot(), "ui.pid"))).toBeUndefined();
  });

  it("returns undefined for a non-numeric pid", () => {
    const root = makeRoot();
    const path = join(root, "ui.pid");
    writeFileSync(path, "not-a-pid\n", "utf8");
    expect(readPidFile(path)).toBeUndefined();
  });

  it("returns undefined for a zero or negative pid", () => {
    const root = makeRoot();
    const path = join(root, "ui.pid");
    writeFileSync(path, "0\n", "utf8");
    expect(readPidFile(path)).toBeUndefined();
  });

  it("parses a valid positive pid, trimming whitespace", () => {
    const root = makeRoot();
    const path = join(root, "ui.pid");
    writeFileSync(path, "  4242 \n", "utf8");
    expect(readPidFile(path)).toBe(4242);
  });
});

describe("defaultIsProcessAlive", () => {
  it("reports the current process as alive", () => {
    expect(defaultIsProcessAlive(process.pid)).toBe(true);
  });

  it("reports an unused high pid as not alive", () => {
    expect(defaultIsProcessAlive(2147483646)).toBe(false);
  });
});

describe("classifyPid", () => {
  it("classifies an absent pid file", () => {
    const result = classifyPid(join(makeRoot(), "ui.pid"), () => true);
    expect(result.state).toBe("absent");
    expect(result.pid).toBeUndefined();
  });

  it("classifies a recorded but dead pid as stale", () => {
    const root = makeRoot();
    const path = join(root, "ui.pid");
    writeFileSync(path, "1234\n", "utf8");
    const result = classifyPid(path, () => false);
    expect(result.state).toBe("stale");
    expect(result.pid).toBe(1234);
  });

  it("classifies a recorded and live pid as running", () => {
    const root = makeRoot();
    const path = join(root, "ui.pid");
    writeFileSync(path, "1234\n", "utf8");
    const result = classifyPid(path, () => true);
    expect(result.state).toBe("running");
    expect(result.pid).toBe(1234);
  });
});

describe("KEIKO_STATE_FILES", () => {
  it("enumerates the lifecycle and launcher state files", () => {
    expect(KEIKO_STATE_FILES).toContain("ui.pid");
    expect(KEIKO_STATE_FILES).toContain("ui.log");
    expect(KEIKO_STATE_FILES).toContain("launcher-state.json");
  });
});

function touch(path: string): void {
  writeFileSync(path, "x", "utf8");
}

// Seeds a representative `.keiko` tree containing one artifact of every manifest category
// plus a customer file the manifest must not claim.
function seedRuntimeState(root: string): string {
  const stateDir = join(root, ".keiko");
  mkdirSync(join(stateDir, "credentials"), { recursive: true });
  mkdirSync(join(stateDir, "memory"), { recursive: true });
  mkdirSync(join(stateDir, "local-knowledge", "default"), { recursive: true });
  mkdirSync(join(stateDir, "evidence", "figma"), { recursive: true });
  mkdirSync(join(stateDir, "evidence", "qi", "figma-snapshots", "run-1"), { recursive: true });
  touch(join(stateDir, "ui.pid"));
  touch(join(stateDir, "ui.log"));
  touch(join(stateDir, "launcher-state.json"));
  touch(join(stateDir, "keiko-ui.db"));
  touch(join(stateDir, "keiko-ui.db-wal"));
  touch(join(stateDir, "keiko-ui.db-shm"));
  touch(join(stateDir, "keiko-ui.db.corrupt.2026-06-20T12-00-00-000Z")); // quarantined db
  touch(join(stateDir, "keiko.config.json"));
  touch(join(stateDir, "credentials", "provider-credentials.vault"));
  touch(join(stateDir, "credentials", "provider-credentials-vault.key"));
  touch(join(stateDir, "credentials", ".secret-vault.1234.deadbeefdeadbeef.tmp"));
  touch(join(stateDir, "memory", "keiko-memory.db"));
  touch(join(stateDir, "memory", "keiko-memory.db-wal"));
  touch(join(stateDir, "memory", "keiko-memory.db-wal.corrupt.2026-06-20T12-00-00-000Z"));
  touch(join(stateDir, "local-knowledge", "default", "capsules.db"));
  touch(join(stateDir, "local-knowledge", "default", "capsules.db-shm"));
  touch(join(stateDir, "evidence", "run-1.json"));
  touch(join(stateDir, "evidence", "run-1.json.123e4567-e89b-12d3-a456-426614174000.tmp"));
  touch(join(stateDir, "evidence", "run-1.lock"));
  touch(join(stateDir, "evidence", "figma", "figma-token.vault"));
  touch(join(stateDir, "evidence", "figma", "figma-vault.key"));
  touch(join(stateDir, "evidence", "qi", "run-1.qi.json"));
  touch(join(stateDir, "evidence", "qi", "run-1.qi.json.123e4567-e89b-12d3-a456-426614174000.tmp"));
  touch(join(stateDir, "evidence", "qi", "run-1.candidates.json"));
  touch(join(stateDir, "evidence", "qi", "run-1.review.json"));
  touch(join(stateDir, "evidence", "qi", "run-1.figma-snapshot.management.json"));
  touch(
    join(
      stateDir,
      "evidence",
      "qi",
      "run-1.figma-snapshot.management.json.123e4567-e89b-12d3-a456-426614174000.tmp",
    ),
  );
  touch(join(stateDir, "evidence", "qi", "figma-snapshots", "run-1", "screen.png"));
  touch(join(stateDir, "user-notes.txt")); // a customer file — must be retained
  return stateDir;
}

function categoryOf(
  scan: ReturnType<typeof scanRuntimeState>,
  relPath: string,
): RuntimeStateCategory | undefined {
  return [...scan.files, ...scan.directories].find((n) => n.relPath === relPath)?.category;
}

describe("scanRuntimeState — runtime-state manifest", () => {
  it("reports an absent state directory as not present", () => {
    const scan = scanRuntimeState(join(makeRoot(), ".keiko"));
    expect(scan.present).toBe(false);
    expect(scan.root.status).toBe("absent");
    expect(scan.files).toHaveLength(0);
    expect(scan.directories).toHaveLength(0);
  });

  it("refuses a symlinked state root without following it", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    const target = join(root, "outside-state");
    const stateDir = join(root, ".keiko");
    mkdirSync(target, { recursive: true });
    touch(join(target, "keiko-ui.db"));
    symlinkSync(target, stateDir, "dir");
    const scan = scanRuntimeState(stateDir);
    expect(scan.root.status).toBe("symlink");
    expect(scan.files).toHaveLength(0);
    expect(scan.directories).toHaveLength(0);
    expect(scan.retained).toHaveLength(0);
  });

  it("refuses a non-directory state root without traversing it", () => {
    const root = makeRoot();
    const stateDir = join(root, ".keiko");
    touch(stateDir);
    const scan = scanRuntimeState(stateDir);
    expect(scan.root.status).toBe("not-directory");
    expect(scan.files).toHaveLength(0);
    expect(scan.directories).toHaveLength(0);
  });

  it("classifies every Keiko-owned artifact with the correct category", () => {
    const stateDir = seedRuntimeState(makeRoot());
    const scan = scanRuntimeState(stateDir);
    expect(scan.present).toBe(true);
    expect(categoryOf(scan, "ui.pid")).toBe("lifecycle");
    expect(categoryOf(scan, "launcher-state.json")).toBe("launcher");
    expect(categoryOf(scan, "keiko-ui.db")).toBe("ui-database");
    expect(categoryOf(scan, "keiko-ui.db-wal")).toBe("ui-database");
    expect(categoryOf(scan, "keiko.config.json")).toBe("gateway-config");
    expect(categoryOf(scan, "credentials/provider-credentials.vault")).toBe("credential-vault");
    expect(categoryOf(scan, "credentials/provider-credentials-vault.key")).toBe("credential-vault");
    expect(categoryOf(scan, "credentials/.secret-vault.1234.deadbeefdeadbeef.tmp")).toBe(
      "credential-vault",
    );
    expect(categoryOf(scan, "memory/keiko-memory.db")).toBe("memory-vault");
    expect(categoryOf(scan, "local-knowledge/default/capsules.db")).toBe("local-knowledge");
    expect(categoryOf(scan, "evidence/run-1.json")).toBe("evidence");
    expect(categoryOf(scan, "evidence/run-1.json.123e4567-e89b-12d3-a456-426614174000.tmp")).toBe(
      "evidence",
    );
    expect(categoryOf(scan, "evidence/run-1.lock")).toBe("evidence");
    expect(categoryOf(scan, "evidence/figma/figma-token.vault")).toBe("credential-vault");
    expect(categoryOf(scan, "evidence/figma/figma-vault.key")).toBe("credential-vault");
    expect(categoryOf(scan, "evidence/qi/run-1.qi.json")).toBe("quality-intelligence");
    expect(
      categoryOf(scan, "evidence/qi/run-1.qi.json.123e4567-e89b-12d3-a456-426614174000.tmp"),
    ).toBe("quality-intelligence");
    expect(categoryOf(scan, "evidence/qi/run-1.candidates.json")).toBe("quality-intelligence");
    expect(categoryOf(scan, "evidence/qi/run-1.review.json")).toBe("quality-intelligence");
    expect(categoryOf(scan, "evidence/qi/run-1.figma-snapshot.management.json")).toBe(
      "quality-intelligence",
    );
    expect(
      categoryOf(
        scan,
        "evidence/qi/run-1.figma-snapshot.management.json.123e4567-e89b-12d3-a456-426614174000.tmp",
      ),
    ).toBe("quality-intelligence");
    expect(categoryOf(scan, "evidence/qi/figma-snapshots/run-1/screen.png")).toBe(
      "quality-intelligence",
    );
  });

  it("classifies quarantined .corrupt.<ts> database and sidecar copies as owned", () => {
    const stateDir = seedRuntimeState(makeRoot());
    const scan = scanRuntimeState(stateDir);
    expect(categoryOf(scan, "keiko-ui.db.corrupt.2026-06-20T12-00-00-000Z")).toBe("ui-database");
    expect(categoryOf(scan, "memory/keiko-memory.db-wal.corrupt.2026-06-20T12-00-00-000Z")).toBe(
      "memory-vault",
    );
  });

  it("retains a customer file whose name only resembles a database (no prefix over-match)", () => {
    const stateDir = join(makeRoot(), ".keiko");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "keiko-ui.db"), "x", "utf8");
    // Names that share a prefix with the DB but are NOT Keiko sidecars/quarantine files.
    for (const name of ["keiko-ui.db.backup", "keiko-ui.db-old", "keiko-ui.dbackup"]) {
      writeFileSync(join(stateDir, name), "customer", "utf8");
    }
    const scan = scanRuntimeState(stateDir);
    expect(scan.files.some((f) => f.relPath === "keiko-ui.db")).toBe(true);
    const retainedNames = scan.retained.map((r) => r.relPath);
    expect(retainedNames).toContain("keiko-ui.db.backup");
    expect(retainedNames).toContain("keiko-ui.db-old");
    expect(retainedNames).toContain("keiko-ui.dbackup");
  });

  it("retains a customer file and never claims it as Keiko-owned", () => {
    const stateDir = seedRuntimeState(makeRoot());
    const scan = scanRuntimeState(stateDir);
    const retained = scan.retained.find((r) => r.relPath === "user-notes.txt");
    expect(retained).toBeDefined();
    expect(retained?.reason).toBe("unknown");
    expect(retained?.owned).toBe(false);
    expect(scan.files.some((f) => f.relPath === "user-notes.txt")).toBe(false);
  });

  it("orders owned directories shallowest-first (parent before child)", () => {
    const stateDir = seedRuntimeState(makeRoot());
    const scan = scanRuntimeState(stateDir);
    const rels = scan.directories.map((d) => d.relPath);
    expect(rels.indexOf("evidence")).toBeLessThan(rels.indexOf("evidence/qi"));
    expect(rels.indexOf("evidence/qi")).toBeLessThan(rels.indexOf("evidence/qi/figma-snapshots"));
  });

  it("flags a symlink in an owned position without following it", () => {
    if (process.platform === "win32") return;
    const stateDir = join(makeRoot(), ".keiko");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "secret-target"), "x", "utf8");
    symlinkSync(join(stateDir, "secret-target"), join(stateDir, "keiko-ui.db"));
    const scan = scanRuntimeState(stateDir);
    const link = scan.retained.find((r) => r.relPath === "keiko-ui.db");
    expect(link?.reason).toBe("symlink");
    expect(link?.owned).toBe(true);
    expect(scan.files.some((f) => f.relPath === "keiko-ui.db")).toBe(false);
  });

  it("treats a customer symlink in an unowned position as not owned", () => {
    if (process.platform === "win32") return;
    const stateDir = join(makeRoot(), ".keiko");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "target"), "x", "utf8");
    symlinkSync(join(stateDir, "target"), join(stateDir, "my-link"));
    const scan = scanRuntimeState(stateDir);
    const link = scan.retained.find((r) => r.relPath === "my-link");
    expect(link?.reason).toBe("symlink");
    expect(link?.owned).toBe(false);
  });

  it("does not recurse into an unknown top-level directory", () => {
    const stateDir = join(makeRoot(), ".keiko");
    mkdirSync(join(stateDir, "user-dir", "nested"), { recursive: true });
    writeFileSync(join(stateDir, "user-dir", "nested", "secret.txt"), "x", "utf8");
    const scan = scanRuntimeState(stateDir);
    expect(scan.retained.map((r) => r.relPath)).toContain("user-dir");
    expect(scan.retained.some((r) => r.relPath.startsWith("user-dir/"))).toBe(false);
  });

  it("retains customer lookalikes in known evidence, QI, and vault directories", () => {
    const stateDir = seedRuntimeState(makeRoot());
    touch(join(stateDir, "evidence", "manual export.json"));
    touch(
      join(stateDir, "evidence", "manual export.json.123e4567-e89b-12d3-a456-426614174000.tmp"),
    );
    touch(join(stateDir, "evidence", "manual export.lock"));
    touch(join(stateDir, "evidence", "qi", "debug dump.json"));
    touch(
      join(
        stateDir,
        "evidence",
        "qi",
        "debug dump.qi.json.123e4567-e89b-12d3-a456-426614174000.tmp",
      ),
    );
    touch(join(stateDir, "evidence", "qi", "run-1.notes.json"));
    touch(join(stateDir, "credentials", "backup.key"));
    touch(join(stateDir, "credentials", "backup.vault"));
    touch(join(stateDir, "credentials", ".secret-vault.abc.deadbeefdeadbeef.tmp"));
    touch(join(stateDir, "evidence", "figma", "backup.key"));
    touch(join(stateDir, "evidence", "figma", "backup.vault"));

    const scan = scanRuntimeState(stateDir);
    const retained = scan.retained.map((r) => r.relPath);
    expect(retained).toContain("evidence/manual export.json");
    expect(retained).toContain(
      "evidence/manual export.json.123e4567-e89b-12d3-a456-426614174000.tmp",
    );
    expect(retained).toContain("evidence/manual export.lock");
    expect(retained).toContain("evidence/qi/debug dump.json");
    expect(retained).toContain(
      "evidence/qi/debug dump.qi.json.123e4567-e89b-12d3-a456-426614174000.tmp",
    );
    expect(retained).toContain("evidence/qi/run-1.notes.json");
    expect(retained).toContain("credentials/backup.key");
    expect(retained).toContain("credentials/backup.vault");
    expect(retained).toContain("credentials/.secret-vault.abc.deadbeefdeadbeef.tmp");
    expect(retained).toContain("evidence/figma/backup.key");
    expect(retained).toContain("evidence/figma/backup.vault");
  });

  it("retains an owned-looking hardlink without classifying it as an owned file", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true });
    const outside = join(root, "outside-db");
    writeFileSync(outside, "x", "utf8");
    linkSync(outside, join(stateDir, "keiko-ui.db"));

    const scan = scanRuntimeState(stateDir);
    const hardlink = scan.retained.find((r) => r.relPath === "keiko-ui.db");
    expect(hardlink?.reason).toBe("hardlink");
    expect(hardlink?.owned).toBe(true);
    expect(scan.files.some((f) => f.relPath === "keiko-ui.db")).toBe(false);
  });

  it("retains Local Knowledge namespace directories until they contain a known DB artifact", () => {
    const stateDir = join(makeRoot(), ".keiko");
    mkdirSync(join(stateDir, "local-knowledge", "notes"), { recursive: true });
    mkdirSync(join(stateDir, "local-knowledge", "empty"), { recursive: true });
    touch(join(stateDir, "local-knowledge", "notes", "customer.txt"));
    mkdirSync(join(stateDir, "local-knowledge", "default"), { recursive: true });
    touch(join(stateDir, "local-knowledge", "default", "capsules.db-wal"));

    const scan = scanRuntimeState(stateDir);
    const retained = scan.retained.map((r) => r.relPath);
    expect(retained).toContain("local-knowledge/notes");
    expect(retained).toContain("local-knowledge/empty");
    expect(categoryOf(scan, "local-knowledge/default")).toBe("local-knowledge");
    expect(categoryOf(scan, "local-knowledge/default/capsules.db-wal")).toBe("local-knowledge");
  });

  it("retains invalid Figma snapshot side-file run directories", () => {
    const stateDir = seedRuntimeState(makeRoot());
    mkdirSync(join(stateDir, "evidence", "qi", "figma-snapshots", "invalid run"), {
      recursive: true,
    });
    touch(join(stateDir, "evidence", "qi", "figma-snapshots", "invalid run", "screen.png"));

    const scan = scanRuntimeState(stateDir);
    expect(scan.retained.map((r) => r.relPath)).toContain(
      "evidence/qi/figma-snapshots/invalid run",
    );
    expect(
      scan.files.some((f) => f.relPath === "evidence/qi/figma-snapshots/invalid run/screen.png"),
    ).toBe(false);
  });
});

describe("isInsidePath", () => {
  it("treats a path as inside itself", () => {
    expect(isInsidePath("/a/b", "/a/b")).toBe(true);
  });

  it("recognizes a descendant", () => {
    expect(isInsidePath("/a/b", join("/a/b", "c", "d"))).toBe(true);
  });

  it("rejects a sibling with a shared prefix", () => {
    expect(isInsidePath("/a/b", "/a/bc")).toBe(false);
  });
});
