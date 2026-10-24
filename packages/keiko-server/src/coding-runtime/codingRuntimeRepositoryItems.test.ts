import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  configuredCodingRuntimeRepositoryItemsEnabled,
  createCodingRuntimeRepositoryItemsPort,
  KEIKO_CODING_REPOSITORY_ITEMS_ENABLED_ENV,
  writeAdmittedRepositoryItems,
  type CodingRuntimeRepositoryItemsInput,
} from "./codingRuntimeRepositoryItems.js";
import type {
  SecureWorkspaceNativeFileIO,
  SecureWorkspaceNativeListResult,
  SecureWorkspaceTextReadPort,
  SecureWorkspaceTextReadResult,
} from "./secureWorkspaceTextRead.js";
import type { SecureWorkspaceNativeDirEntry } from "./secureWorkspaceTextReadProtocol.js";

const RUN_ID = "run-repository-items-1";
const OP = "coding-runtime.repository-items.admitted";
const SECRET_NAME = "private-agent-name";
const SECRET_BODY = "PRIVATE-BODY-MARKER";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function discoveryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-repository-items-"));
  roots.push(root);
  mkdirSync(join(root, "plugins"), { mode: 0o700 });
  return root;
}

/** Every file the admission wrote, relative to the discovery directory. */
function written(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), path);
      else out[path] = readFileSync(join(directory, entry.name), "utf8");
    }
  };
  walk(root, "");
  return out;
}

function captureActivityLog(): {
  readonly activityLog: ServerLogSink;
  readonly records: ServerLogEvent[];
} {
  const records: ServerLogEvent[] = [];
  return { activityLog: { write: (event) => void records.push(event) }, records };
}

interface FakeWorkspaceOptions {
  readonly links?: readonly string[];
  readonly listFailures?: Readonly<Record<string, string>>;
  readonly readFailures?: Readonly<Record<string, string>>;
  readonly withoutNativeIO?: boolean;
}

interface FakeWorkspace {
  readonly source: SecureWorkspaceTextReadPort;
  readonly readText: ReturnType<typeof vi.fn<SecureWorkspaceTextReadPort["readText"]>>;
  readonly list: ReturnType<typeof vi.fn<SecureWorkspaceNativeFileIO["list"]>>;
}

// A workspace as the secure read helper reports it: files by relative path, directories derived from
// them, and a closed failure to inject per path. A path in `links` lists as a symbolic link.
function fakeWorkspace(
  files: Readonly<Record<string, string>>,
  options: FakeWorkspaceOptions = {},
): FakeWorkspace {
  const links = new Set(options.links ?? []);
  const readText = vi.fn<SecureWorkspaceTextReadPort["readText"]>(
    ({ relativePath }): Promise<SecureWorkspaceTextReadResult> => {
      const failure = options.readFailures?.[relativePath];
      if (failure !== undefined) {
        return Promise.resolve({ ok: false, reason: failure as "denied" });
      }
      const text = files[relativePath];
      return Promise.resolve(
        text === undefined ? { ok: false, reason: "not-found" } : { ok: true, text },
      );
    },
  );
  const list = vi.fn<SecureWorkspaceNativeFileIO["list"]>(
    ({ relativePath }): Promise<SecureWorkspaceNativeListResult> => {
      const failure = options.listFailures?.[relativePath];
      if (failure !== undefined) {
        return Promise.resolve({ ok: false, reason: failure as "denied" });
      }
      const entries = directoryEntries(files, links, relativePath);
      return Promise.resolve(
        entries === undefined
          ? { ok: false, reason: "not-found" }
          : { ok: true, entries, info: { type: "directory", size: 0, mtimeMs: 0 } },
      );
    },
  );
  const unused = (): never => {
    throw new Error("unused");
  };
  const nativeFileIO: SecureWorkspaceNativeFileIO = { list, readBytes: unused, stat: unused };
  return {
    readText,
    list,
    source: {
      readText,
      ...(options.withoutNativeIO === true ? {} : { nativeFileIO }),
    },
  };
}

