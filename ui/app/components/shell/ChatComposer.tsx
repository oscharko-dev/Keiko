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

// ---------------------------------------------------------------------------
// Workflow modes (issue #65)
// ---------------------------------------------------------------------------

export type ComposerMode =
  | "generate-tests"
  | "investigate-bug"
  | "explain-plan"
  | "verify";

interface ModeOption {
  readonly id: ComposerMode;
  readonly label: string;
}

const MODE_OPTIONS: readonly ModeOption[] = [
  { id: "generate-tests", label: "Generate Tests" },
  { id: "investigate-bug", label: "Investigate Bug" },
  { id: "explain-plan", label: "Explain Plan" },
  { id: "verify", label: "Verify" },
];

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
    const lines = text.split("\n");
    const filePath = (lines[0] ?? "").trim();
    if (filePath.length === 0) {
      return null;
    }
    const rest = lines.slice(1).join("\n").trim();
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
  const trimmed = text.trim();
  if (mode === "explain-plan" || mode === "investigate-bug") {
    return trimmed.length > 0;
  }
  return true;
}

function modeLabel(mode: ComposerMode): string {
  return MODE_OPTIONS.find((o) => o.id === mode)?.label ?? mode;
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
    return "Optional context. The workflow targets the project root.";
  }
  return "Optional notes. Verify runs against the project root.";
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
      setSelectedModelId(chat.selectedModel);
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

      <div
        role="radiogroup"
        aria-label="Workflow mode"
        className="mb-2 flex flex-wrap gap-2"
      >
        {MODE_OPTIONS.map((opt) => {
          const active = mode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={isSending}
              onClick={() => setMode(opt.id)}
              className={`rounded-full px-3 py-1 text-xs
                focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
                disabled:opacity-50
                ${
                  active
                    ? "bg-accent text-ink-inverse"
                    : "bg-elevated text-ink-muted hover:bg-panel"
                }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

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
            text-sm text-ink placeholder:text-ink-dim
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
    </div>
  );
}

export default ChatComposer;
