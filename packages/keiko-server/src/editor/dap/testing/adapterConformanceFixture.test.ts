import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createDapFrameReader, writeDapFrame } from "../dapFrameCodec.js";
import { superviseCapsuleTermination } from "../dapCapsuleSupervisor.js";
import type { Layer2DebugCapsulePlan } from "../debugCapsulePlan.js";
import {
  connectPrivateDapEndpoint,
  createNodeDapPrivateEndpointDeps,
} from "../dapPrivateEndpoint.js";
import { createDapProtocolClient } from "../dapProtocolClient.js";
import { fakeDapAdapterScriptPath, fakeNodeAdapterProvider } from "./adapterConformanceFixture.js";

function request(seq: number, command: string, args: object = {}): string {
  return JSON.stringify({ seq, type: "request", command, arguments: args });
}

function fixtureEndpointPlan(
  runtimeDirectory: string,
  socketPath: string,
  identity: {
    readonly device: number;
    readonly inode: number;
    readonly mode: number;
    readonly ownerUid: number;
  },
): Layer2DebugCapsulePlan {
  return {
    schemaVersion: "1",
    planId: "plan_fixture",
    workspacePartitionKey: "partition_a",
    activationRevision: 1,
    targetKind: "file",
    provisioningDigest: "a".repeat(64),
    backend: "oci",
    runtimeIdentityDigest: "b".repeat(64),
    spawnEnvelope: {
      runtimeDirectoryIdentity: {
        realPath: runtimeDirectory,
        identityDigest: "runtime_fixture",
        device: identity.device,
        inode: identity.inode,
        mode: identity.mode,
        ownerUid: identity.ownerUid,
      },
    },
    endpoint: {
      kind: "posixSocket",
      hostRuntimeDirectory: runtimeDirectory,
      hostSocketPath: socketPath,
      capsuleRuntimeDirectory: "/run/keiko-debug",
      capsuleSocketPath: "/run/keiko-debug/dap.sock",
      runtimeIdentity: "runtime_fixture",
    },
    capsule: {
      runtimeMount: {
        hostPath: runtimeDirectory,
        capsulePath: "/run/keiko-debug",
        mode: "0700",
        writable: true,
      },
      runtimeIdentityDigest: "b".repeat(64),
    },
    attestation: {
      filesystem: "executionRoot",
      network: "none",
      processScope: "capsule",
      runtimeDirectoryMode: "0700",
      endpointOwnership: "currentUser",
    },
    launchRequest: { command: "launch", arguments: { request: "launch" } },
  } as unknown as Layer2DebugCapsulePlan;
}

