import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { defaultGitProcessRunner } from "@oscharko-dev/keiko-git";
import { nodeWorkspaceFs, type WorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { buildRedactor } from "./deps.js";
import { observedGitRunner } from "./gitProcessActivity.js";
import { fittedGroundedGatewayPrompt } from "./grounded-qa.js";
import {
  retrieveConnectedContextPack,
  type OrchestratorInput,
  type RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";

const TARGET = "packages/keiko-server/src/grounded-answer-assessment.ts";
const SECOND = "src/pumps/reset.ts";
const ORIGINAL =
  `Explain how ${TARGET} separates learned knowledge from source evidence. ` +
  "Cite implementation lines, under 100 words.";
const SOURCE =
  "export function separateEvidence(): string {\n" +
  '  return "learned knowledge is labelled; source evidence requires actual citations";\n' +
  "}\n";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, text: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

async function fixture(git = false): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-named-source-focus-")));
  roots.push(root);
  put(root, TARGET, SOURCE);
  put(root, SECOND, "export const pumpResetDelay = 43; // pump reset delays\n");
  put(
    root,
    "src/caller.ts",
    `import { separateEvidence } from "../${TARGET.replace(/\.ts$/u, ".js")}";\nexport const result = separateEvidence();\n`,
  );
  put(
    root,
    "src/separateEvidence.test.ts",
    "import { separateEvidence } from '../packages/keiko-server/src/grounded-answer-assessment.js';\nexport const testResult = separateEvidence();\n",
  );
  for (let i = 0; i < 20; i += 1)
    put(
      root,
      `src/navigation-${String(i)}.ts`,
      `export const unrelated${String(i)} = "learned knowledge source evidence implementation lines";\n`,
    );
  if (git) await initializeGit(root);
  return root;
}

async function initializeGit(root: string): Promise<void> {
  const runner = observedGitRunner(
    defaultGitProcessRunner,
    createBufferedServerLogSink(),
    undefined,
  );
  for (const args of [
    ["init", "--quiet", "--template="],
    ["add", "--", "."],
    [
      "-c",
      "user.name=Keiko Fixture",
      "-c",
      "user.email=fixture@keiko.invalid",
      "commit",
      "--quiet",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      "fixture",
    ],
  ]) {
    const result = await runner(args, { cwd: root, maxBytes: 65_536, timeoutMs: 3_000 });
    expect(result.exitCode).toBe(0);
  }
}

function input(root: string, text: string, scope?: Partial<SelectedScope>): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "named-source-focus",
      workspaceRoot: root,
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
      connectedAtMs: 1,
      conversationId: undefined,
      ...scope,
    },
    query: {
      kind: "natural-language",
      text,
      caseSensitive: false,
      maxResults: 4096,
      emittedAtMs: 1,
    },
    budget: {
      ...DEFAULT_EXPLORATION_BUDGET,
      modelInputTokensMax: 118_784,
      modelOutputTokensMax: 8192,
      filesReadMax: null,
      elapsedMsMax: null,
    },
  };
}

async function retrieve(
  root: string,
  text: string,
  scope?: Partial<SelectedScope>,
): Promise<{
  readonly result: RetrievalOnlyOutput;
  readonly bodies: readonly string[];
  readonly historyScopes: readonly (readonly string[])[];
  readonly prompt: string;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
}> {
  const bodies: string[] = [];
  const fs = observedNativeReaders(bodies);
  const log = createBufferedServerLogSink();
  const historyScopes: (readonly string[])[] = [];
  const result = await retrieveConnectedContextPack(input(root, text, scope), {
    fs,
    activityLog: log,
    correlationId: "named-source-focus",
    nowMs: () => 1,
    gitFileHistoryEvidence: ({ searchScope }) => {
      historyScopes.push(searchScope.relativePaths);
      return Promise.resolve([]);
    },
    answerer: { answer: () => Promise.reject(new Error("Retrieval must not synthesize")) },
  });
  const fitted = fittedGroundedGatewayPrompt(text, result.pack, buildRedactor({}));
  const prompt = fitted.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");
  expect(result.plan.query.text).toBe(text);
  expect(result.pack.scope).toEqual(input(root, text, scope).scope);
  expect(result.pack.budget).toEqual(input(root, text, scope).budget);
  expect(prompt).toContain(text);
  expect(result.pack.usage.excerptBytes).toBeLessThanOrEqual(result.pack.budget.excerptBytesMax);
  return { result, bodies, historyScopes, prompt, log };
}

