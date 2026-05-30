"use client";

import { useEffect, useId, useState } from "react";
import type { ReactNode, KeyboardEvent, Ref } from "react";
import {
  ApiError,
  createChatMessage,
  fetchModels,
  startRun,
  updateChat,
} from "@/lib/api";
import type {
  Chat,
  ModelCapability,
  ProjectWithAvailability,
} from "@/lib/types";
import { ComposerModeSelector } from "./ComposerModeSelector";

// ---------------------------------------------------------------------------
// Workflow modes (issue #65)
// ---------------------------------------------------------------------------

export type ComposerMode =
  | "generate-tests"
  | "investigate-bug"
  | "explain-plan"
  | "verify";

// Default model when the chat's selectedModel is not present in the registry's chat-kind slice.
// If neither the chat's selectedModel nor this fallback are exposed, the dropdown shows no choice
// and submit stays disabled with a role="alert" "No chat models available" message.
const FALLBACK_MODEL_ID = "Mistral-Small-3.1-24B-Instruct-2503";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChatComposerProps {
  chatId: string;
  chat: Chat;
  project: ProjectWithAvailability;
  onMessageSent: () => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

type SendState = { kind: "idle" } | { kind: "sending" } | { kind: "error"; message: string };

type ModelsState =
  | { kind: "loading" }
  | { kind: "ready"; chatModels: readonly ModelCapability[] };

// ---------------------------------------------------------------------------
// Model-selection helpers (pure)
// ---------------------------------------------------------------------------

function filterChatModels(models: readonly ModelCapability[]): readonly ModelCapability[] {
  return models.filter((m) => m.kind === "chat");
}

function pickDefaultModelId(
  chatModels: readonly ModelCapability[],
  preferred: string,
): string {
  if (chatModels.some((m) => m.id === preferred)) {
    return preferred;
  }
  if (chatModels.some((m) => m.id === FALLBACK_MODEL_ID)) {
    return FALLBACK_MODEL_ID;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Per-mode startRun payload assembly (pure)
// ---------------------------------------------------------------------------

interface RunPayload {
  readonly workflowId?: string;
  readonly taskType?: string;
  readonly modelId: string;
  readonly input: Record<string, unknown>;
}

// Returns the first non-empty trimmed line from text, or null if none exists.
// Used by both isSubmitReady and buildRunPayload for Explain Plan so that
// whitespace-only input (e.g. "\n  \n") never passes validation silently.
function extractExplainPlanFilePath(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function buildRunPayload(
  mode: ComposerMode,
  modelId: string,
  workspaceRoot: string,
  text: string,
): RunPayload | null {
  if (mode === "generate-tests") {
    return {
      workflowId: "unit-test-generation",
      modelId,
      input: {
        target: { kind: "moduleDir", moduleDir: workspaceRoot },
        workspaceRoot,
      },
    };
  }
  if (mode === "investigate-bug") {
    return {
      workflowId: "bug-investigation",
      modelId,
      input: { report: { description: text }, workspaceRoot },
    };
  }
  if (mode === "explain-plan") {
    const filePath = extractExplainPlanFilePath(text);
    if (filePath === null) {
      return null;
    }
    const lines = text.split("\n");
    // Skip leading blank lines, then skip the filePath line, collect the rest as question.
    let filePathLineIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i] ?? "").trim().length > 0) {
        filePathLineIndex = i;
        break;
      }
    }
    const rest = lines.slice(filePathLineIndex + 1).join("\n").trim();
    const baseInput: Record<string, unknown> = { filePath, workspaceRoot };
    if (rest.length > 0) {
      baseInput.question = rest;
    }
    return { taskType: "explain-plan", modelId, input: baseInput };
  }
  return { taskType: "verify", modelId, input: { workspaceRoot } };
}

function isSubmitReady(
  mode: ComposerMode | null,
  modelId: string,
  text: string,
): boolean {
  if (mode === null || modelId.length === 0) {
    return false;
  }
  if (mode === "explain-plan") {
    return extractExplainPlanFilePath(text) !== null;
  }
  if (mode === "investigate-bug") {
    return text.trim().length > 0;
  }
  return true;
}

function modeLabel(mode: ComposerMode): string {
  const labels: Record<ComposerMode, string> = {
    "generate-tests": "Generate Tests",
    "investigate-bug": "Investigate Bug",
    "explain-plan": "Explain Plan",
    verify: "Verify",
  };
  return labels[mode];
}