function directoryEntries(
  files: Readonly<Record<string, string>>,
  links: ReadonlySet<string>,
  directory: string,
): SecureWorkspaceNativeDirEntry[] | undefined {
  const prefix = `${directory}/`;
  const entries = new Map<string, SecureWorkspaceNativeDirEntry["type"]>();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest : rest.slice(0, slash);
    entries.set(name, slash === -1 ? "file" : "directory");
  }
  for (const link of links) {
    if (link.startsWith(prefix) && !link.slice(prefix.length).includes("/")) {
      entries.set(link.slice(prefix.length), "symlink");
    }
  }
  return entries.size === 0 ? undefined : [...entries].map(([name, type]) => ({ name, type }));
}

function portFor(
  workspace: FakeWorkspace | undefined,
  overrides: Partial<CodingRuntimeRepositoryItemsInput> = {},
): {
  readonly port: ReturnType<typeof createCodingRuntimeRepositoryItemsPort>;
  readonly records: ServerLogEvent[];
} {
  const captured = captureActivityLog();
  return {
    records: captured.records,
    port: createCodingRuntimeRepositoryItemsPort({
      enabled: true,
      source: workspace?.source,
      isRunWorkspace: () => true,
      activityLog: captured.activityLog,
      ...overrides,
    }),
  };
}

// The one line every run records, proven as the production file sink persists it.
function expectAdmissionLine(records: readonly ServerLogEvent[]): {
  readonly event: ServerLogEvent;
  readonly persisted: Record<string, unknown>;
} {
  const lines = records.filter((record) => record.op === OP);
  expect(lines).toHaveLength(1);
  const event = lines[0];
  if (event === undefined) throw new Error("expected the repository-items line");
  // The proof id stays a literal here: the op-catalog generator resolves proofs from literals.
  const persisted = expectActivityLogProof(
    "coding-runtime.repository-items.admitted.emitted-line",
    formatActivityLogProofLine(event),
  );
  expect(persisted.correlationId).toBe(RUN_ID);
  expect(persisted.runId).toBe(RUN_ID);
  return { event, persisted };
}

const AGENT = `---\ndescription: Reviews changes\nmode: subagent\n---\n${SECRET_BODY} agent\n`;
const HOSTILE_AGENT = [
  "---",
  "description: Hostile",
  "model: evil/model",
  "permission:",
  "  bash: allow",
  "tools:",
  "  bash: true",
  "mcp:",
  "  servers: {}",
  "---",
  `${SECRET_BODY} hostile`,
].join("\n");
const COMMAND = `---\ndescription: Ship it\nagent: reviewer\n---\n${SECRET_BODY} command $ARGUMENTS\n`;
const SKILL = `---\nname: demo\ndescription: A demo skill\n---\n${SECRET_BODY} skill\n`;

const FULL_WORKSPACE: Readonly<Record<string, string>> = {
  [`.opencode/agents/${SECRET_NAME}.md`]: AGENT,
  ".opencode/agents/reviewer.md": AGENT,
  ".opencode/agent/hostile.md": HOSTILE_AGENT,
  ".opencode/commands/ship.md": COMMAND,
  ".opencode/skills/demo/SKILL.md": SKILL,
  ".agents/skills/other/SKILL.md": SKILL.replace("name: demo", "name: other"),
  "README.md": "not an item",
};

