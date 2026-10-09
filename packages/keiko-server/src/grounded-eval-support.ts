// Shared eval support: assemble a fully-typed, minimal `ConnectedContextPack` from just the evidence
// a grounding eval controls (files + uncertainty). Every other pack field is filled with an inert,
// valid default here — once — so the eval harnesses never reach for `as unknown as ConnectedContextPack`
// (which would silently hide a missing or invalid field as the pack contract evolves). The grounding
// checkers under test only read `files[].scopePath`, `excerpts[].atom.lineRange`, `excerpts[].content`,
// `excerpts.length`, and `uncertainty[].kind`; the remaining fields carry deterministic placeholders
// and never influence a score.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { groundedConversationContinuity } from "./grounded-conversation-continuity.js";
import {
  retrieveConnectedContextPack,
  runGroundedExploration,
  type OrchestratorDeps,
  type GroundedAnswerer,
  type OrchestratorOutput,
} from "./grounded-orchestrator.js";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createInMemoryUiStore, type ChatMessage } from "./store/index.js";
import { createRunRegistry } from "./runs.js";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { defaultGitProcessRunner } from "@oscharko-dev/keiko-git";

import type {
  ConnectedContextPack,
  ConnectedFileEntry,
  EvidenceAtom,
  ExplorationBudget,
  ExplorationUsage,
  LineRange,
  RetrievalQuery,
  SelectedScope,
  UncertaintyMarker,
  UncertaintyMarkerKind,
} from "@oscharko-dev/keiko-contracts";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/connected-context";

const EVAL_SCOPE: SelectedScope = {
  schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
  scopeId: "eval-scope",
  workspaceRoot: "/eval",
  kind: "directory",
  relativePaths: [],
  conversationId: undefined,
  connectedAtMs: 0,
  explicitConnection: true,
};

const EVAL_QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "eval",
  caseSensitive: false,
  maxResults: 0,
  emittedAtMs: 0,
};

const EVAL_LIMIT: ExplorationBudget = {
  searchCallsMax: 0,
  filesReadMax: 0,
  excerptBytesMax: 0,
  modelInputTokensMax: 0,
  modelOutputTokensMax: 0,
  elapsedMsMax: 0,
  rerankCallsMax: 0,
};

const EVAL_USAGE: ExplorationUsage = {
  searchCalls: 0,
  filesRead: 0,
  excerptBytes: 0,
  modelInputTokens: 0,
  modelOutputTokens: 0,
  elapsedMs: 0,
  rerankCalls: 0,
};

// A complete evidence atom for the given path/line window; every non-evidence field is a fixed,
// valid placeholder (the checkers under test never read them).
export function evalEvidenceAtom(
  scopePath: string,
  lineRange: LineRange | undefined,
): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: `eval:${scopePath}`,
    scopePath,
    lineRange,
    score: 1,
    provenance: { kind: "excerpt-read", tool: "eval", queryFingerprint: "eval" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

export interface EvalExcerptInput {
  readonly content: string;
  readonly lineRange?: LineRange | undefined;
}

// A file entry carrying the fixture's excerpts, with the required role/selectionReason filled in.
export function evalFileEntry(
  scopePath: string,
  excerpts: readonly EvalExcerptInput[],
): ConnectedFileEntry {
  return {
    scopePath,
    role: "read-only",
    selectionReason: "eval-fixture",
    excerpts: excerpts.map((excerpt) => ({
      atom: evalEvidenceAtom(scopePath, excerpt.lineRange),
      content: excerpt.content,
      contentBytes: excerpt.content.length,
    })),
  };
}

// A complete uncertainty marker of the given kind (claim/atom-ids/timestamp are inert placeholders).
export function evalUncertainty(kind: UncertaintyMarkerKind): UncertaintyMarker {
  return { kind, claim: "eval", impactedAtomIds: [], emittedAtMs: 0 };
}

// Assemble a fully-typed pack from the fixture's files + uncertainty; no cast, no hidden field.
export function buildEvalContextPack(
  files: readonly ConnectedFileEntry[],
  uncertainty: readonly UncertaintyMarker[] = [],
): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "eval-pack",
    scope: EVAL_SCOPE,
    query: EVAL_QUERY,
    budget: EVAL_LIMIT,
    usage: EVAL_USAGE,
    files,
    omitted: [],
    uncertainty,
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

/** The incident gate drives the real conversation and retrieval composition, with fixture-owned IO. */
export interface ConnectedRetrievalEvalInput {
  readonly answerer?: GroundedAnswerer | undefined;
  readonly budget?: ExplorationBudget | undefined;
  readonly files: Readonly<Record<string, string>>;
  readonly query: string;
  readonly history?: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly correlationId?: string;
  readonly activityLog?: ServerLogSink;
  readonly answer?: string;
  readonly detectWorkspace?: OrchestratorDeps["detectWorkspace"];
}

function connectedEvalRuntime(): UiHandlerDeps {
  const store = createInMemoryUiStore();
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
  };
}

