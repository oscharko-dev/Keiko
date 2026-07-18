#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

const checks = [
  {
    file: "packages/keiko-ui/src/lib/api.ts",
    rules: [
      {
        pattern: /export\s+interface\s+SendDesktopChatInput\b/,
        message: "SendDesktopChatInput must alias DesktopChatSendRequestWire from contracts.",
      },
      {
        pattern: /interface\s+Sse(?:Token|Done|Error)Payload\b/,
        message: "Desktop chat SSE payloads must be owned by DesktopChatStreamEvent.",
      },
      {
        pattern: /function\s+asSse(?:Token|Done|Error)Payload\b/,
        message: "Desktop chat SSE narrowing must use isDesktopChatStreamEvent from contracts.",
      },
      {
        pattern: /eventName:\s*string\s*\|\s*undefined/,
        message:
          "Desktop chat SSE event names must normalize through DESKTOP_CHAT_STREAM_EVENT_TYPES.",
      },
      {
        pattern:
          /export\s+(?:interface\s+ManagedLsp(?:ConfigurationSummary|SettingsResponse|SettingsMutationInput)\b|type\s+ManagedLspSettingsAction\s*=\s*["'])/,
        message: "Managed LSP UI envelopes must alias contracts-owned route types.",
      },
      {
        // Issue #2489 (Finding 7) — the 14-member EditorAgentActionType union has one owner:
        // packages/keiko-contracts/src/editor-agent.ts. A local string-literal redeclaration here
        // (instead of importing the type) is exactly how the Desktop chat / Managed LSP wire drift
        // this script otherwise catches would recur for the editor-agent action wire.
        pattern: /export\s+type\s+EditorAgentActionType\s*=\s*["']/,
        message: "Editor-agent action types must alias EditorAgentActionType from contracts.",
      },
      {
        // Issue #2489 (Finding 7) — editor-verification wire shapes (editor-agent-verification.ts)
        // must not be re-declared locally.
        pattern: /export\s+(?:interface|type)\s+EditorAgentVerification(?:Result|RunRequest)\b/,
        message: "Editor-agent verification shapes must alias editor-agent-verification.ts types.",
      },
      {
        // Issue #2489 (Finding 7) — editor-agent-governance.ts's effect-class/Workbench-class maps
        // are the single source of authority-gating truth; a local copy could silently drift from
        // the server-enforced classification (agentRoutes.ts/agentVerificationRoute.ts).
        pattern: /export\s+const\s+EDITOR_AGENT_(?:ACTION_EFFECT_CLASS|WORKBENCH_ACTION_CLASS)\b/,
        message:
          "Editor-agent governance classification maps must alias editor-agent-governance.ts.",
      },
    ],
  },
  {
    file: "packages/keiko-server/src/editor/lsp/managedLspControl.ts",
    rules: [
      {
        pattern:
          /export\s+(?:interface\s+ManagedLsp(?:ControlMutation|ControlSnapshot|ConfigurationSummary)\b|type\s+ManagedLspControl(?:Action|Result)\s*=)/,
        message: "Managed LSP server control envelopes must be owned by keiko-contracts.",
      },
    ],
  },
  {
    file: "packages/keiko-server/src/editor/lsp/managedLspRoutes.ts",
    rules: [
      {
        pattern: /(?:interface\s+ParsedMutationBody\b|function\s+parseMutationBody\b)/,
        message: "Managed LSP routes must use the contracts-owned control request parser.",
      },
    ],
  },
  {
    file: "packages/keiko-server/src/chat-stream-handlers.ts",
    rules: [
      {
        pattern: /function\s+sseMessage\s*\(\s*event:\s*string\b/,
        message: "Server chat SSE events must use DesktopChatStreamEvent, not raw strings.",
      },
    ],
  },
  {
    file: "packages/keiko-server/src/chat-handlers.ts",
    rules: [
      {
        pattern: /new\s+AbortController\s*\(\s*\)\.signal/,
        message: "Buffered chat model calls must use the client disconnect AbortSignal.",
      },
    ],
  },
  {
    file: "packages/keiko-ui/src/lib/quality-intelligence-api.ts",
    rules: [
      {
        pattern: /export\s+type\s+QiReviewAction\s*=\s*"approve"/,
        message: "QI review actions must alias QualityIntelligenceReviewAction from contracts.",
      },
    ],
  },
  {
    file: "packages/keiko-ui/src/app/components/desktop/widgets/quality-intelligence/CandidatesPane.tsx",
    rules: [
      {
        pattern: /export\s+type\s+QiReviewAction\s*=\s*"approve"/,
        message:
          "QI widget review actions must alias QualityIntelligenceReviewAction from contracts.",
      },
    ],
  },
  {
    file: "packages/keiko-server/src/qualityIntelligence/reviewStore.ts",
    rules: [
      {
        pattern: /export\s+type\s+QiReviewAction\s*=\s*"approve"/,
        message:
          "QI server review actions must alias QualityIntelligenceReviewAction from contracts.",
      },
    ],
  },
  {
    file: "packages/keiko-ui/src/lib/memory-api.ts",
    rules: [
      {
        pattern:
          /export\s+interface\s+MemoryConsolidation(?:Result|ReviewItem|Job|JobEnvelope|JobResponse)\b/,
        message: "Memory consolidation response shapes must alias contracts-owned wire types.",
      },
      {
        pattern: /export\s+type\s+MemoryConsolidationJobState\s*=\s*"queued"/,
        message: "Memory consolidation lifecycle vocabulary must alias contracts-owned wire types.",
      },
    ],
  },
];

const failures = [];

for (const check of checks) {
  const filePath = resolve(root, check.file);
  const source = readFileSync(filePath, "utf8");
  for (const rule of check.rules) {
    if (rule.pattern.test(source)) {
      failures.push(`${check.file}: ${rule.message}`);
    }
  }
}

// Issue #2489 (Finding 8) — EDITOR_AGENT_SCHEMA_VERSION and EDITOR_VERIFICATION_SCHEMA_VERSION are
// deliberately two independent "ladders" (docs/keiko-editor/2088-foundation-wave-audit.md,
// Deliberate exclusions), but they must not silently drift apart while both are pinned at "1".
function schemaVersionLiteral(file, constantName) {
  const source = readFileSync(resolve(root, file), "utf8");
  const match = new RegExp(`export const ${constantName} = "([^"]+)" as const;`).exec(source);
  if (match === null) {
    failures.push(`${file}: could not find ${constantName} to check schema-version lockstep.`);
    return null;
  }
  return match[1];
}

const editorAgentSchemaVersion = schemaVersionLiteral(
  "packages/keiko-contracts/src/editor-agent.ts",
  "EDITOR_AGENT_SCHEMA_VERSION",
);
const editorVerificationSchemaVersion = schemaVersionLiteral(
  "packages/keiko-contracts/src/editor-verification.ts",
  "EDITOR_VERIFICATION_SCHEMA_VERSION",
);
if (
  editorAgentSchemaVersion !== null &&
  editorVerificationSchemaVersion !== null &&
  editorAgentSchemaVersion !== editorVerificationSchemaVersion
) {
  failures.push(
    `EDITOR_AGENT_SCHEMA_VERSION ("${editorAgentSchemaVersion}") and ` +
      `EDITOR_VERIFICATION_SCHEMA_VERSION ("${editorVerificationSchemaVersion}") have drifted out ` +
      "of lockstep.",
  );
}

if (failures.length > 0) {
  console.error("Contract boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Contract boundary check passed.");
