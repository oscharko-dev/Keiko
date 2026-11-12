// #4206: a routine private fact is in use at once, in every mode, with nobody asked to approve it.
// Hard denials stay first, confidential content and personal identifiers are refused, an explicit
// operator restriction still holds facts for review, and every decision reaches the Journal and
// the Activity Log body-free. Real vault, real evidence ledger, scripted model.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingWorkbenchMode, NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import type {
  ConversationId,
  MemoryRecord,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { captureSalientFromTurn } from "./memory-salience.js";
import {
  conversationMemoryScopes,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import {
  projectMemoryCaptureDecisions,
  replayMemoryCaptureAuditLedger,
  type MemoryCaptureDecision,
} from "./memory-capture-projection.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";

const MODES: readonly CodingWorkbenchMode[] = [
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
];

const temporaryDirectories: string[] = [];
const vaults: MemoryVaultStore[] = [];

afterEach(() => {
  resetServerLogger();
  for (const vault of vaults.splice(0)) vault.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function directory(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporaryDirectories.push(path);
  return path;
}

// The scripted model proposes the person's own sentence as a fact, so the product decides.
function proposing(sentence: string): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      return Promise.resolve({
        modelId: request.modelId,
        content: JSON.stringify([
          { about: "self", body: sentence, evidence: sentence, type: "fact" },
        ]),
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "approval-free",
          promptTokens: 7,
          completionTokens: 3,
          latencyMs: 1,
          costClass: "high",
        },
      });
    },
  };
}

interface Fixture {
  readonly deps: UiHandlerDeps;
  readonly vault: MemoryVaultStore;
  readonly context: ConversationMemoryRuntimeContext;
}

function fixture(sentence: string, overrides: Partial<UiHandlerDeps> = {}): Fixture {
  const vault = createMemoryVault({
    memoryDir: directory("keiko-approval-free-"),
    redactString: (value) => value,
  });
  vaults.push(vault);
  const project = directory("keiko-approval-free-project-");
  const deps: UiHandlerDeps = {
    config: undefined,
    configPresent: false,
    evidenceStore: createInMemoryEvidenceStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => proposing(sentence),
    store: createInMemoryUiStore(),
    memoryVault: vault,
    // An operator ceiling of Full access lets each requested mode take effect, so every mode below
    // is the mode the learner actually ran in rather than a clamp to Ask for approval.
    memoryDeploymentCeiling: "autonomous-delivery",
    memoryDeploymentCeilingConfigured: true,
    ...overrides,
  };
  return {
    deps,
    vault,
    context: {
      userId: "local-operator" as UserId,
      workspaceId: project as WorkspaceId,
      projectId: project as ProjectId,
      conversationId: "chat-approval-free" as ConversationId,
    },
  };
}

async function learn(
  { deps, context }: Fixture,
  sentence: string,
  mode: CodingWorkbenchMode,
): Promise<void> {
  await captureSalientFromTurn(
    deps,
    { content: sentence, memory: { enabled: true, mode } },
    context,
    "gpt-test",
    "Noted.",
  );
}

// The registered decision line a capture writes beside its Journal entry (#4206).
function decisionLine(sink: ReturnType<typeof createBufferedServerLogSink>): unknown {
  const lines = sink.events.filter(({ op }) => op === "memory.capture.decision");
  expect(lines).toHaveLength(1);
  const [line] = lines;
  if (line === undefined) throw new Error("expected a memory.capture.decision line");
  return expectActivityLogProof("memory.capture.decision.line", formatActivityLogProofLine(line));
}

function stored({ vault, context }: Fixture): readonly MemoryRecord[] {
  return conversationMemoryScopes(context).flatMap((scope) => vault.listMemoriesByScope(scope));
}

function journal({ deps, vault, context }: Fixture): readonly MemoryCaptureDecision[] {
  const scopes = conversationMemoryScopes(context);
  return projectMemoryCaptureDecisions(replayMemoryCaptureAuditLedger(deps.evidenceStore, 0), {
    since: 0,
    order: "desc",
    authorizedScopes: scopes,
    liveRecords: scopes.flatMap((scope) => vault.listMemoriesByScope(scope)),
  });
}