function modePlaceholder(mode: ComposerMode | null): string {
  if (mode === null) {
    return "Choose a workflow mode to start";
  }
  if (mode === "explain-plan") {
    return "File path on the first line. Optional question on later lines.";
  }
  if (mode === "investigate-bug") {
    return "Describe the bug. (Enter to send, Shift+Enter for new line)";
  }
  if (mode === "generate-tests") {
    return "Optional notes for the chat (not used by the workflow). Tests are generated for the entire project.";
  }
  return "Optional notes for the chat (not used by the workflow). Verification runs against the entire project.";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Model-aware chat composer (issue #65). Surfaces a model dropdown (chat-kind only) and a
 * radiogroup of four workflow launch modes. Submission creates a user message, optionally
 * PATCHes the chat's selectedModel if the user changed it, then starts the run for the
 * selected mode and records a system-role status message.
 *
 * Provider settings (baseUrl/apiKey/deployment*) are NEVER fetched: the composer reads only
 * `/api/models`, never `/api/config`. The model dropdown lists exclusively `kind === "chat"`
 * models in registry order; OCR and embedding models are filtered out at the source.
 */
export function ChatComposer({
  chatId,
  chat,
  project,
  onMessageSent,
  textareaRef,
}: ChatComposerProps): ReactNode {
  const [text, setText] = useState("");
  const [sendState, setSendState] = useState<SendState>({ kind: "idle" });
  const [modelsState, setModelsState] = useState<ModelsState>({ kind: "loading" });
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [mode, setMode] = useState<ComposerMode | null>(null);

  const composerId = useId();
  const errorId = `${composerId}-error`;
  const noModelsId = `${composerId}-no-models`;
  const modelSelectId = `${composerId}-model`;

  useEffect(() => {
    let active = true;
    void fetchModels()
      .then(({ models }) => {
        if (!active) return;
        const chatModels = filterChatModels(models);
        setModelsState({ kind: "ready", chatModels });
        setSelectedModelId(pickDefaultModelId(chatModels, chat.selectedModel));
      })
      .catch(() => {
        if (!active) return;
        setModelsState({ kind: "ready", chatModels: [] });
        setSelectedModelId("");
      });
    return () => {
      active = false;
    };
  }, [chat.selectedModel]);

  const isSending = sendState.kind === "sending";
  const chatModels = modelsState.kind === "ready" ? modelsState.chatModels : [];
  const hasModels = chatModels.length > 0;
  const submitReady = isSubmitReady(mode, selectedModelId, text);

  async function persistModelChange(): Promise<boolean> {
    if (selectedModelId === chat.selectedModel) {
      return true;
    }
    try {
      await updateChat(chatId, { selectedModel: selectedModelId });
      return true;
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : "Failed to update chat model.";
      setSendState({ kind: "error", message: msg });
      // Re-run the same fallback logic used on mount so the dropdown never shows
      // a value with no matching <option> when chat.selectedModel is stale.
      setSelectedModelId(pickDefaultModelId(chatModels, chat.selectedModel));
      return false;
    }
  }

  async function send(): Promise<void> {
    if (!submitReady || isSending || mode === null) return;
    const content = text.trim();
    const payload = buildRunPayload(mode, selectedModelId, project.path, content);
    if (payload === null) return;
    setSendState({ kind: "sending" });
    try {
      await createChatMessage({
        chatId,
        role: "user",
        content,
        timestamp: Date.now(),
      });
      const modelOk = await persistModelChange();
      if (!modelOk) return;
      const run = await startRun(payload);
      await createChatMessage({
        chatId,
        role: "system",
        content: `${modeLabel(mode)} started`,
        timestamp: Date.now(),
        runId: run.runId,
        ...(payload.workflowId === undefined ? {} : { workflowId: payload.workflowId }),
        // Issue #66 — non-workflow task runs (verify, explain-plan) carry taskType so the
        // chat renders an unambiguous label instead of "Workflow run".
        ...(payload.taskType === undefined ? {} : { taskType: payload.taskType }),
        workflowStatus: "running",
      });
      setText("");
      setSendState({ kind: "idle" });
      onMessageSent();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : "Failed to send message.";
      setSendState({ kind: "error", message: msg });
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="border-t border-border bg-chrome px-4 py-3">
      {sendState.kind === "error" && (
        <p id={errorId} role="alert" className="mb-2 text-xs text-red-400">
          {sendState.message}
        </p>
      )}
      {modelsState.kind === "ready" && !hasModels && (
        <p id={noModelsId} role="alert" className="mb-2 text-xs text-red-400">
          No chat models available
        </p>
      )}

      <div className="mb-2 flex items-center gap-2">
        <label htmlFor={modelSelectId} className="text-xs text-ink-muted">
          Model
        </label>
        <select
          id={modelSelectId}
          value={selectedModelId}
          onChange={(e) => setSelectedModelId(e.target.value)}
          disabled={!hasModels || isSending}
          aria-describedby={hasModels ? undefined : noModelsId}
          className="rounded bg-elevated px-2 py-1 text-xs text-ink
            focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
            disabled:opacity-50"
        >
          {chatModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
      </div>

      <ComposerModeSelector mode={mode} disabled={isSending} onChange={setMode} />

      <div className="flex items-end gap-2">
        <label htmlFor={`composer-${chatId}`} className="sr-only">
          Message
        </label>
        <textarea
          ref={textareaRef}
          id={`composer-${chatId}`}
          rows={3}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (sendState.kind === "error") setSendState({ kind: "idle" });
          }}
          onKeyDown={handleKeyDown}
          placeholder={modePlaceholder(mode)}
          disabled={isSending}
          aria-describedby={sendState.kind === "error" ? errorId : undefined}
          aria-invalid={sendState.kind === "error" ? "true" : undefined}
          className="flex-1 resize-none rounded border border-border bg-elevated px-3 py-2
            text-sm text-ink placeholder:text-ink-muted
            focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
            disabled:opacity-50"
        />
        <button
          type="button"
          disabled={!submitReady || isSending}
          onClick={() => {
            void send();
          }}
          aria-label="Send message"
          className="shrink-0 rounded bg-accent px-3 py-2 text-xs font-medium text-ink-inverse
            hover:bg-accent-strong
            focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
            disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSending ? "…" : "Send"}
        </button>
      </div>
      {/* sr-only live region announces sending state to AT (WCAG 4.1.3) */}
      <span role="status" aria-live="polite" className="sr-only">
        {isSending ? "Sending message" : ""}
      </span>
    </div>
  );
}

export default ChatComposer;
