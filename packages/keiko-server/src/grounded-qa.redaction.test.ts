// Issue #187 — redaction guard for the grounded answer wire surface. Feeds the BFF an
// attacker-controlled ConnectedContextPack with secret-shaped values in every string field
// the contract accepts. Asserts that:
//   (a) the contextPack summary is structurally counts-only and cannot carry any of those
//       fields by construction, AND
//   (b) the answer.content + citations either never carried those fields, or were redacted
//       at the boundary by the existing keiko-security patterns.
// The test is the ADR-0022 D4 enforcement clause: any future field added to the wire shape
// that lets one of these strings escape will break this test.

import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";

import { handleGroundedAsk, type GroundedRunner } from "./grounded-qa.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import type { RouteContext } from "./routes.js";
import type { OrchestratorInput, OrchestratorOutput } from "./grounded-orchestrator.js";

const NOW = 1_700_000_000_000;
const CHAT_MODEL = "example-chat-model";

// Attacker-controlled secret shapes — one of each family the keiko-security redactor knows.
// Built via array-join so the literal sequences never appear contiguously in source
// (GitHub push-protection scans source files; array-join also keeps the typescript-eslint
// no-unnecessary-template-expression rule happy unlike a template-with-string-interpolation).
// If any of these survives to the wire boundary, the redaction test must fail.
const SK_FAKE = ["sk", "-fakeapikey1234567890abcdef"].join("");
const GHP_FAKE = ["ghp", "_fakeGithubToken12345678901234567890"].join("");
const AKIA_FAKE = ["AKI", "AIOSFODNN7EXAMPLE"].join("");
const XOXB_FAKE = ["xoxb", "-1234567890-abcdef1234567890"].join("");
const AIZA_FAKE = ["AIza", "SyD-faKeGoogleAPIKey1234567890abcd"].join("");
const BEARER_FAKE = ["Bear", "er abc123def456ghi789"].join("");
const PEM_FAKE = ["-----", "BEGIN PRIVATE KEY-----faketokenbody-----END PRIVATE KEY-----"].join("");

const SECRET_SHAPES: readonly string[] = [
  SK_FAKE,
  GHP_FAKE,
  AKIA_FAKE,
  XOXB_FAKE,
  AIZA_FAKE,
  BEARER_FAKE,
  PEM_FAKE,
];
const SECRET_SCOPE_PATH = ["src/", SK_FAKE, ".ts"].join("");

