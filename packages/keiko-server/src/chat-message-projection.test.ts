import { afterEach, expect, it } from "vitest";
import type { ChatMessage } from "@oscharko-dev/keiko-contracts/bff-wire";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { browserChatMessages } from "./chat-message-projection.js";

afterEach(resetServerLogger);

it("omits private document metadata from browser rows while preserving stored prompt history", () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const message: ChatMessage = {
    id: "message",
    chatId: "chat",
    role: "user",
    content: "Visible draft",
    timestamp: 1,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
    documentContext: [
      {
        id: "document",
        displayName: "private-name.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        extractedBytes: 12,
        truncated: false,
        text: "PRIVATE DOCUMENT BODY",
      },
    ],
  };
  const [visible] = browserChatMessages([message], "projection-proof");
  expect(visible).toEqual({
    id: "message",
    chatId: "chat",
    role: "user",
    content: "Visible draft",
    timestamp: 1,
  });
  expect(message.documentContext?.[0]?.text).toBe("PRIVATE DOCUMENT BODY");
  const line = formatActivityLogProofLine(sink.events[0] ?? {});
  expect(expectActivityLogProof("chat.messages.projected.document-context", line)).toMatchObject({
    messageCount: 1,
    omittedDocumentCount: 1,
  });
  expect(line).not.toContain("PRIVATE");
  expect(line).not.toContain("private-name");
  sink.events.splice(0);
  expect(browserChatMessages([])).toEqual([]);
  expect(browserChatMessages([visible ?? message])[0]).toBe(visible);
  expect(sink.events).toHaveLength(0);
});

it("records how an index-lifecycle refresh obtained its capsule stamps, as a closed word and a count", () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const plain: ChatMessage = {
    id: "m",
    chatId: "c",
    role: "assistant",
    content: "Answer",
    timestamp: 1,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
  browserChatMessages([plain], "refresh-proof", { stampMemo: "hit", capsuleCount: 2 });
  const line = formatActivityLogProofLine(sink.events[0] ?? {});
  expect(expectActivityLogProof("chat.messages.projected.document-context", line)).toMatchObject({
    op: "chat.messages.projected",
    correlationId: "refresh-proof",
    messageCount: 1,
    omittedDocumentCount: 0,
    stampMemo: "hit",
    capsuleCount: 2,
  });
});
