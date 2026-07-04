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

if (failures.length > 0) {
  console.error("Contract boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Contract boundary check passed.");
