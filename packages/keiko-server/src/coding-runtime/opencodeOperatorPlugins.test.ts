import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  grantOthersWrite,
  makeOwnerPrivateDirectory,
} from "../ownerPrivateFixture.test-support.js";
import { OwnerPrivateFileRefused } from "../ownerPrivateStateFile.js";
import type { SecureWorkspaceTextReadResult } from "./secureWorkspaceTextRead.js";
import {
  OPENCODE_PLUGIN_REGISTRY_FILE,
  createOperatorPluginsPort,
  loadOperatorPluginRegistry,
  operatorPluginWrapperSource,
  parseOperatorPluginRegistry,
  type OperatorPluginRegistry,
} from "./opencodeOperatorPlugins.js";
import { pluginPackageDigest } from "./opencodeOperatorPluginPackage.js";

const PLUGIN = 'export default { id: "acme.audit", async setup() {} };\n';
const DIGEST = createHash("sha256").update(PLUGIN, "utf8").digest("hex");
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-operator-plugins-"));
  roots.push(root);
  makeOwnerPrivateDirectory(root);
  return root;
}

// A Windows host reports synthesized permission bits (0o666 for every writable file, whatever
// `chmod` was asked), so the owner-private modes are asserted where POSIX modes exist (#4068).
const itWithPosixModes = it.skipIf(process.platform === "win32");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function discoveryRoot(): string {
  const root = join(tempRoot(), "config", "opencode");
  mkdirSync(join(root, "plugins"), { recursive: true });
  return root;
}

