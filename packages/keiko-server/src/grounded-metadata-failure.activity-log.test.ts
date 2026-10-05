import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PathEscapeError,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import {
  nodeWorkspaceFs,
  WorkspaceDescriptorReadError,
} from "@oscharko-dev/keiko-workspace/internal/fs";
import { retrieveConnectedContextPack, type OrchestratorInput } from "./grounded-orchestrator.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  formatActivityLogProofLine,
  expectActivityLogProof,
} from "../../../tests/support/activity-log-proof.js";

import { observedFailureQuery } from "../../../tests/support/observed-failure-query.js";

const CORRELATION = "metadata-failure-review-0001";
const PRIVATE_MESSAGE = "private customer directory and source detail";

function metadataInput(root: string): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "private-scope",
      workspaceRoot: root,
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
      explicitConnection: true,
    },
    query: {
      kind: "natural-language",
      text: "Which Java version and package manager does this project use?",
      maxResults: 20,
      caseSensitive: false,
      emittedAtMs: 0,
    },
  };
}

function workspace(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "fixture",
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function metadataFailureFs(root: string, failure: Error | undefined): WorkspaceFs {
  const { iterateDirectory, ...withoutIteration } = nodeWorkspaceFs;
  if (failure === undefined || iterateDirectory === undefined) return withoutIteration;
  let rootIterations = 0;
  return {
    ...nodeWorkspaceFs,
    iterateDirectory: async function* (path): AsyncIterable<WorkspaceDirEntry> {
      const metadata = path === root && ++rootIterations === 2;
      for await (const entry of iterateDirectory(path)) {
        yield entry;
        if (metadata) throw failure;
      }
    },
  };
}

interface FailureCase {
  readonly name: string;
  readonly failure: Error | undefined;
  readonly reason: string;
  readonly failureKind: string;
  readonly errorKind: string;
}

async function runMetadataFailure(test: FailureCase): Promise<void> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "keiko-metadata-failure-"));
  const root = realpathSync(temporaryRoot);
  const log = createBufferedServerLogSink();
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.16.0" }));
    writeFileSync(
      join(root, "pom.xml"),
      "<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>",
    );
    const fs = metadataFailureFs(root, test.failure);
    const input = metadataInput(root);
    // Explicit files are readable without directory traversal. A missing streaming port then
    // affects supplemental metadata discovery only, instead of invalidating primary retrieval.
    const selectedInput =
      test.failure === undefined
        ? {
            ...input,
            scope: {
              ...input.scope,
              kind: "files" as const,
              relativePaths: ["package.json", "pom.xml"],
            },
          }
        : input;
    const result = await retrieveConnectedContextPack(selectedInput, {
      correlationId: CORRELATION,
      activityLog: log,
      fs,
      nowMs: () => 0,
      detectWorkspace: () => workspace(root),
      answerer: { answer: () => Promise.resolve("unused") },
    });
    expect(result.pack.files.map((file) => file.scopePath)).toEqual(
      expect.arrayContaining(["package.json", "pom.xml"]),
    );
    const events = log.events.filter(
      (event) => event.op === "search.connected-context.metadata-unavailable",
    );
    expect(events.length).toBeGreaterThan(0);
    const details = log.events.find(
      (event) => event.op === "search.connected-context.source-details",
    );
    expect(details?.extra?.metadataUnavailableInspectionCount).toBe(events.length);
    expect(details).toBeDefined();
    if (details === undefined) throw new TypeError("Missing source diagnostics.");
    const retained = observedFailureQuery([details]);
    expect(retained.events.some((event) => event.parsed.view.op === details.op)).toBe(true);
    expect(
      log.events.filter((event) => event.op === "search.connected-context.completed"),
    ).toHaveLength(1);
    expect(
      log.events.filter((event) => event.op === "search.connected-context.failed"),
    ).toHaveLength(0);
    for (const event of events) {
      expect(event).toMatchObject({
        correlationId: CORRELATION,
        level: "warn",
        errorKind: test.errorKind,
      });
      expect(event.extra).toMatchObject({ failureKind: test.failureKind, reason: test.reason });
      if (test.failure?.cause !== undefined) expect(event.extra?.causeChain).toEqual(["Error"]);
      expect(event.extra?.scopePathDigest).toMatch(/^[a-f0-9]{64}$/u);
      const line = expectActivityLogProof(
        "search.connected-context.metadata-unavailable.line",
        formatActivityLogProofLine(event),
      );
      expect(line).toHaveProperty("correlationId", CORRELATION);
    }
    const raw = log.lines().join("\n");
    expect(raw).not.toContain(root);
    expect(raw).not.toContain(PRIVATE_MESSAGE);
    expect(raw).not.toContain("maven.compiler.release");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

describe("metadata enumeration failure evidence", () => {
  it.each([
    {
      name: "permission",
      failure: Object.assign(new Error(PRIVATE_MESSAGE), { code: "EACCES" }),
      reason: "permission-denied",
      failureKind: "EACCES",
      errorKind: "permission-denied",
    },
    {
      name: "membership change",
      failure: new WorkspaceDescriptorReadError("directory-membership-changed"),
      reason: "directory-changed",
      failureKind: "WorkspaceDescriptorReadError",
      errorKind: "unavailable",
    },
    {
      name: "containment",
      failure: new PathEscapeError(PRIVATE_MESSAGE, "/private/customer/outside"),
      reason: "containment-denied",
      failureKind: "WORKSPACE_PATH_ESCAPE",
      errorKind: "permission-denied",
    },
    {
      name: "missing streaming port with explicitly selected manifests",
      failure: undefined,
      reason: "streaming-unavailable",
      failureKind: "MetadataDirectoryUnavailableError",
      errorKind: "unavailable",
    },
    {
      name: "unexpected callback",
      failure: new TypeError(PRIVATE_MESSAGE, {
        cause: Object.assign(new Error(PRIVATE_MESSAGE), { code: "EIO" }),
      }),
      reason: "unexpected",
      failureKind: "TypeError",
      errorKind: "internal",
    },
  ])("records $name without losing valid sibling manifests", async (test) => {
    await runMetadataFailure(test);
  });
});