function evalChatMessage(
  deps: UiHandlerDeps,
  chatId: string,
  role: "user" | "assistant",
  content: string,
  timestamp: number,
): ChatMessage {
  return deps.store.createMessage({
    chatId,
    role,
    content,
    timestamp,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
}

async function materializeConnectedFixture(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const gitFixture = files[".git/HEAD"] !== undefined;
  for (const [path, content] of Object.entries(files)) {
    if (gitFixture && path.startsWith(".git/")) continue;
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  if (gitFixture) await initializeConnectedFixtureRepository(root);
}

async function initializeConnectedFixtureRepository(root: string): Promise<void> {
  const commands = [
    ["init", "--quiet", "--initial-branch=fixture", "--template="],
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
      "--allow-empty",
      "-m",
      "Connected retrieval fixture baseline",
    ],
  ];
  for (const args of commands) {
    const result = await defaultGitProcessRunner(args, {
      cwd: root,
      maxBytes: 65_536,
      timeoutMs: 3_000,
    });
    if (result.exitCode !== 0 || result.truncated)
      throw new Error("Connected retrieval fixture Git initialization failed");
  }
}

/** No private continuity formula is copied into the gate; every history resolves through its owner. */
export async function runConnectedRetrievalEval(
  fixture: ConnectedRetrievalEvalInput,
): Promise<{
  readonly pack: ConnectedContextPack;
  readonly retrievalContent: string;
  readonly answer?: OrchestratorOutput;
}> {
  const root = mkdtempSync(join(tmpdir(), "keiko-connected-retrieval-eval-"));
  const deps = connectedEvalRuntime();
  try {
    await materializeConnectedFixture(root, fixture.files);
    deps.store.createProject(root, "Connected retrieval fixture");
    const chat = deps.store.createChat(root, "Connected retrieval fixture", "fixture");
    let timestamp = 1_700_000_000_000;
    for (const message of fixture.history ?? [])
      evalChatMessage(deps, chat.id, message.role, message.content, timestamp++);
    const user = evalChatMessage(deps, chat.id, "user", fixture.query, timestamp);
    const continuity = groundedConversationContinuity(deps, user, "fixture", fixture.correlationId);
    const input = {
      scope: {
        ...EVAL_SCOPE,
        scopeId: "incident-retrieval-miss",
        workspaceRoot: root,
        kind: "workspace-root" as const,
        conversationId: user.chatId,
      },
      query: { ...EVAL_QUERY, text: continuity.retrievalContent, maxResults: 100 },
      currentQuestion: fixture.query,
      ...(fixture.budget === undefined ? {} : { budget: fixture.budget }),
      assistantReferents: continuity.assistantReferents,
      continuityReferentSource: continuity.continuityReferentSource,
      ...(continuity.previousRetrievalIntent === undefined
        ? {}
        : { previousRetrievalIntent: continuity.previousRetrievalIntent }),
      workspaceRoot: root,
    };
    const retrievalDeps = {
      correlationId: fixture.correlationId,
      activityLog: fixture.activityLog,
      ...(fixture.detectWorkspace === undefined
        ? {}
        : { detectWorkspace: fixture.detectWorkspace }),
      answerer: fixture.answerer ?? {
        answer: (): Promise<string> => Promise.resolve(fixture.answer ?? ""),
      },
    };
    const result =
      fixture.answer === undefined && fixture.answerer === undefined
        ? await retrieveConnectedContextPack(input, retrievalDeps)
        : await runGroundedExploration(input, retrievalDeps);
    return {
      pack: result.pack,
      retrievalContent: continuity.retrievalContent,
      ...("assistantContent" in result ? { answer: result } : {}),
    };
  } finally {
    deps.store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