describe("fake DAP adapter conformance", () => {
  it("completes framed initialization and disconnects without leaving the subprocess alive", async () => {
    const child = spawn(process.execPath, [fakeDapAdapterScriptPath()], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const frames = createDapFrameReader(child.stdout);
    writeDapFrame(child.stdin, request(1, "initialize"));
    const initialized = JSON.parse(
      (await frames.next()).value?.toString("utf8") ?? "null",
    ) as unknown;
    expect(initialized).toMatchObject({ type: "response", request_seq: 1, success: true });
    await frames.next();
    writeDapFrame(child.stdin, request(2, "disconnect"));
    const disconnected = JSON.parse(
      (await frames.next()).value?.toString("utf8") ?? "null",
    ) as unknown;
    expect(disconnected).toMatchObject({ type: "response", request_seq: 2, success: true });
    await once(child, "exit");
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  });

  it.runIf(process.platform !== "win32")(
    "completes a real DAP handshake with the fixture adapter over the private Unix-domain-socket transport",
    async () => {
      const runtime = realpathSync(mkdtempSync(join(tmpdir(), "keiko-dap-fake-socket-")));
      chmodSync(runtime, 0o700);
      const socketPath = join(runtime, "dap.sock");
      const child = spawn(
        process.execPath,
        [fakeDapAdapterScriptPath(), `--socket=${socketPath}`],
        {
          stdio: "ignore",
        },
      );
      try {
        const stats = lstatSync(runtime);
        const plan = fixtureEndpointPlan(runtime, socketPath, {
          device: stats.dev,
          inode: stats.ino,
          mode: stats.mode,
          ownerUid: stats.uid,
        });
        const connection = await connectPrivateDapEndpoint(
          plan,
          createNodeDapPrivateEndpointDeps(),
        );
        const client = createDapProtocolClient({
          source: connection.source,
          sendFrame: connection.sendFrame,
        });
        try {
          await expect(client.controlRequest("initialize", {}, 5_000)).resolves.toMatchObject({
            supportsSetVariable: true,
          });
          await client.controlRequest("launch", { request: "launch" }, 5_000);
          const stopped = new Promise((resolve) => {
            client.onStopped((event) => {
              resolve(event);
            });
          });
          await client.controlRequest("configurationDone", {}, 5_000);
          await expect(stopped).resolves.toMatchObject({ reason: "breakpoint" });
        } finally {
          client.dispose();
          await connection.close();
        }
      } finally {
        child.kill("SIGKILL");
        await once(child, "exit");
        rmSync(runtime, { recursive: true, force: true });
      }
    },
  );

  it("pins the provider to the hermetic fixture", () => {
    expect(fakeNodeAdapterProvider().executableArgs).toStrictEqual([fakeDapAdapterScriptPath()]);
  });

  it("implements the closed launch, inspection, and step sequence used by the governed routes", async () => {
    const child = spawn(process.execPath, [fakeDapAdapterScriptPath()], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const frames = createDapFrameReader(child.stdout);
    const next = async (): Promise<Record<string, unknown>> =>
      JSON.parse((await frames.next()).value?.toString("utf8") ?? "null") as Record<
        string,
        unknown
      >;
    try {
      writeDapFrame(child.stdin, request(1, "initialize"));
      expect(await next()).toMatchObject({ type: "response", request_seq: 1, success: true });
      expect(await next()).toMatchObject({ type: "event", event: "initialized" });
      writeDapFrame(child.stdin, request(2, "launch", { request: "launch" }));
      expect(await next()).toMatchObject({ type: "response", request_seq: 2, success: true });
      writeDapFrame(child.stdin, request(3, "configurationDone"));
      expect(await next()).toMatchObject({ type: "response", request_seq: 3, success: true });
      expect(await next()).toMatchObject({
        type: "event",
        event: "stopped",
        body: { reason: "breakpoint" },
      });
      writeDapFrame(child.stdin, request(4, "stackTrace"));
      expect(await next()).toMatchObject({
        type: "response",
        request_seq: 4,
        body: { stackFrames: [expect.objectContaining({ name: "breakpointFixture" })] },
      });
      writeDapFrame(child.stdin, request(5, "next", { threadId: 1 }));
      expect(await next()).toMatchObject({ type: "response", request_seq: 5, success: true });
      expect(await next()).toMatchObject({ type: "event", event: "continued" });
      expect(await next()).toMatchObject({
        type: "event",
        event: "stopped",
        body: { reason: "step" },
      });
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });

  it.runIf(process.platform !== "win32")(
    "proves the qualified whole-capsule boundary leaves no descendant orphan",
    async () => {
      const child = spawn(process.execPath, [fakeDapAdapterScriptPath(), "--with-descendant"], {
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
      });
      const exited = once(child, "exit");
      try {
        const frames = createDapFrameReader(child.stdout);
        writeDapFrame(child.stdin, request(1, "descendantInfo"));
        const response = JSON.parse((await frames.next()).value?.toString("utf8") ?? "null") as {
          body?: { pid?: number };
        };
        const descendantPid = response.body?.pid;
        expect(descendantPid).toBeTypeOf("number");
        const status = await superviseCapsuleTermination(
          {
            planId: "plan_a",
            source: child.stdout,
            sink: child.stdin,
            processGroup: {
              pid: child.pid,
              kill: (signal): void => {
                if (child.pid !== undefined) process.kill(-child.pid, signal);
              },
            },
            exited: () => child.exitCode !== null || child.signalCode !== null,
            whenExited: (callback): void => {
              child.once("exit", callback);
            },
            inspectScope: () =>
              Promise.resolve({
                qualified: true,
                backend: "linuxNamespace" as const,
                runtimeIdentityDigest: "b".repeat(64),
                descendants: processExists(descendantPid ?? -1) ? 1 : 0,
              }),
            terminateContainment: async (): Promise<void> => {
              if (descendantPid !== undefined) process.kill(descendantPid, "SIGKILL");
              await expectProcessGone(descendantPid ?? -1);
            },
            cleanup: () => Promise.resolve(),
          },
          { backend: "linuxNamespace", runtimeIdentityDigest: "b".repeat(64) },
        );
        expect(status).toStrictEqual({ terminated: true, cleanupComplete: true });
        await expectProcessGone(descendantPid ?? -1);
      } finally {
        const childPid = child.pid;
        if (typeof childPid === "number") {
          try {
            process.kill(-childPid, "SIGKILL");
          } catch {
            // Already gone.
          }
          await exited;
        }
      }
    },
  );

  it("detects package-path and import forms while the DAP test and mjs tree remains clean", () => {
    const dapRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const forbidden = forbiddenAdapterIdentifiers();
    for (const identifier of forbidden) {
      const references = [
        identifier,
        [identifier, "dist", "main.js"].join("/"),
        ["import x from ", JSON.stringify(identifier)].join(""),
        ["await import(", JSON.stringify([identifier, "src"].join("/")), ")"].join(""),
      ];
      for (const reference of references)
        expect(hasForbiddenReference(reference, forbidden)).toBe(true);
    }
    const files = testAndModuleFiles(dapRoot);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(hasForbiddenReference(source, forbidden)).toBe(false);
    }
  });

  it("rejects every prohibited adapter identifier and non-fixture adapter process", () => {
    const forbidden = forbiddenAdapterIdentifiers();
    for (const identifier of forbidden)
      expect(hasForbiddenReference(identifier, forbidden)).toBe(true);

    const invoke = ["sp", "awn"].join("");
    const childProcessModule = ["node", ":", "child", "_", "process"].join("");
    const auditedImport = `import { ${invoke} } from ${JSON.stringify(childProcessModule)};`;
    const fakeInvocation = `${auditedImport}\n${invoke}(process.execPath, [fakeDapAdapterScriptPath()])`;
    const foreignInvocations = [
      `${invoke}(process.execPath, ["foreign-adapter.mjs"])`,
      `${invoke}("foreign-adapter", [])`,
      `import { ${invoke} as launch } from ${JSON.stringify(childProcessModule)};\nlaunch("foreign", [])`,
      `import * as childProcess from ${JSON.stringify(childProcessModule)};\nchildProcess.${invoke}("foreign", [])`,
      `import { ${["spawn", "Sync"].join("")} } from ${JSON.stringify(childProcessModule)}`,
      `import { ${["ex", "ec"].join("")} } from ${JSON.stringify(childProcessModule)}`,
      `import { ${["exec", "Sync"].join("")} } from ${JSON.stringify(childProcessModule)}`,
      `import { ${["exec", "File"].join("")} } from ${JSON.stringify(childProcessModule)}`,
      `import { ${["execFile", "Sync"].join("")} } from ${JSON.stringify(childProcessModule)}`,
      `import { ${["fo", "rk"].join("")} } from ${JSON.stringify(childProcessModule)}`,
      `const childProcess = require(${JSON.stringify(childProcessModule)})`,
      `const childProcess = await import(${JSON.stringify(childProcessModule)})`,
      `const childProcess = process.getBuiltinModule(${JSON.stringify(childProcessModule)})`,
    ];
    const escapedBindings = [
      `${fakeInvocation}\nconst launch = ${invoke};\nlaunch("foreign", [])`,
      `${fakeInvocation}\n${invoke}.call(undefined, "foreign", [])`,
    ];
    const transformedAdapter = `${auditedImport}\n${invoke}(process.execPath, [fakeDapAdapterScriptPath()].map(() => "foreign"))`;
    const transformedDescendant = `${auditedImport}\n${invoke}(process.execPath, ["-e"].map(() => "foreign"))`;
    expect(hasUnauthorizedChildProcessUse(fakeInvocation, "adapterTest")).toBe(false);
    expect(hasUnauthorizedChildProcessUse(transformedAdapter, "adapterTest")).toBe(true);
    expect(hasUnauthorizedChildProcessUse(transformedDescendant, "fakeAdapter")).toBe(true);
    for (const invocation of foreignInvocations)
      expect(hasUnauthorizedChildProcessUse(invocation, "none")).toBe(true);
    for (const invocation of escapedBindings)
      expect(hasUnauthorizedChildProcessUse(invocation, "adapterTest")).toBe(true);

    const dapRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    for (const file of testAndModuleFiles(dapRoot)) {
      const mode = file.endsWith("adapterConformanceFixture.test.ts")
        ? "adapterTest"
        : file.endsWith("fake-dap-adapter.mjs")
          ? "fakeAdapter"
          : "none";
      expect(hasUnauthorizedChildProcessUse(readFileSync(file, "utf8"), mode), file).toBe(false);
    }
  });
});

function forbiddenAdapterIdentifiers(): readonly string[] {
  const scope = String.fromCharCode(64) + ["vs", "code", "/"].join("");
  return [
    scope + ["debug", "adapter"].join(""),
    scope + ["debug", "protocol"].join(""),
    scope + ["js", "-", "debug"].join(""),
    ["js", "-", "debug"].join(""),
    ["vs", "code", "-", "js", "-", "debug"].join(""),
    ["dap", "Debug", "Server"].join(""),
    ["pwa", "-", "node"].join(""),
  ];
}

function hasForbiddenReference(source: string, forbidden: readonly string[]): boolean {
  return forbidden.some((identifier) => source.includes(identifier));
}

type ChildProcessAuditMode = "none" | "adapterTest" | "fakeAdapter";

function hasUnauthorizedChildProcessUse(source: string, mode: ChildProcessAuditMode): boolean {
  const sourceFile = ts.createSourceFile("audit.ts", source, ts.ScriptTarget.Latest, true);
  const audit = inspectChildProcessSyntax(sourceFile);
  if (mode === "none") return audit.moduleReferences.length > 0 || audit.spawnReferences.length > 0;
  if (audit.moduleReferences.length !== 1 || !hasSingleAuditedSpawnImport(audit.imports))
    return true;
  const directCalls = audit.spawnReferences.filter(isDirectSpawnCallee);
  return (
    directCalls.length === 0 ||
    audit.spawnReferences.some((reference) => !isAllowedSpawnReference(reference, mode))
  );
}

interface ChildProcessSyntaxAudit {
  readonly imports: readonly ts.ImportDeclaration[];
  readonly moduleReferences: readonly ts.StringLiteral[];
  readonly spawnReferences: readonly ts.Identifier[];
}

function inspectChildProcessSyntax(sourceFile: ts.SourceFile): ChildProcessSyntaxAudit {
  const imports: ts.ImportDeclaration[] = [];
  const moduleReferences: ts.StringLiteral[] = [];
  const spawnReferences: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isChildProcessModule(node.moduleSpecifier))
      imports.push(node);
    if (ts.isStringLiteral(node) && isChildProcessModule(node)) moduleReferences.push(node);
    if (ts.isIdentifier(node) && node.text === "spawn") spawnReferences.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { imports, moduleReferences, spawnReferences };
}

function isChildProcessModule(node: ts.Expression): boolean {
  return ts.isStringLiteral(node) && /^(?:node:)?child_process$/u.test(node.text);
}

function hasSingleAuditedSpawnImport(imports: readonly ts.ImportDeclaration[]): boolean {
  if (imports.length !== 1) return false;
  const clause = imports[0]?.importClause;
  if (!clause || clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== 1) return false;
  return isUnaliasedSpawnImport(bindings.elements[0]);
}

function isUnaliasedSpawnImport(element: ts.ImportSpecifier | undefined): boolean {
  if (!element || element.propertyName !== undefined) return false;
  return element.name.text === "spawn";
}

function isAllowedSpawnReference(
  reference: ts.Identifier,
  mode: Exclude<ChildProcessAuditMode, "none">,
): boolean {
  if (ts.isImportSpecifier(reference.parent) && reference.parent.name === reference) return true;
  const parent = reference.parent;
  return (
    ts.isCallExpression(parent) && parent.expression === reference && isAllowedSpawn(parent, mode)
  );
}

function isDirectSpawnCallee(reference: ts.Identifier): boolean {
  return ts.isCallExpression(reference.parent) && reference.parent.expression === reference;
}

function isAllowedSpawn(
  call: ts.CallExpression,
  mode: Exclude<ChildProcessAuditMode, "none">,
): boolean {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== "spawn") return false;
  const executable = call.arguments[0];
  const args = call.arguments[1];
  if (!isProcessExecutable(executable) || !args || !ts.isArrayLiteralExpression(args)) return false;
  const first = args.elements[0];
  return mode === "fakeAdapter" ? isExactEvalFlag(first) : isExactFixturePath(first);
}

function isProcessExecutable(node: ts.Expression | undefined): boolean {
  return (
    node !== undefined &&
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "execPath"
  );
}

function isExactEvalFlag(node: ts.Expression | undefined): boolean {
  return node !== undefined && ts.isStringLiteral(node) && node.text === "-e";
}

function isExactFixturePath(node: ts.Expression | undefined): boolean {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "fakeDapAdapterScriptPath" &&
    node.arguments.length === 0
  );
}

function testAndModuleFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...testAndModuleFiles(path));
    } else if (path.endsWith(".test.ts") || path.endsWith(".mjs")) {
      files.push(path);
    }
  }
  return files;
}

async function expectProcessGone(pid: number): Promise<void> {
  await expect.poll(() => processExists(pid)).toBe(false);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
