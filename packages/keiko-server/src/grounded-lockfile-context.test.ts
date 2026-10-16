import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMicroIndex } from "@oscharko-dev/keiko-workflows";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { materializeConnectedFixture, runConnectedRetrievalEval } from "./grounded-eval-support.js";
import { retrieveConnectedContextPack, type OrchestratorInput } from "./grounded-orchestrator.js";

const LOCKFILE = "frontend/package-lock.json";
const SOURCES = {
  "frontend/src/OrderForm.tsx": "export const OrderForm = () => 'React order form';\n",
  "frontend/package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }),
  "frontend/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  "frontend/vitest.config.mjs": "export default { test: { environment: 'jsdom' } };\n",
  "frontend/test/setup.ts": "import '@testing-library/jest-dom/vitest';\n",
  "frontend/src/orderSchema.ts": "export const minimumOrderQuantity = 1;\n",
  "README.md": "Accepted order behavior: quantity is positive; pending fields stay enabled.\n",
};
const FILES = {
  ...SOURCES,
  [LOCKFILE]: JSON.stringify(
    {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { react: "^19.0.0" } },
        "node_modules/react": { version: "19.3.0" },
        "node_modules/vitest": { version: "4.1.11" },
        "node_modules/@testing-library/react": { version: "16.4.0" },
        "node_modules/@mui/material": { version: "9.5.0" },
        "node_modules/react-hook-form": { version: "7.90.0" },
        "node_modules/zod": { version: "4.6.7" },
        "node_modules/@hookform/resolvers": { version: "5.9.1" },
      },
    },
    null,
    2,
  ),
};
const TEST_GENERATION_QUERY = `Generate one complete Vitest and React Testing Library integration test file for frontend/src/OrderForm.tsx. Inspect ${Object.keys(SOURCES).slice(1).join(", ")}. Use the real React Hook Form, Zod resolver and MUI controls. Cover missing/invalid email, missing acceptance of terms, quantity boundaries 1 and 6 and invalid blank/fractional/0/7 values, selecting the afternoon session, the validated callback payload, pending control states, displaying the returned confirmation, and a failed order followed by a successful retry while retaining user input and clearing the old error. Put the test at frontend/src/OrderForm.test.tsx. Return exactly one complete TSX code block, followed by a short source note and any missing evidence. Do not modify production code or claim tests were executed.`;
const roots: string[] = [];
const answerer = {
  answer: (): Promise<never> => Promise.reject(new TypeError("No model call is permitted.")),
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(git: boolean): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-lockfile-context-")));
  roots.push(root);
  await materializeConnectedFixture(root, {
    ...FILES,
    ...(git ? { ".git/HEAD": "ref: refs/heads/main\n" } : {}),
  });
  return root;
}

function request(root: string, text: string, paths: string[] = []): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "lockfile-context",
      workspaceRoot: root,
      kind: paths.length > 0 ? "files" : "workspace-root",
      relativePaths: paths,
      connectedAtMs: 0,
      conversationId: undefined,
      explicitConnection: true,
    },
    query: {
      kind: "natural-language",
      text,
      caseSensitive: false,
      maxResults: 100,
      emittedAtMs: 0,
    },
  };
}