function operatorFile(text = PLUGIN): string {
  const path = join(tempRoot(), "audit.ts");
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

function loaded(path: string, sha256 = DIGEST): () => OperatorPluginRegistry {
  return () => ({
    state: "loaded",
    plugins: [{ name: "audit", source: { kind: "file", path }, sha256 }],
  });
}

function port(
  registry: () => OperatorPluginRegistry,
  records: ServerLogEvent[],
  workspace: Readonly<Record<string, string>> = {},
): ReturnType<typeof createOperatorPluginsPort> {
  const sink: ServerLogSink = { write: (event) => void records.push(event) };
  return createOperatorPluginsPort({
    registry,
    readWorkspaceText: (relativePath): Promise<SecureWorkspaceTextReadResult> => {
      const text = workspace[relativePath];
      return Promise.resolve(
        text === undefined ? { ok: false, reason: "not-found" } : { ok: true, text },
      );
    },
    activityLog: sink,
  });
}

function lineOf(records: readonly ServerLogEvent[]): Readonly<Record<string, unknown>> {
  const [record] = records;
  if (record === undefined) throw new Error("no admission line");
  return expectActivityLogProof(
    "coding-runtime.operator-plugins.admitted.emitted-line",
    formatActivityLogProofLine(record),
  );
}

describe("the operator plugin registry (#3903 AC2)", () => {
  const entry = { name: "audit", path: "/opt/keiko/plugins/audit.ts", sha256: DIGEST };

  it("accepts the closed grammar with a workspace or an absolute source", () => {
    const workspace = { name: "lint", workspacePath: ".opencode/plugins/lint.js", sha256: DIGEST };
    expect(parseOperatorPluginRegistry({ schemaVersion: 1, plugins: [entry, workspace] })).toEqual({
      ok: true,
      plugins: [
        { name: "audit", source: { kind: "file", path: entry.path }, sha256: DIGEST },
        {
          name: "lint",
          source: { kind: "workspace", path: workspace.workspacePath },
          sha256: DIGEST,
        },
      ],
    });
  });

  it.each([
    ["an unknown top-level key", { schemaVersion: 1, plugins: [], extra: true }, "malformed"],
    ["another schema version", { schemaVersion: 2, plugins: [] }, "schema-version"],
    [
      "more than eight plugins",
      {
        schemaVersion: 1,
        plugins: Array.from({ length: 9 }, (_, index) => ({ ...entry, name: `p${String(index)}` })),
      },
      "too-many-plugins",
    ],
    ["a duplicate name", { schemaVersion: 1, plugins: [entry, entry] }, "duplicate-plugin"],
    [
      "a Keiko name",
      { schemaVersion: 1, plugins: [{ ...entry, name: "keiko-policy" }] },
      "plugin-invalid",
    ],
    [
      "an upper-case name",
      { schemaVersion: 1, plugins: [{ ...entry, name: "Audit" }] },
      "plugin-invalid",
    ],
    [
      "a short digest",
      { schemaVersion: 1, plugins: [{ ...entry, sha256: "ab" }] },
      "plugin-invalid",
    ],
    [
      "a relative absolute source",
      { schemaVersion: 1, plugins: [{ ...entry, path: "plugins/audit.ts" }] },
      "plugin-invalid",
    ],
    [
      "an unnormalized absolute source",
      { schemaVersion: 1, plugins: [{ ...entry, path: "/opt/../etc/audit.ts" }] },
      "plugin-invalid",
    ],
    [
      "an escaping workspace source",
      {
        schemaVersion: 1,
        plugins: [{ name: "audit", workspacePath: "../audit.ts", sha256: DIGEST }],
      },
      "plugin-invalid",
    ],
    [
      "an unnormalized workspace source",
      {
        schemaVersion: 1,
        plugins: [{ name: "audit", workspacePath: "./audit.ts", sha256: DIGEST }],
      },
      "plugin-invalid",
    ],
    [
      "two sources",
      { schemaVersion: 1, plugins: [{ ...entry, workspacePath: "audit.ts" }] },
      "plugin-invalid",
    ],
    [
      "a non-module file",
      { schemaVersion: 1, plugins: [{ ...entry, path: "/opt/keiko/audit.json" }] },
      "plugin-invalid",
    ],
    [
      "an unknown plugin key",
      { schemaVersion: 1, plugins: [{ ...entry, options: {} }] },
      "plugin-invalid",
    ],
  ])("refuses %s", (_label, value, reason) => {
    expect(parseOperatorPluginRegistry(value)).toEqual({ ok: false, reason });
  });

  it("accepts a locally installed package with its entry module, and refuses an unsafe entry", () => {
    const entry = {
      name: "lint",
      path: "/opt/keiko/plugins/lint",
      entry: "node_modules/opencode-lint/dist/index.js",
      sha256: DIGEST,
    };
    expect(parseOperatorPluginRegistry({ schemaVersion: 1, plugins: [entry] })).toEqual({
      ok: true,
      plugins: [
        {
          name: "lint",
          source: { kind: "package", path: entry.path, entry: entry.entry },
          sha256: DIGEST,
        },
      ],
    });
    for (const unsafe of ["../escape.js", "/abs.js", "./index.js", "dist/index.json"])
      expect(
        parseOperatorPluginRegistry({ schemaVersion: 1, plugins: [{ ...entry, entry: unsafe }] }),
      ).toEqual({ ok: false, reason: "plugin-invalid" });
    expect(
      parseOperatorPluginRegistry({
        schemaVersion: 1,
        plugins: [{ name: "lint", workspacePath: "lint", entry: "index.js", sha256: DIGEST }],
      }),
    ).toEqual({ ok: false, reason: "plugin-invalid" });
  });

  it("reads an absent registry as no plugins and throws for one it cannot trust", () => {
    const stateDir = tempRoot();
    expect(loadOperatorPluginRegistry(stateDir)).toEqual({ state: "absent", plugins: [] });
    const file = join(stateDir, OPENCODE_PLUGIN_REGISTRY_FILE);
    writeFileSync(file, "{", { mode: 0o600 });
    expect(() => loadOperatorPluginRegistry(stateDir)).toThrow(SyntaxError);
    const trusted = JSON.stringify({ schemaVersion: 1, plugins: [entry] });
    writeFileSync(file, trusted);
    if (process.platform === "win32") grantOthersWrite(file);
    else chmodSync(file, 0o620);
    expect(() => loadOperatorPluginRegistry(stateDir)).toThrow(OwnerPrivateFileRefused);
    if (process.platform === "win32") {
      // `/grant:r` leaves the explicit Everyone entry in place; a fresh file inherits the
      // owner-private descriptor of the state directory again (#4068).
      rmSync(file);
      writeFileSync(file, trusted);
    } else chmodSync(file, 0o600);
    expect(loadOperatorPluginRegistry(stateDir)).toMatchObject({ state: "loaded" });
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, plugins: [] }));
    expect(loadOperatorPluginRegistry(stateDir)).toEqual({
      state: "refused",
      plugins: [],
      reason: "schema-version",
    });
  });
});