describe("a routine fact needs no approval (#4206)", () => {
  it.each(MODES)("is accepted at once in %s and shown as accepted in the Journal", async (mode) => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const sentence = "I keep my release notes in the team wiki.";
    const learner = fixture(sentence);
    await learn(learner, sentence, mode);
    expect(decisionLine(sink)).toMatchObject({
      outcome: "auto-accepted",
      reason: "governance-auto-accepted",
      mode,
      surface: "conversation-center",
      scopeKind: "user",
      sourceKind: "system-default",
    });
    const [record] = stored(learner);
    expect(record?.status).toBe("accepted");
    expect(journal(learner)).toEqual([
      expect.objectContaining({
        outcome: "auto-accepted",
        mode,
        reason: "governance-auto-accepted",
        memoryId: String(record?.id),
        currentStatus: "accepted",
      }),
    ]);
  });

  it.each([
    ["an explicit governed-assist ceiling", { memoryDeploymentCeiling: "governed-assist" }],
    [
      "a configured production ceiling",
      { memoryDeploymentCeiling: "governed-assist", memoryDeploymentCeilingConfigured: true },
    ],
  ] as const)("is held for review under %s, whatever the mode", async (_label, ceiling) => {
    for (const mode of MODES) {
      const sentence = "I keep my release notes in the team wiki.";
      const learner = fixture(sentence, ceiling);
      await learn(learner, sentence, mode);
      expect(stored(learner).map(({ status }) => status)).toEqual(["proposed"]);
      expect(journal(learner)).toEqual([
        expect.objectContaining({ outcome: "proposed", reason: "operator-requires-approval" }),
      ]);
    }
  });

  // #4206 audit: a calendar date read as a telephone number, so a fact with an end date was refused
  // as confidential once no review step was left.
  it("accepts a fact with an end date and keeps the date", async () => {
    const sentence = "Ich arbeite bei Acme bis 31.12.2027.";
    const learner = fixture(sentence);
    await learn(learner, sentence, "governed-assist");
    const [record] = stored(learner);
    expect(record?.status).toBe("accepted");
    expect(new Date(record?.validity.validUntil ?? 0).getFullYear()).toBe(2027);
  });

  it("is accepted under the production default, which names no configured ceiling", async () => {
    const sentence = "I keep my release notes in the team wiki.";
    const learner = fixture(sentence, {
      memoryDeploymentCeiling: "governed-assist",
      memoryDeploymentCeilingConfigured: false,
    });
    await learn(learner, sentence, "governed-assist");
    expect(stored(learner).map(({ status }) => status)).toEqual(["accepted"]);
  });
});

const RANDOM_IDENTIFIER_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?=\d*[a-f])[0-9a-f]{12,}\b/gu;

function withoutRandomIdentifiers(evidence: string): string {
  return evidence.replace(RANDOM_IDENTIFIER_RE, "<id>");
}

describe("refusals are mode-independent and visible (#4206)", () => {
  const refusals = [
    [
      "confidential content",
      "I am reachable at m1.fixture@example.com.",
      "sensitive-memory-requires-approval",
    ],
    ["an IBAN", "I pay from DE89 3704 0044 0532 0130 00.", "personal-identifier"],
    ["a phone number", "I am reachable on +49 30 1234 5678.", "personal-identifier"],
    ["a customer number", "I am customer Kundennummer 4711-0815.", "personal-identifier"],
    ["a customer name", "My customer prefers fixture tables.", "denied-category"],
    ["a protected topic", "I take my fixture medication every day.", "denied-category"],
  ] as const;

  it.each(refusals)(
    "refuses %s in every mode and records why, body-free",
    async (_label, sentence, reason) => {
      for (const mode of MODES) {
        const sink = createBufferedServerLogSink();
        setServerLogger(createServerLogger({ sink, level: "info" }));
        const learner = fixture(sentence);
        await learn(learner, sentence, mode);
        expect(stored(learner)).toEqual([]);
        const entries = journal(learner);
        expect(entries).toEqual([expect.objectContaining({ outcome: "rejected", mode, reason })]);
        expect(entries[0]).not.toHaveProperty("memoryId");
        const ledger = JSON.stringify(
          replayMemoryCaptureAuditLedger(learner.deps.evidenceStore, 0),
        );
        const lines = JSON.stringify(sink.events);
        for (const evidence of [ledger, lines]) {
          expect(evidence).not.toContain(sentence);
          // Random event ids and hex digests may spell "4711" by chance ("…-475782484711"); they
          // carry no content, so only the evidence without them is searched for the refused words.
          // A run of digits alone is never treated as an id.
          expect(withoutRandomIdentifiers(evidence)).not.toMatch(
            /example\.com|DE89|4711|1234 5678|medication/u,
          );
        }
        expect(decisionLine(sink)).toMatchObject({
          outcome: "rejected",
          reason,
          mode,
          surface: "conversation-center",
          scopeKind: "user",
          sourceKind: "system-default",
        });
      }
    },
  );
});

describe("existing proposals stay as they are (#4206)", () => {
  it("does not accept a record proposed before this change when a new fact is learned", async () => {
    const sentence = "I keep my release notes in the team wiki.";
    const learner = fixture(sentence);
    const [scope] = conversationMemoryScopes(learner.context);
    if (scope === undefined) throw new Error("expected a conversation scope");
    const now = Date.now();
    const earlier = learner.vault.insertMemory({
      id: "proposed-before-4206" as MemoryRecord["id"],
      schemaVersion: "1",
      scope,
      type: "semantic-fact",
      body: "I review pull requests every morning.",
      provenance: {
        sourceKind: "system-default",
        capturedAt: now,
        confidence: 0.9,
        sensitivity: "public",
      },
      validity: { validFrom: now },
      status: "proposed",
      pinned: false,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    await learn(learner, sentence, "autonomous-delivery");
    expect(learner.vault.getMemory(earlier.id)?.status).toBe("proposed");
  });
});