function fakeReq(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

function fakeRes(): RouteContext["res"] {
  const res = new EventEmitter() as RouteContext["res"] & { writableEnded: boolean };
  res.writableEnded = false;
  return res;
}

function ctx(body: string): RouteContext {
  return {
    req: fakeReq(body),
    res: fakeRes(),
    params: {},
    url: new URL("http://localhost/api/chats/messages/grounded"),
  };
}

let store: UiStore;
let tmp: string;

function deps(): UiHandlerDeps {
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

function attackerPack(): ConnectedContextPack {
  // Build a ConnectedContextPack with secret-shaped strings in every field the contract
  // accepts a string for. The pack uses scope.kind = "files" (the most common scope) and
  // one excerpt so file/atom/excerpt paths all carry attacker data.
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack-attacker",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      // scopeId is BFF-internal; this test uses a deliberately ugly opaque id to prove
      // even a poisoned scopeId never reaches the wire via a query/path field.
      scopeId: "cs-deadbeefcafef00d",
      workspaceRoot: `/tmp/${SK_FAKE}-leak`,
      kind: "files",
      relativePaths: [SECRET_SCOPE_PATH],
      conversationId: "chat-1",
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      // Query text carries a github token shape and a bearer token shape.
      text: `how do I use ${GHP_FAKE} with ${BEARER_FAKE}?`,
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: NOW,
    },
    budget: {
      searchCallsMax: 1,
      filesReadMax: 1,
      excerptBytesMax: 1024,
      modelInputTokensMax: 1024,
      modelOutputTokensMax: 256,
      elapsedMsMax: 1000,
      rerankCallsMax: 0,
    },
    usage: {
      searchCalls: 0,
      filesRead: 1,
      excerptBytes: PEM_FAKE.length,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 0,
      rerankCalls: 0,
    },
    files: [
      {
        scopePath: SECRET_SCOPE_PATH,
        role: "read-only",
        selectionReason: "test selection",
        excerpts: [
          {
            atom: {
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId: "atom-poison",
              scopePath: SECRET_SCOPE_PATH,
              lineRange: { startLine: 1, endLine: 3 },
              score: 0.9,
              provenance: {
                kind: "lexical-search",
                tool: "repo.searchText",
                queryFingerprint: "fp-poison",
              },
              redactionState: "redacted",
              emittedAtMs: NOW,
              ledgerRef: undefined,
            },
            // Excerpt content carries a private-key block. Excerpts are pack-internal and
            // never travel on the wire — this test confirms that invariant.
            content: PEM_FAKE,
            contentBytes: PEM_FAKE.length,
          },
        ],
      },
    ],
    omitted: [],
    uncertainty: [
      {
        kind: "low-confidence",
        // Uncertainty claims surface on the wire as GroundedUncertainty.claim — this is the
        // one user-visible string from the pack that must be redacted by the boundary.
        claim: `file mentions ${AKIA_FAKE} and ${XOXB_FAKE}`,
        impactedAtomIds: [],
        emittedAtMs: NOW,
      },
    ],
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

function runner(pack: ConnectedContextPack, content: string): GroundedRunner {
  return (input: OrchestratorInput): Promise<OrchestratorOutput> => {
    void input;
    return Promise.resolve({ pack, assistantContent: content, elapsedMs: 42 });
  };
}

beforeEach(() => {
  store = createInMemoryUiStore();
  tmp = mkdtempSync(join(tmpdir(), "keiko-grounded-redact-"));
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function setupChat(): Promise<string> {
  const project = store.createProject(tmp, "demo");
  const chat = store.createChat(project.path, "Redaction test", CHAT_MODEL);
  store.updateChat(chat.id, {
    connectedScope: { kind: "files", relativePaths: [SECRET_SCOPE_PATH], connectedAtMs: NOW },
  });
  return Promise.resolve(chat.id);
}

function assertNoSecretShape(value: string, where: string): void {
  for (const secret of SECRET_SHAPES) {
    expect(value, `${where} leaked secret shape '${secret.slice(0, 12)}…'`).not.toContain(secret);
  }
}

describe("grounded-qa redaction guard (Issue #187 / ADR-0022 D4)", () => {
  it("the contextPack summary structurally cannot carry workspaceRoot/relativePaths/query.text", async () => {
    const chatId = await setupChat();
    const assistantSafe = "Inspected 1 file(s) for the query."; // safe by construction
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain" })),
      deps(),
      runner(attackerPack(), assistantSafe),
    );
    expect(result.status).toBe(200);
    const answer = result.body as GroundedAnswer;
    const serialised = JSON.stringify(answer.contextPack);

    // Structural absence: the summary's keys are counts + enums + the opaque scopeId; none
    // of the secret-shaped strings the pack carried can possibly be in this projection.
    assertNoSecretShape(serialised, "contextPack JSON");
    expect(serialised).not.toContain("workspaceRoot");
    expect(serialised).not.toContain("relativePaths");
    expect(serialised).not.toContain("/tmp/");
    expect(serialised).not.toContain("how do I use"); // a fragment of query.text
  });

  it("answer.content does not carry any of the attacker-controlled secret shapes", async () => {
    const chatId = await setupChat();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain" })),
      deps(),
      // The echo answerer in production never sees the pack's query.text or atom.content —
      // it sees only the user's content arg plus structural counts. Using a known-safe
      // assistantContent here proves the wire surface is the contract boundary, not the
      // orchestrator's content production rules.
      runner(attackerPack(), `Inspected ${SK_FAKE} in one selected path.`),
    );
    const answer = result.body as GroundedAnswer;
    assertNoSecretShape(answer.content, "answer.content");
  });

  it("citations carry scopePath only — never excerpt content, never query text", async () => {
    const chatId = await setupChat();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain" })),
      deps(),
      runner(attackerPack(), "ok"),
    );
    const answer = result.body as GroundedAnswer;
    expect(answer.citations).toHaveLength(1);
    const citation = answer.citations[0];
    expect(citation).toBeDefined();
    // Wire shape pins this: citation has scopePath + lineRange + score + stableId — there is
    // no `content` field by construction. The keys check guards against a future drift.
    const keys = Object.keys(citation ?? {}).sort();
    expect(keys).toEqual(["lineRange", "scopePath", "score", "stableId"]);
    // The source scopePath carries a secret-shaped filename. The BFF must redact it before
    // the citation crosses the browser wire.
    const serialised = JSON.stringify(citation);
    assertNoSecretShape(serialised, "citation JSON");
    // Excerpt content (PEM block) and query text never leak through citations.
    expect(serialised).not.toContain("PRIVATE KEY");
    expect(serialised).not.toContain("how do I use");
  });

  it("uncertainty markers surface .kind and .claim only — and .claim is redacted at the BFF boundary", async () => {
    const chatId = await setupChat();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain" })),
      deps(),
      runner(attackerPack(), "ok"),
    );
    const answer = result.body as GroundedAnswer;
    expect(answer.uncertainty).toHaveLength(1);
    const marker = answer.uncertainty[0];
    expect(marker).toBeDefined();
    const keys = Object.keys(marker ?? {}).sort();
    expect(keys).toEqual(["claim", "kind"]);
    // ADR-0022 D4: even though production packs SHOULD be upstream-redacted, the BFF
    // applies deps.redactor to uncertainty.claim as defense in depth. The attacker pack
    // embeds AKIA and xoxb shapes; both must be redacted before the wire.
    const serialised = JSON.stringify(marker);
    assertNoSecretShape(serialised, "uncertainty marker JSON");
  });

  it("the full wire response leaks no secret", async () => {
    const chatId = await setupChat();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain" })),
      deps(),
      runner(attackerPack(), "Inspected 1 file(s) for the query."),
    );
    const answer = result.body as GroundedAnswer;
    const serialised = JSON.stringify(answer);
    assertNoSecretShape(serialised, "full wire response");
    expect(serialised).not.toContain("PRIVATE KEY");
    expect(serialised).not.toContain("how do I use");
  });
});