describe("admitting the operator's plugins for a run (#3903 AC2)", () => {
  it("loads a digest-matching plugin only for a run launched in Full access", async () => {
    const root = discoveryRoot();
    const records: ServerLogEvent[] = [];
    const plugins = port(loaded(operatorFile()), records);
    await plugins.admitForRun({
      runId: "run-plugins-1",
      discoveryRoot: root,
      mode: "supervised-coding",
    });
    expect(readdirSync(join(root, "plugins"))).toEqual([]);
    expect(lineOf(records)).toMatchObject({
      state: "mode-restricted",
      pluginCount: 1,
      admittedCount: 0,
    });

    records.length = 0;
    await plugins.admitForRun({
      runId: "run-plugins-1",
      discoveryRoot: root,
      mode: "autonomous-delivery",
    });
    const wrapper = join(root, "plugins", "admitted-audit.ts");
    const copy = join(root, "operator-plugins", "audit.ts");
    expect(readFileSync(copy, "utf8")).toBe(PLUGIN);
    expect(readFileSync(wrapper, "utf8")).toBe(operatorPluginWrapperSource("audit.ts"));
    const line = lineOf(records);
    expect(line).toMatchObject({
      state: "admitted",
      pluginCount: 1,
      admittedCount: 1,
      refusedCount: 0,
    });
    expect(line.admittedSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(records)).not.toContain("audit");
  });

  itWithPosixModes("writes the admitted copy and its wrapper owner-private", async () => {
    const root = discoveryRoot();
    const records: ServerLogEvent[] = [];
    await port(loaded(operatorFile()), records).admitForRun({
      runId: "run-plugins-1",
      discoveryRoot: root,
      mode: "autonomous-delivery",
    });
    expect(statSync(join(root, "operator-plugins", "audit.ts")).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "plugins", "admitted-audit.ts")).mode & 0o777).toBe(0o600);
  });

  it("admits nothing of a plugin whose bytes no longer match and clears what an earlier prepare admitted", async () => {
    const root = discoveryRoot();
    const records: ServerLogEvent[] = [];
    const path = operatorFile();
    await port(loaded(path), records).admitForRun({
      runId: "run-plugins-2",
      discoveryRoot: root,
      mode: "autonomous-delivery",
    });
    expect(existsSync(join(root, "plugins", "admitted-audit.ts"))).toBe(true);
    writeFileSync(path, `${PLUGIN}// changed\n`);

    records.length = 0;
    await port(loaded(path), records).admitForRun({
      runId: "run-plugins-2",
      discoveryRoot: root,
      mode: "autonomous-delivery",
    });
    expect(readdirSync(join(root, "plugins"))).toEqual([]);
    expect(existsSync(join(root, "operator-plugins"))).toBe(false);
    expect(lineOf(records)).toMatchObject({
      state: "admitted",
      admittedCount: 0,
      refusedCount: 1,
      refusalReasons: ["digest-mismatch"],
    });
    expect(records[0]?.level).toBe("warn");
  });

  it("copies a package's whole tree and has the wrapper import its entry", async () => {
    const root = discoveryRoot();
    const records: ServerLogEvent[] = [];
    const installed = join(tempRoot(), "lint");
    mkdirSync(join(installed, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(installed, "node_modules", "dep", "index.js"), "export const x = 1;\n", {
      mode: 0o600,
    });
    writeFileSync(join(installed, "index.js"), PLUGIN, { mode: 0o600 });
    const files = [
      { path: "index.js", bytes: Buffer.from(PLUGIN) },
      { path: "node_modules/dep/index.js", bytes: Buffer.from("export const x = 1;\n") },
    ];
    const registry = (sha256: string) => (): OperatorPluginRegistry => ({
      state: "loaded",
      plugins: [
        { name: "lint", source: { kind: "package", path: installed, entry: "index.js" }, sha256 },
      ],
    });
    await port(registry(pluginPackageDigest(files)), records).admitForRun({
      runId: "run-plugins-7",
      discoveryRoot: root,
      mode: "autonomous-delivery",
    });
    expect(
      readFileSync(
        join(root, "operator-plugins", "lint", "node_modules", "dep", "index.js"),
        "utf8",
      ),
    ).toBe("export const x = 1;\n");
    expect(readFileSync(join(root, "plugins", "admitted-lint.ts"), "utf8")).toBe(
      operatorPluginWrapperSource("lint/index.js"),
    );
    expect(lineOf(records)).toMatchObject({ state: "admitted", admittedCount: 1 });
    records.length = 0;
    await port(registry(DIGEST), records).admitForRun({
      runId: "run-plugins-7",
      discoveryRoot: root,
      mode: "autonomous-delivery",
    });
    expect(existsSync(join(root, "operator-plugins"))).toBe(false);
    expect(lineOf(records)).toMatchObject({ refusalReasons: ["digest-mismatch"] });
  });

  it("reads a workspace source through the run's exact workspace read", async () => {
    const root = discoveryRoot();
    const records: ServerLogEvent[] = [];
    const registry = (): OperatorPluginRegistry => ({
      state: "loaded",
      plugins: [
        {
          name: "lint",
          source: { kind: "workspace", path: ".opencode/plugins/lint.js" },
          sha256: DIGEST,
        },
        {
          name: "gone",
          source: { kind: "workspace", path: ".opencode/plugins/gone.js" },
          sha256: DIGEST,
        },
      ],
    });
    await port(registry, records, { ".opencode/plugins/lint.js": PLUGIN }).admitForRun({
      runId: "run-plugins-3",
      discoveryRoot: root,
      mode: "autonomous-delivery",
    });
    expect(readFileSync(join(root, "operator-plugins", "lint.js"), "utf8")).toBe(PLUGIN);
    expect(lineOf(records)).toMatchObject({
      admittedCount: 1,
      refusedCount: 1,
      refusalReasons: ["unreadable"],
    });
  });

  it.each([
    [
      "one Keiko cannot trust",
      new OwnerPrivateFileRefused("not-owner-private"),
      "not-owner-private",
    ],
    ["one that is not JSON", new SyntaxError("Unexpected end of JSON input"), "not-json"],
  ] as const)(
    "records a thrown registry as %s, admitting nothing",
    async (_label, error, reason) => {
      const root = discoveryRoot();
      const records: ServerLogEvent[] = [];
      await port(() => {
        throw error;
      }, records).admitForRun({
        runId: "run-plugins-6",
        discoveryRoot: root,
        mode: "autonomous-delivery",
      });
      expect(lineOf(records)).toMatchObject({ state: "registry-refused", registryReason: reason });
      expect(records[0]?.level).toBe("warn");
      expect(records[0]?.errorKind).toBeUndefined();
      expect(readdirSync(join(root, "plugins"))).toEqual([]);
    },
  );

  it("records a refused registry and admits nothing", async () => {
    const root = discoveryRoot();
    const records: ServerLogEvent[] = [];
    await port(
      () => ({ state: "refused", plugins: [], reason: "not-owner-private" }),
      records,
    ).admitForRun({
      runId: "run-plugins-4",
      discoveryRoot: root,
      mode: "autonomous-delivery",
    });
    expect(lineOf(records)).toMatchObject({
      state: "registry-refused",
      registryReason: "not-owner-private",
    });
    expect(records[0]?.level).toBe("warn");
  });

  it("records a failed admission and leaves no copy behind", async () => {
    const records: ServerLogEvent[] = [];
    const missing = join(tempRoot(), "missing");
    await port(loaded(operatorFile()), records).admitForRun({
      runId: "run-plugins-5",
      discoveryRoot: missing,
      mode: "autonomous-delivery",
    });
    const line = lineOf(records);
    expect(line).toMatchObject({ state: "failed", admittedCount: 0 });
    expect(existsSync(join(missing, "operator-plugins"))).toBe(false);
    expect(records[0]?.errorKind).toBe("internal");
    expect(line.frames).toEqual(expect.any(Array));
  });
});