function observedNativeReaders(bodies: string[]): WorkspaceFs {
  const {
    readFileUtf8SameDescriptor: read,
    readFileUtf8WithinRootSameDescriptor: within,
    readFileBytes: bytes,
  } = nodeWorkspaceFs;
  if (read === undefined || within === undefined || bytes === undefined)
    throw new Error("Native descriptor readers missing");
  return {
    ...nodeWorkspaceFs,
    readFileUtf8SameDescriptor: (...args): ReturnType<typeof read> => {
      bodies.push(args[0]);
      return read(...args);
    },
    readFileUtf8WithinRootSameDescriptor: (...args): ReturnType<typeof within> => {
      bodies.push(args[1]);
      return within(...args);
    },
    readFileBytes: (...args): ReturnType<typeof bytes> => {
      bodies.push(args[0]);
      return bytes(...args);
    },
  };
}

describe("live-admitted query-named source focus under the original grants", () => {
  it.each([false, true])(
    "focuses the unchanged original source question in Git=%s",
    async (git) => {
      const root = await fixture(git);
      const out = await retrieve(root, ORIGINAL);
      expect(out.result.plan.targetDecision?.definitionRequested).toBe(false);
      expect(out.result.pack.files.map((file) => file.scopePath)).toEqual([TARGET]);
      expect(out.prompt).toContain("source evidence requires actual citations");
      expect(out.prompt).not.toContain("unrelated0");
      expect(out.bodies.filter((path) => path.includes("navigation-"))).toEqual([]);
      expect(
        out.log.events.find((event) => event.op === "search.connected-context.source-details")
          ?.extra,
      ).toMatchObject({ explicitPathAdmittedCount: 1, explicitPathRejectedCount: 0 });
    },
  );

  it.each(["`", '"'])("retains the same complete code target quoted with %s", async (quote) => {
    const root = await fixture();
    const out = await retrieve(
      root,
      `Explain ${quote}${TARGET}${quote}. Cite implementation lines, under 100 words.`,
    );
    expect(out.result.pack.files.map((file) => file.scopePath)).toEqual([TARGET]);
  });

  it("retains both independently named code files without navigation neighbours", async () => {
    const root = await fixture(true);
    const out = await retrieve(root, `Explain ${TARGET} and ${SECOND}. Cite implementation lines.`);
    expect(out.result.pack.files.map((file) => file.scopePath).sort()).toEqual(
      [TARGET, SECOND].sort(),
    );
    expect(out.prompt).toContain("pumpResetDelay = 43");
    expect(out.bodies.filter((path) => path.includes("navigation-"))).toEqual([]);
  });

  it.each(["pump reset delays", '"pump reset delays"'])(
    "keeps independent prose discovery: %s",
    async (topic) => {
      const root = await fixture();
      const out = await retrieve(
        root,
        `Read ${TARGET} and explain ${topic}. Cite implementation lines.`,
      );
      expect(out.result.pack.files.map((file) => file.scopePath)).toContain(SECOND);
      expect(out.prompt).toContain("pumpResetDelay = 43");
    },
  );

  it("keeps an independent topic when the first named file is absent", async () => {
    const root = await fixture();
    const out = await retrieve(root, "Read src/absent.ts and explain pump reset delays.");
    expect(out.result.pack.files.map((file) => file.scopePath)).toContain(SECOND);
  });

  it("keeps an independent request after a comma beside a named file", async () => {
    const root = await fixture();
    const out = await retrieve(
      root,
      `Read ${TARGET}, explain pump reset delays. Cite implementation lines.`,
    );
    expect(out.result.pack.files.map((file) => file.scopePath)).toContain(SECOND);
    expect(out.prompt).toContain("pumpResetDelay = 43");
  });

  it("preserves breadth when the bounded reference projection cannot retain every named path", async () => {
    const root = await fixture(true);
    const paths = Array.from({ length: 7 }, (_, i) => `src/named-${String(i)}.ts`);
    for (const path of paths) put(root, path, "export const actualValue = 37;\n");
    const out = await retrieve(root, `Explain ${paths.join(" ")}. Cite implementation lines.`);
    expect(out.result.plan.references?.length).toBeLessThan(paths.length);
    expect(out.result.pack.diagnostics?.coverage?.filesScanned).toBeGreaterThan(
      out.result.plan.references?.length ?? 0,
    );
  });

  it("preserves real definition discovery beside the complete file target", async () => {
    const root = await fixture(true);
    const out = await retrieve(
      root,
      `Where is separateEvidence defined relative to ${TARGET}? Cite implementation lines.`,
    );
    expect(out.result.plan.targetDecision?.definitionRequested).toBe(true);
    expect(out.historyScopes).toContainEqual([]);
    expect(out.prompt).toContain("source evidence requires actual citations");
  });

  it.each(["callers", "tests", "history"])(
    "preserves requested %s outside the path",
    async (kind) => {
      const root = await fixture(true);
      const out = await retrieve(root, `Explain ${kind} for ${TARGET}. Cite implementation lines.`);
      expect(out.historyScopes).toContainEqual([]);
      if (kind !== "history")
        expect(out.result.pack.files.map((file) => file.scopePath)).toContain(
          kind === "tests" ? "src/separateEvidence.test.ts" : "src/caller.ts",
        );
    },
  );

  it("keeps diagnostic source pairing outside a named file", async () => {
    const root = await fixture();
    const out = await retrieve(
      root,
      `Why does this assertion fail?\nAssertionError: expected 1 to be 2\n    at separateEvidence (${TARGET}:2:1)`,
    );
    expect(out.result.pack.files.map((file) => file.scopePath)).toContain(TARGET);
    expect(out.result.plan.retrievalIntent).toBe("diagnostic-search");
    expect(out.bodies.some((path) => path.includes("navigation-"))).toBe(true);
  });

  it("preserves canonical diagnostic breadth for a named-file failure without pasted frames", async () => {
    const root = await fixture();
    const out = await retrieve(root, `Why does ${TARGET} fail?`);
    expect(out.result.plan.retrievalIntent).toBe("diagnostic-search");
    expect(out.bodies.some((path) => path.includes("navigation-"))).toBe(true);
  });

  it.each(["directory", "files"] as const)(
    "preserves the original %s scope when the target is outside it",
    async (kind) => {
      const root = await fixture();
      const relativePaths = [kind === "directory" ? "src/pumps" : SECOND];
      const out = await retrieve(root, ORIGINAL, { kind, relativePaths });
      expect(out.result.pack.files.some((file) => file.scopePath === TARGET)).toBe(false);
      expect(out.bodies).not.toContain(join(root, TARGET));
    },
  );

  it.each([
    { path: "src/absent.ts", rejected: 1 },
    { path: ".env/private.ts", rejected: 2 },
  ])(
    "keeps a closed admission for $path without substituting neighbours",
    async ({ path, rejected }) => {
      const root = await fixture();
      put(root, ".env/private.ts", "SECRET_FIXTURE_MARKER");
      const out = await retrieve(root, `Explain ${path}. Cite implementation lines.`);
      if (path === ".env/private.ts")
        expect(out.result.plan.references?.map((reference) => reference.path)).toEqual([
          ".env/private.ts",
          ".env/private.ts.",
        ]);
      expect(
        out.log.events.find((event) => event.op === "search.connected-context.source-details")
          ?.extra,
      ).toMatchObject({ explicitPathAdmittedCount: 0, explicitPathRejectedCount: rejected });
      expect(out.result.pack.files).toEqual([]);
      expect(out.bodies).not.toContain(join(root, ".env/private.ts"));
    },
  );

  it("authenticates a fresh late range and rereads a changed named source", async () => {
    const root = await fixture(true);
    put(
      root,
      TARGET,
      `${"// earlier unrelated line\n".repeat(300)}export const evidenceMarker = 937;\n`,
    );
    const first = await retrieve(root, `Explain ${TARGET}:301. Cite implementation lines.`);
    expect(first.prompt).toContain("evidenceMarker = 937");
    expect(
      first.result.pack.files[0]?.excerpts.some(
        (excerpt) => (excerpt.atom.lineRange?.endLine ?? 0) >= 301,
      ),
    ).toBe(true);
    put(root, TARGET, "export const evidenceMarker = 941;\n");
    const second = await retrieve(root, `Explain ${TARGET}:301. Cite implementation lines.`);
    expect(second.prompt).toContain("evidenceMarker = 941");
    expect(second.prompt).not.toContain("evidenceMarker = 937");
    expect(
      second.result.pack.files[0]?.excerpts.every(
        (excerpt) => (excerpt.atom.lineRange?.endLine ?? 0) <= 2,
      ),
    ).toBe(true);
  });
});