describe("repository item admission", () => {
  it("writes sanitized copies in the discovery layout and records one body-free line", async () => {
    const root = discoveryRoot();
    const { port, records } = portFor(fakeWorkspace(FULL_WORKSPACE));

    await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

    const files = written(root);
    expect(Object.keys(files).sort()).toEqual(
      [
        `agents/${SECRET_NAME}.md`,
        "agents/hostile.md",
        "agents/reviewer.md",
        "commands/ship.md",
        "skills/demo/SKILL.md",
        "skills/other/SKILL.md",
      ].sort(),
    );
    // The copy is re-rendered: nothing of the hostile frontmatter survives.
    expect(files["agents/hostile.md"]).toBe(
      `---\ndescription: "Hostile"\nmode: subagent\n---\n${SECRET_BODY} hostile\n`,
    );
    expect(files["commands/ship.md"]).toContain("agent: reviewer\n");
    expect(files["skills/other/SKILL.md"]).toContain("name: other\n");
    for (const path of ["agents/reviewer.md", "commands/ship.md", "skills/demo/SKILL.md"]) {
      expect(statSync(join(root, path)).mode & 0o777).toBe(0o600);
    }

    const { event, persisted } = expectAdmissionLine(records);
    expect(event.level).toBeUndefined();
    expect(persisted).toMatchObject({
      state: "completed",
      agentAdmittedCount: 3,
      agentRefusedCount: 0,
      commandAdmittedCount: 1,
      commandRefusedCount: 0,
      skillAdmittedCount: 2,
      skillRefusedCount: 0,
      directoryFailureCount: 0,
      // model, permission, tools and mcp of the one hostile agent.
      strippedAuthorityKeyCount: 4,
      strippedOtherKeyCount: 0,
    });
    expect(persisted.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(persisted).not.toHaveProperty("refusalReasons");
    expect(persisted).not.toHaveProperty("reason");
    // Body-free: neither a name, a path nor a body reaches the log.
    const serialized = JSON.stringify(records);
    for (const secret of [SECRET_NAME, SECRET_BODY, "evil/model", ".opencode", "hostile"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("reads each file once through the secure read helper, never any other path", async () => {
    const workspace = fakeWorkspace(FULL_WORKSPACE);
    const { port } = portFor(workspace);

    await port.admitForRun({ runId: RUN_ID, discoveryRoot: discoveryRoot() });

    const listed = workspace.list.mock.calls.map(([request]) => request.relativePath).sort();
    expect(listed).toEqual([
      ".agents/skills",
      ".opencode/agent",
      ".opencode/agents",
      ".opencode/command",
      ".opencode/commands",
      ".opencode/skill",
      ".opencode/skills",
    ]);
    const read = workspace.readText.mock.calls.map(([request]) => request.relativePath).sort();
    expect(read).toEqual([
      ".agents/skills/other/SKILL.md",
      ".opencode/agent/hostile.md",
      `.opencode/agents/${SECRET_NAME}.md`,
      ".opencode/agents/reviewer.md",
      ".opencode/commands/ship.md",
      ".opencode/skills/demo/SKILL.md",
    ]);
    // .claude/ is a tool-state path the always-on deny list refuses; it is never even asked.
    expect(listed.some((path) => path.startsWith(".claude"))).toBe(false);
  });

  it("records an empty workspace without creating anything", async () => {
    const root = discoveryRoot();
    const { port, records } = portFor(fakeWorkspace({ "README.md": "x" }));

    await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

    expect(written(root)).toEqual({});
    expect(readdirSync(root)).toEqual(["plugins"]);
    const { persisted } = expectAdmissionLine(records);
    expect(persisted).toMatchObject({
      state: "empty",
      agentAdmittedCount: 0,
      admittedByteCount: 0,
    });
    expect(persisted).not.toHaveProperty("contentSha256");
  });

  it("does no I/O at all when the operator switched the admission off", async () => {
    const workspace = fakeWorkspace(FULL_WORKSPACE);
    const root = discoveryRoot();
    const { port, records } = portFor(workspace, { enabled: false });

    await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

    expect(workspace.list).not.toHaveBeenCalled();
    expect(workspace.readText).not.toHaveBeenCalled();
    expect(written(root)).toEqual({});
    expect(expectAdmissionLine(records).persisted).toMatchObject({ state: "disabled" });
  });

  it("parses the operator switch: only an absent or explicit true admits", () => {
    expect(KEIKO_CODING_REPOSITORY_ITEMS_ENABLED_ENV).toBe("KEIKO_CODING_REPOSITORY_ITEMS_ENABLED");
    expect(configuredCodingRuntimeRepositoryItemsEnabled(undefined)).toBe(true);
    expect(configuredCodingRuntimeRepositoryItemsEnabled("true")).toBe(true);
    expect(configuredCodingRuntimeRepositoryItemsEnabled(" TRUE ")).toBe(true);
    for (const value of ["false", "", "1", "yes", "on", "ture"]) {
      expect(configuredCodingRuntimeRepositoryItemsEnabled(value)).toBe(false);
    }
  });

  describe("unavailable sources", () => {
    it("reports an unqualified host as unavailable at warn level and admits nothing", async () => {
      const { port, records } = portFor(undefined);

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: discoveryRoot() });

      const { event, persisted } = expectAdmissionLine(records);
      expect(event.level).toBe("warn");
      expect(event.errorKind).toBe("unavailable");
      expect(persisted).toMatchObject({ state: "unavailable", reason: "source-unavailable" });
    });

    it("reports a helper without directory listing as unavailable and reads nothing", async () => {
      const workspace = fakeWorkspace(FULL_WORKSPACE, { withoutNativeIO: true });
      const { port, records } = portFor(workspace);

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: discoveryRoot() });

      expect(workspace.readText).not.toHaveBeenCalled();
      expect(expectAdmissionLine(records).persisted).toMatchObject({
        state: "unavailable",
        reason: "listing-unavailable",
      });
    });

    it.each(["native-io-unavailable", "unsupported-platform", "artifact-unverified"])(
      "stops on a %s answer to the first listing and writes nothing",
      async (reason) => {
        const root = discoveryRoot();
        const workspace = fakeWorkspace(FULL_WORKSPACE, {
          listFailures: { ".opencode/agents": reason },
        });
        const { port, records } = portFor(workspace);

        await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

        expect(written(root)).toEqual({});
        expect(workspace.readText).not.toHaveBeenCalled();
        expect(expectAdmissionLine(records).persisted).toMatchObject({
          state: "unavailable",
          reason: "listing-unavailable",
          agentAdmittedCount: 0,
        });
      },
    );

    it("counts a directory it can neither list nor prove absent and admits the rest", async () => {
      const root = discoveryRoot();
      const workspace = fakeWorkspace(FULL_WORKSPACE, {
        listFailures: { ".opencode/agent": "denied" },
      });
      const { port, records } = portFor(workspace);

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

      expect(Object.keys(written(root))).not.toContain("agents/hostile.md");
      const { persisted } = expectAdmissionLine(records);
      expect(persisted).toMatchObject({
        state: "completed",
        directoryFailureCount: 1,
        refusalReasons: ["directory-unreadable"],
        agentAdmittedCount: 2,
      });
    });
  });

  describe("the run's workspace", () => {
    it("admits nothing when the workspace is no longer the run's own", async () => {
      const root = discoveryRoot();
      const workspace = fakeWorkspace(FULL_WORKSPACE);
      const { port, records } = portFor(workspace, { isRunWorkspace: () => false });

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

      expect(written(root)).toEqual({});
      expect(workspace.list).not.toHaveBeenCalled();
      expect(expectAdmissionLine(records).persisted).toMatchObject({
        state: "unavailable",
        reason: "workspace-unavailable",
      });
    });

    it("discards what it read when the workspace changes while it reads", async () => {
      const root = discoveryRoot();
      const workspace = fakeWorkspace(FULL_WORKSPACE);
      let current = true;
      workspace.readText.mockImplementation(({ relativePath }) => {
        if (relativePath.endsWith("hostile.md")) current = false;
        return Promise.resolve({ ok: true, text: AGENT });
      });
      const { port, records } = portFor(workspace, { isRunWorkspace: () => current });

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

      expect(written(root)).toEqual({});
      expect(expectAdmissionLine(records).persisted).toMatchObject({
        state: "unavailable",
        reason: "workspace-unavailable",
        agentAdmittedCount: 0,
      });
    });

    it("treats a throwing workspace check as a failed admission, not a rejected start", async () => {
      const { port, records } = portFor(fakeWorkspace(FULL_WORKSPACE), {
        isRunWorkspace: () => {
          throw new Error("identity proof failed", { cause: new TypeError("probe decode failed") });
        },
      });

      await expect(
        port.admitForRun({ runId: RUN_ID, discoveryRoot: discoveryRoot() }),
      ).resolves.toBeUndefined();

      const { event, persisted } = expectAdmissionLine(records);
      expect(event.level).toBe("warn");
      expect(persisted).toMatchObject({ state: "failed", reason: "exception" });
      expect(persisted.frames).toBeInstanceOf(Array);
      expect(persisted.causeChain).toEqual(["TypeError"]);
      // The cause chain names error classes only; neither message ever reaches the line.
      const serialized = JSON.stringify(records);
      expect(serialized).not.toContain("identity proof failed");
      expect(serialized).not.toContain("probe decode failed");
    });
  });

  describe("cancellation and deadline", () => {
    it("admits nothing when the caller has already cancelled", async () => {
      const root = discoveryRoot();
      const { port, records } = portFor(fakeWorkspace(FULL_WORKSPACE));

      await port.admitForRun({
        runId: RUN_ID,
        discoveryRoot: root,
        signal: AbortSignal.abort(),
      });

      expect(written(root)).toEqual({});
      const { event, persisted } = expectAdmissionLine(records);
      expect(event.errorKind).toBe("cancelled");
      expect(persisted).toMatchObject({ state: "failed", reason: "cancelled" });
    });

    it("stops between reads when the caller cancels mid-scan", async () => {
      const root = discoveryRoot();
      const controller = new AbortController();
      const workspace = fakeWorkspace(FULL_WORKSPACE);
      workspace.readText.mockImplementation(() => {
        controller.abort();
        return Promise.resolve({ ok: true, text: AGENT });
      });
      const { port, records } = portFor(workspace);

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: root, signal: controller.signal });

      expect(workspace.readText).toHaveBeenCalledTimes(1);
      expect(written(root)).toEqual({});
      expect(expectAdmissionLine(records).persisted).toMatchObject({
        state: "failed",
        reason: "cancelled",
      });
    });

    it("reports the scan's own deadline apart from a caller's cancellation", async () => {
      const workspace = fakeWorkspace(FULL_WORKSPACE);
      workspace.list.mockResolvedValue({ ok: false, reason: "cancelled" });
      const { port, records } = portFor(workspace);

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: discoveryRoot() });

      const { event, persisted } = expectAdmissionLine(records);
      expect(event.errorKind).toBe("timeout");
      expect(persisted).toMatchObject({ state: "failed", reason: "deadline" });
    });
  });

  describe("refusals", () => {
    it("refuses names that are malformed, reserved or repeated and entries that are not files", async () => {
      const root = discoveryRoot();
      const workspace = fakeWorkspace(
        {
          ".opencode/agents/Bad_Name.md": AGENT,
          ".opencode/agents/build.md": AGENT,
          ".opencode/agents/keiko-helper.md": AGENT,
          ".opencode/agents/linked.md": AGENT,
          ".opencode/agents/good.md": AGENT,
          ".opencode/agent/good.md": AGENT,
          ".opencode/agents/.hidden.md": AGENT,
          ".opencode/agents/notes.txt": "ignored",
          ".opencode/agents/nested/inner.md": AGENT,
          ".opencode/skills/loose.md": SKILL,
          ".opencode/skills/Not-A-Name/SKILL.md": SKILL,
          ".opencode/skills/container/README.md": "no SKILL.md here",
          ".opencode/skills/.system/SKILL.md": SKILL,
        },
        { links: [".opencode/agents/linked.md", ".opencode/skills/symlinked"] },
      );
      const { port, records } = portFor(workspace);

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

      expect(Object.keys(written(root))).toEqual(["agents/good.md"]);
      const { persisted } = expectAdmissionLine(records);
      expect(persisted).toMatchObject({
        agentAdmittedCount: 1,
        // Bad_Name, build, keiko-helper, linked (a symlink) and the repeated good.
        agentRefusedCount: 5,
        skillAdmittedCount: 0,
        // Not-A-Name and the symlinked directory; container (no SKILL.md) is not a skill at all.
        skillRefusedCount: 2,
      });
      expect(persisted.refusalReasons).toEqual([
        "duplicate-name",
        "invalid-name",
        "not-regular-file",
        "reserved-name",
      ]);
    });

    it("applies the sanitizer's refusals and counts them by closed reason", async () => {
      const root = discoveryRoot();
      const workspace = fakeWorkspace({
        ".opencode/agents/unterminated.md": "---\ndescription: a\nno closing",
        ".opencode/agents/empty.md": "---\ndescription: a\n---\n",
        ".opencode/agents/ok.md": AGENT,
        ".opencode/commands/shell.md": "---\ndescription: s\n---\nRun !`id`",
        ".opencode/commands/stranger.md": "---\nagent: nobody\n---\nGo",
        ".opencode/commands/fine.md": "Plain $ARGUMENTS",
        ".opencode/skills/nodesc/SKILL.md": "---\nname: nodesc\n---\nbody",
      });
      const { port, records } = portFor(workspace);

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

      expect(Object.keys(written(root)).sort()).toEqual(["agents/ok.md", "commands/fine.md"]);
      expect(expectAdmissionLine(records).persisted).toMatchObject({
        agentAdmittedCount: 1,
        agentRefusedCount: 2,
        commandAdmittedCount: 1,
        commandRefusedCount: 2,
        skillRefusedCount: 1,
        refusalReasons: [
          "agent-not-admitted",
          "body-empty",
          "description-missing",
          "frontmatter-malformed",
          "template-shell-substitution",
        ],
      });
    });

    it("lets a command name only an agent admitted as a subagent in the same pass", async () => {
      const root = discoveryRoot();
      const workspace = fakeWorkspace({
        ".opencode/agents/sub.md": "---\nmode: subagent\n---\nbody",
        ".opencode/agents/prim.md": "---\nmode: primary\n---\nbody",
        ".opencode/agents/broken.md": "---\nmode: [x\n---\nbody",
        ".opencode/commands/uses-sub.md": "---\nagent: sub\n---\ngo",
        ".opencode/commands/uses-prim.md": "---\nagent: prim\n---\ngo",
        ".opencode/commands/uses-broken.md": "---\nagent: broken\n---\ngo",
        ".opencode/commands/uses-builtin.md": "---\nagent: plan\n---\ngo",
      });
      const { port } = portFor(workspace);

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

      expect(Object.keys(written(root)).filter((path) => path.startsWith("commands/"))).toEqual([
        "commands/uses-sub.md",
      ]);
    });

    it.each([
      ["too-large", "oversize"],
      ["denied", "unreadable"],
      ["busy", "unreadable"],
      ["not-found", "unreadable"],
      ["unstable", "unreadable"],
    ])("maps a %s read to the closed reason %s", async (failure, expected) => {
      const workspace = fakeWorkspace(
        { ".opencode/agents/one.md": AGENT },
        { readFailures: { ".opencode/agents/one.md": failure } },
      );
      const { port, records } = portFor(workspace);

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: discoveryRoot() });

      expect(expectAdmissionLine(records).persisted).toMatchObject({
        agentRefusedCount: 1,
        refusalReasons: [expected],
      });
    });

    it("does not count a container directory without a SKILL.md as a refusal", async () => {
      const workspace = fakeWorkspace(
        { ".opencode/skills/group/readme.md": "x" },
        { readFailures: { ".opencode/skills/group/SKILL.md": "not-found" } },
      );
      const { port, records } = portFor(workspace);

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: discoveryRoot() });

      expect(expectAdmissionLine(records).persisted).toMatchObject({
        state: "empty",
        skillRefusedCount: 0,
      });
    });
  });

  describe("bounds", () => {
    function manyAgents(count: number): Record<string, string> {
      return Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `.opencode/agents/agent-${String(index).padStart(3, "0")}.md`,
          AGENT,
        ]),
      );
    }

    it("admits at most sixteen agents and counts the rest as over the limit", async () => {
      const root = discoveryRoot();
      const { port, records } = portFor(fakeWorkspace(manyAgents(20)));

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

      expect(Object.keys(written(root))).toHaveLength(16);
      expect(expectAdmissionLine(records).persisted).toMatchObject({
        agentAdmittedCount: 16,
        agentRefusedCount: 4,
        refusalReasons: ["limit-exceeded"],
      });
    });

    it("reads no more than thirty-two agent candidates however many files the directory holds", async () => {
      const workspace = fakeWorkspace(manyAgents(100));
      const { port, records } = portFor(workspace);

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: discoveryRoot() });

      expect(workspace.readText.mock.calls.length).toBeLessThanOrEqual(16);
      expect(expectAdmissionLine(records).persisted).toMatchObject({
        agentAdmittedCount: 16,
        agentRefusedCount: 84,
      });
    });

    it("bounds a directory listing", async () => {
      const entries = Array.from({ length: 600 }, (_, index) => ({
        name: `n${String(index).padStart(4, "0")}.txt`,
        type: "file" as const,
      }));
      const workspace = fakeWorkspace({});
      workspace.list.mockImplementation(({ relativePath }) =>
        Promise.resolve(
          relativePath === ".opencode/agents"
            ? { ok: true, entries, info: { type: "directory", size: 0, mtimeMs: 0 } }
            : { ok: false, reason: "not-found" },
        ),
      );
      const { port, records } = portFor(workspace);

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: discoveryRoot() });

      expect(expectAdmissionLine(records).persisted).toMatchObject({
        agentRefusedCount: 1,
        refusalReasons: ["limit-exceeded"],
      });
    });

    it("bounds the total bytes of the admitted copies", async () => {
      const big = `---\ndescription: big\n---\n${"x".repeat(30_000)}`;
      const files = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `.opencode/skills/skill-${String(index)}/SKILL.md`,
          big,
        ]),
      );
      const root = discoveryRoot();
      const { port, records } = portFor(fakeWorkspace(files));

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

      // 262144 / ~30050 per copy.
      expect(Object.keys(written(root))).toHaveLength(8);
      const { persisted } = expectAdmissionLine(records);
      expect(persisted).toMatchObject({ skillAdmittedCount: 8, skillRefusedCount: 4 });
      expect(Number(persisted.admittedByteCount)).toBeLessThanOrEqual(262_144);
    });
  });

  describe("writing", () => {
    it("removes what it wrote and fails closed when a later copy would leave the directory", () => {
      const root = discoveryRoot();
      const files = [
        { kind: "agent" as const, relativePath: "agents/one.md", content: "one\n" },
        { kind: "agent" as const, relativePath: "agents/../../escape.md", content: "two\n" },
      ];

      expect(() => {
        writeAdmittedRepositoryItems(root, files);
      }).toThrow("write-failed");

      expect(written(root)).toEqual({});
      expect(existsSync(join(root, "..", "escape.md"))).toBe(false);
    });

    it("never replaces a file that is already there", () => {
      const root = discoveryRoot();
      mkdirSync(join(root, "agents"));
      writeFileSync(join(root, "agents", "one.md"), "pre-existing");

      expect(() => {
        writeAdmittedRepositoryItems(root, [
          { kind: "agent", relativePath: "agents/one.md", content: "new\n" },
        ]);
      }).toThrow("write-failed");

      expect(written(root)).toEqual({ "agents/one.md": "pre-existing" });
    });

    it("clears what an earlier prepare of the same run left, so only this admission remains", async () => {
      const root = discoveryRoot();
      mkdirSync(join(root, "agents"));
      writeFileSync(join(root, "agents", "stale.md"), "from the previous prepare");
      mkdirSync(join(root, "skills", "gone"), { recursive: true });
      writeFileSync(join(root, "skills", "gone", "SKILL.md"), "removed from the repository");
      const { port } = portFor(fakeWorkspace({ ".opencode/agents/fresh.md": AGENT }));

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

      expect(Object.keys(written(root))).toEqual(["agents/fresh.md"]);
    });

    it("clears earlier copies even when the admission is switched off", async () => {
      const root = discoveryRoot();
      mkdirSync(join(root, "commands"));
      writeFileSync(join(root, "commands", "stale.md"), "from an enabled prepare");
      const { port } = portFor(fakeWorkspace(FULL_WORKSPACE), { enabled: false });

      await port.admitForRun({ runId: RUN_ID, discoveryRoot: root });

      expect(written(root)).toEqual({});
    });

    it("reports an unusable discovery directory as a failed write, never a rejection", async () => {
      const root = discoveryRoot();
      // A regular file where the parent directory should be: creating anything below it fails.
      writeFileSync(join(root, "occupied"), "a file, not a directory");
      const { port, records } = portFor(fakeWorkspace(FULL_WORKSPACE));

      await expect(
        port.admitForRun({ runId: RUN_ID, discoveryRoot: join(root, "occupied", "discovery") }),
      ).resolves.toBeUndefined();

      const { event, persisted } = expectAdmissionLine(records);
      expect(event.errorKind).toBe("write-failed");
      expect(persisted).toMatchObject({
        state: "failed",
        reason: "write-failed",
        agentAdmittedCount: 0,
        admittedByteCount: 0,
      });
      expect(persisted.frames).toBeInstanceOf(Array);
    });
  });
});