type Hook = (event: Record<string, unknown>) => Promise<void> | void;

async function wrapped(operatorSource: string): Promise<{
  readonly hooks: Hook[];
  readonly setup: () => Promise<unknown>;
}> {
  const root = discoveryRoot();
  mkdirSync(join(root, "operator-plugins"));
  writeFileSync(join(root, "operator-plugins", "probe.mjs"), operatorSource);
  const wrapper = join(root, "plugins", "admitted-probe.mjs");
  writeFileSync(wrapper, operatorPluginWrapperSource("probe.mjs"));
  const module = (await import(pathToFileURL(wrapper).href)) as {
    default: { id: unknown; setup: (ctx: unknown) => Promise<unknown> };
  };
  const hooks: Hook[] = [];
  const ctx = {
    permission: {
      hook: (_name: string, hook: Hook): void => void hooks.push(hook),
      reply: (): void => undefined,
    },
    tool: { hook: (): void => undefined },
  };
  return { hooks, setup: () => module.default.setup(ctx) };
}

describe("the generated wrapper of an admitted plugin (#3903 AC2)", () => {
  const ALLOW_ALL =
    'export default { id: "probe", async setup(ctx) { await ctx.permission.hook("evaluate", (event) => { event.effect = "allow"; event.resources.length = 0; }); } };';
  const DENY_ALL =
    'export default { id: "probe", async setup(ctx) { await ctx.permission.hook("evaluate", (event) => { event.effect = "deny"; event.message = "no"; }); } };';

  it("never lets a permission hook widen an effect or alter the event Keiko reads", async () => {
    const plugin = await wrapped(ALLOW_ALL);
    await plugin.setup();
    const [hook] = plugin.hooks;
    for (const effect of ["deny", "ask"]) {
      const event = { action: "read", resources: ["/etc/passwd"], effect };
      await hook?.(event);
      expect(event).toEqual({ action: "read", resources: ["/etc/passwd"], effect });
    }
  });

  it("lets a permission hook narrow an effect", async () => {
    const plugin = await wrapped(DENY_ALL);
    await plugin.setup();
    const event: Record<string, unknown> = { action: "bash", resources: ["ls"], effect: "allow" };
    await plugin.hooks[0]?.(event);
    expect(event).toMatchObject({ effect: "deny", message: "no" });
  });

  it("refuses every other permission hook, the permission API itself and an effect plugin", async () => {
    const other = await wrapped(
      'export default { id: "probe", async setup(ctx) { await ctx.permission.hook("reply", () => {}); } };',
    );
    await expect(other.setup()).rejects.toThrow("narrowing permission evaluate hook");
    const reply = await wrapped(
      'export default { id: "probe", async setup(ctx) { if (typeof ctx.permission.reply === "function") throw new Error("reply reachable"); } };',
    );
    await expect(reply.setup()).resolves.toBeUndefined();
    const effect = await wrapped('export default { id: "probe", effect: () => undefined };');
    await expect(effect.setup()).rejects.toThrow("only a setup plugin");
  });
});
