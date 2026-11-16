import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Chat, ChatMessage, ProjectWithAvailability } from "@/lib/types";
import { fetchEvidenceManifest, fetchRunReport, patchChatMessage } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { prepareCanonicalVoiceHasher } from "./canonical-voice-hasher";
import { useChatSession } from "./useChatSession";

const summaryModule = vi.hoisted(() => ({ loads: 0 }));
vi.mock("@/lib/run-summary", () => {
  summaryModule.loads += 1;
  throw new TypeError("SYNTHETIC_MODULE_LOAD_DETAIL");
});

const project: ProjectWithAvailability = {
  path: "/synthetic",
  name: "Synthetic",
  favorite: false,
  createdAt: 1,
  lastOpenedAt: 1,
  available: true,
};
const chat: Chat = {
  id: "synthetic-chat",
  projectPath: project.path,
  title: "Synthetic chat",
  selectedModel: "synthetic-model",
  branchLabel: undefined,
  status: "open",
  connectedScope: undefined,
  localKnowledgeScope: undefined,
  createdAt: 1,
  updatedAt: 1,
};
const pendingSummary: ChatMessage = {
  id: "synthetic-summary",
  chatId: chat.id,
  role: "system",
  content: "Synthetic pending run",
  timestamp: 1,
  runId: "synthetic-run",
  workflowId: undefined,
  workflowStatus: "running",
  shortResult: undefined,
  taskType: undefined,
};

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchModels: vi.fn(async () => ({ models: [] })),
  fetchProjects: vi.fn(async () => ({ projects: [project] })),
  fetchChats: vi.fn(async () => ({ chats: [chat] })),
  fetchChatMessages: vi.fn(async () => ({ messages: [pendingSummary] })),
  fetchRunReport: vi.fn(),
  fetchEvidenceManifest: vi.fn(),
  patchChatMessage: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", async (original) => ({
  ...(await original<typeof import("@/lib/client-diagnostics")>()),
  reportClientDiagnostic: vi.fn(),
}));
vi.mock("@/lib/markdown-skills-api", () => ({
  fetchMarkdownSkillSelection: vi.fn(async () => ({
    availability: "none",
    selection: { revision: 0, skill: null },
  })),
}));
vi.mock("@/lib/chat-draft-api", () => ({
  readChatDraft: vi.fn(async () => ({ text: "", revision: 0 })),
  writeChatDraft: vi.fn(async () => ({ text: "Unrelated draft", revision: 1 })),
}));
vi.mock("@/lib/memory-session-api", () => ({
  loadMemoryAutonomyMode: vi.fn(async () => ({
    requestedMode: "governed-assist",
    effectiveMode: "governed-assist",
    deploymentCeiling: "governed-assist",
    revision: 0,
  })),
}));

beforeAll(async () => {
  await prepareCanonicalVoiceHasher();
});
afterEach(cleanup);

it("parks run-summary polling with body-free evidence when its module cannot load", async () => {
  const hook = renderHook(() => useChatSession({ autoCreate: false }));
  await waitFor(() =>
    expect(reportClientDiagnostic).toHaveBeenCalledWith("Run summary formatting could not load.", {
      correlationId: undefined,
      errorKind: "unknown",
      errorEvidence: { errorClass: "Error", frames: [], causeChain: ["TypeError"] },
    }),
  );
  expect(summaryModule.loads).toBe(1);
  expect(hook.result.current.messages).toEqual([pendingSummary]);
  act(() => hook.result.current.setDraft("Unrelated draft"));
  expect(summaryModule.loads).toBe(1);
  expect(fetchRunReport).not.toHaveBeenCalled();
  expect(fetchEvidenceManifest).not.toHaveBeenCalled();
  expect(patchChatMessage).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls)).not.toContain(
    "SYNTHETIC_MODULE_LOAD_DETAIL",
  );
});