describe("lockfile evidence in final connected context", () => {
  it.each(
    [
      "Keep dependencies unchanged.",
      "Do not change dependency versions.",
      "Don't update dependencies.",
      "Do not change dependencies and do not report which versions are installed.",
      "Do not change dependencies, but do not report which versions are installed.",
      "Fix the test without changing production code, dependencies, or accepted requirements.",
      "Ändere keine Abhängigkeiten oder Paketversionen.",
      "Lass die Versionen der Abhängigkeiten unverändert.",
    ].flatMap((constraint) => [
      { constraint, git: false },
      { constraint, git: true },
    ]),
  )("does not promote lockfiles for $constraint (Git: $git)", async ({ constraint, git }) => {
    const query = `${TEST_GENERATION_QUERY} ${constraint}`;
    const log = createBufferedServerLogSink();
    const { pack } = await runConnectedRetrievalEval({
      files: { ...FILES, ...(git ? { ".git/HEAD": "ref: refs/heads/main\n" } : {}) },
      query,
      activityLog: log,
      correlationId: "dependency-preservation",
    });
    expect(pack.files.map((file) => file.scopePath)).toEqual(
      expect.arrayContaining(Object.keys(SOURCES)),
    );
    expect(pack.files.map((file) => file.scopePath)).not.toContain(LOCKFILE);
    if (!git)
      expect(pack.omitted).toContainEqual(
        expect.objectContaining({ scopePath: LOCKFILE, reason: "low-relevance" }),
      );
    expect(pack.files).toHaveLength(Object.keys(SOURCES).length);
    const completed = log.events.find((event) => event.op === "search.connected-context.completed");
    const line = formatActivityLogProofLine(completed ?? {});
    const proof = expectActivityLogProof("search.connected-context.completed.line", line);
    expect(proof).toMatchObject({
      selectedFileCount: pack.files.length,
      omittedCount: pack.omitted.length,
    });
    expect(line).not.toContain(constraint);
    expect(line).not.toContain(LOCKFILE);
  });

  it.each([
    "Keep dependencies unchanged, but report the resolved React version.",
    "Keep dependencies unchanged and tell me which React version is resolved.",
    "Keep dependencies unchanged and explain which React version is resolved.",
    "Don't update dependencies and explain the resolved React version.",
    "Do not change dependencies and describe the installed React version.",
    "Without changing dependencies, explain the resolved React version.",
    "Do not change dependency versions; report the resolved React version.",
    "Don't update dependencies, but report the resolved React version.",
    "Ändere keine Abhängigkeiten, aber nenne die aufgelöste React-Version.",
    "Lass die Versionen der Abhängigkeiten unverändert und nenne die aufgelöste React-Version.",
  ])("retains affirmative dependency evidence alongside a constraint: %s", async (question) => {
    const { pack } = await runConnectedRetrievalEval({
      files: FILES,
      query: `Inspect frontend/src/OrderForm.tsx. ${question}`,
    });
    expect(pack.files.map((file) => file.scopePath)).toContain(LOCKFILE);
  });

  it.each([
    'The failed assertion is `expect(value).toBe("locked")`.',
    'The failure text is "expected version 2 but received 1".',
    "The affected source is frontend/src/version.ts.",
  ])("does not infer package metadata from source or diagnostic data: %s", async (detail) => {
    const { pack } = await runConnectedRetrievalEval({
      files: { ...FILES, "frontend/src/version.ts": "export const version = 2;\n" },
      query: `${TEST_GENERATION_QUERY} ${detail}`,
    });
    expect(pack.files.map((file) => file.scopePath)).not.toContain(LOCKFILE);
  });

  it.each([false, true])(
    "keeps all seven requested sources without incidental lockfile context (Git: %s)",
    async (git) => {
      const log = createBufferedServerLogSink();
      const { pack } = await runConnectedRetrievalEval({
        files: { ...FILES, ...(git ? { ".git/HEAD": "ref: refs/heads/main\n" } : {}) },
        query: TEST_GENERATION_QUERY,
        activityLog: log,
        correlationId: "lockfile-source-focus",
      });
      expect(pack.files.map((file) => file.scopePath)).toEqual(
        expect.arrayContaining(Object.keys(SOURCES)),
      );
      expect(pack.files.map((file) => file.scopePath)).not.toContain(LOCKFILE);
      expect(pack.usage.excerptBytes).toBe(
        pack.files.reduce(
          (total, file) =>
            total + file.excerpts.reduce((bytes, excerpt) => bytes + excerpt.contentBytes, 0),
          0,
        ),
      );
      expect(JSON.stringify(log.events)).not.toContain(LOCKFILE);
      expect(
        log.events.find((event) => event.op === "search.connected-context.completed")?.extra,
      ).toMatchObject({ selectedFileCount: pack.files.length, omittedCount: pack.omitted.length });
      if (!git)
        expect(pack.omitted).toContainEqual(
          expect.objectContaining({ scopePath: LOCKFILE, reason: "low-relevance" }),
        );
    },
  );

  it.each([
    `Which resolved React version is recorded in ${LOCKFILE}?`,
    "Which exact resolved React version is locked for this frontend, rather than the declared range?",
    "Show the transitive dependency versions for the frontend React test setup.",
    "Inspect package-lock.json alongside frontend/package.json.",
    'Keep dependencies unchanged, but inspect "package-lock.json".',
    "Welche tatsächlich aufgelösten Versionen von React und seinen transitiven Abhängigkeiten nutzt das Frontend?",
    "Erzeuge Tests für frontend/src/OrderForm.tsx mit den aufgelösten Versionen der Abhängigkeiten.",
  ])("retains resolved dependency evidence for %s", async (query) => {
    const { pack } = await runConnectedRetrievalEval({ files: FILES, query });
    expect(
      pack.files
        .find((file) => file.scopePath === LOCKFILE)
        ?.excerpts.map((excerpt) => excerpt.content)
        .join("\n"),
      JSON.stringify(pack.omitted),
    ).toContain('"19.3.0"');
  });

  it.each([false, true])("preserves an explicitly selected lockfile (Git: %s)", async (git) => {
    const root = await fixture(git);
    const out = await retrieveConnectedContextPack(
      request(root, "Explain these selected files.", [LOCKFILE, "frontend/package.json"]),
      { correlationId: undefined, answerer },
    );
    expect(out.pack.files.map((file) => file.scopePath)).toContain(LOCKFILE);
  });

  it("retains a relevant lockfile when it is the only available evidence", async () => {
    const { pack } = await runConnectedRetrievalEval({
      files: { [LOCKFILE]: FILES[LOCKFILE] },
      query: "How does the frontend use React and Vitest?",
    });
    expect(pack.files.map((file) => file.scopePath)).toEqual([LOCKFILE]);
  });

  it.each([false, true])(
    "discovers requested dependency metadata only along the selected module (Git: %s)",
    async (git) => {
      const sibling = "frontend-other/package-lock.json";
      const { pack } = await runConnectedRetrievalEval({
        files: {
          ...FILES,
          [sibling]: FILES[LOCKFILE],
          ...(git ? { ".git/HEAD": "ref: refs/heads/main\n" } : {}),
        },
        query:
          "Erzeuge Tests für frontend/src/OrderForm.tsx mit den aufgelösten Versionen der Abhängigkeiten.",
      });
      expect(pack.files.map((file) => file.scopePath)).toContain(LOCKFILE);
      expect(pack.files.map((file) => file.scopePath)).toContain("frontend/package.json");
      expect(pack.files.map((file) => file.scopePath)).not.toContain(sibling);
    },
  );

  it("keeps the original file, byte and search ceilings for dependency metadata discovery", async () => {
    const budget = {
      ...DEFAULT_EXPLORATION_BUDGET,
      filesReadMax: 1,
      excerptBytesMax: 256,
      searchCallsMax: 2,
    };
    const { pack } = await runConnectedRetrievalEval({
      files: FILES,
      query:
        "Erzeuge Tests für frontend/src/OrderForm.tsx mit den aufgelösten Versionen der Abhängigkeiten.",
      budget,
    });
    expect(pack.usage.filesRead).toBeLessThanOrEqual(budget.filesReadMax);
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(budget.excerptBytesMax);
    expect(pack.usage.searchCalls).toBeLessThanOrEqual(budget.searchCallsMax);
    expect(pack.usage.modelOutputTokens).toBe(0);
    expect(pack.uncertainty.some((marker) => marker.kind === "budget-clipped")).toBe(true);
  });

  it("does not enumerate a derived metadata ancestor outside the selected directory", async () => {
    const root = await fixture(false);
    const input = request(
      root,
      "Erzeuge Tests für frontend/src/OrderForm.tsx mit den aufgelösten Versionen der Abhängigkeiten.",
    );
    const iterate = nodeWorkspaceFs.iterateDirectory;
    if (iterate === undefined) throw new TypeError("Streaming directory fixture is required.");
    const iterateDirectory = vi.fn(iterate);
    const readDir = vi.fn(nodeWorkspaceFs.readDir);
    await retrieveConnectedContextPack(
      { ...input, scope: { ...input.scope, kind: "directory", relativePaths: ["frontend/src"] } },
      {
        correlationId: undefined,
        answerer,
        fs: { ...nodeWorkspaceFs, iterateDirectory, readDir },
        detectWorkspace: () => ({
          root,
          selectedRoot: root,
          name: "fixture",
          version: "0",
          testFramework: "vitest",
          sourceDirs: [],
          testDirs: [],
          languages: ["typescript"],
          ignoreLines: [],
        }),
      },
    );
    expect(iterateDirectory.mock.calls.map(([path]) => path)).not.toContain(join(root, "frontend"));
    expect(readDir.mock.calls.map(([path]) => path)).not.toContain(join(root, "frontend"));
    expect(iterateDirectory.mock.calls.map(([path]) => path)).toContain(join(root, "frontend/src"));
  });

  it("preserves ordinary documents alongside relevant source evidence", async () => {
    const { pack } = await runConnectedRetrievalEval({
      files: { ...FILES, "notes.txt": "React order form: pending fields stay enabled.\n" },
      query:
        "Explain the React order form and its pending fields using notes.txt and frontend/src/OrderForm.tsx.",
    });
    expect(pack.files.map((file) => file.scopePath)).toContain("notes.txt");
    expect(pack.files.map((file) => file.scopePath)).not.toContain(LOCKFILE);
  });

  it.each([false, true])("keeps the same focused evidence on warm reuse (Git: %s)", async (git) => {
    const root = await fixture(git);
    const microIndex = createMicroIndex({ ttlMs: 60_000, maxEntries: 8, nowMs: () => 0 });
    const get = vi.spyOn(microIndex, "get");
    const input = request(
      root,
      `Generate React Vitest tests using ${Object.keys(SOURCES).join(", ")}.`,
    );
    const deps = { correlationId: undefined, answerer, microIndex, nowMs: (): number => 0 };
    const cold = await retrieveConnectedContextPack(input, deps);
    expect(cold.pack.files.map((file) => file.scopePath)).toEqual(
      expect.arrayContaining(Object.keys(SOURCES)),
    );
    expect(cold.pack.files.map((file) => file.scopePath)).not.toContain(LOCKFILE);
    get.mockClear();
    const warm = await retrieveConnectedContextPack(input, deps);
    expect(
      get.mock.results.some((result) => result.type === "return" && result.value !== undefined),
    ).toBe(true);
    expect(warm.pack.files).toEqual(cold.pack.files);
    expect(warm.pack.omitted).toEqual(cold.pack.omitted);
  });

  it("reads the current module lockfile after its resolved version changes", async () => {
    const root = await fixture(false);
    const microIndex = createMicroIndex({ ttlMs: 60_000, maxEntries: 8, nowMs: () => 0 });
    const input = request(
      root,
      "Erzeuge Tests für frontend/src/OrderForm.tsx mit den aufgelösten Versionen der Abhängigkeiten.",
    );
    const deps = { correlationId: undefined, answerer, microIndex, nowMs: (): number => 0 };
    const cold = await retrieveConnectedContextPack(input, deps);
    expect(
      cold.pack.files
        .find((file) => file.scopePath === LOCKFILE)
        ?.excerpts.map((excerpt) => excerpt.content)
        .join("\n"),
    ).toContain('"19.3.0"');
    writeFileSync(join(root, LOCKFILE), FILES[LOCKFILE].replaceAll("19.3.0", "19.4.0"));
    const fresh = await retrieveConnectedContextPack(input, deps);
    const content = fresh.pack.files
      .find((file) => file.scopePath === LOCKFILE)
      ?.excerpts.map((excerpt) => excerpt.content)
      .join("\n");
    expect(content).toContain('"19.4.0"');
    expect(content).not.toContain('"19.3.0"');
  });
});
