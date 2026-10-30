// #3907: the Coding Workbench composer dictates exactly like the Chat composer — the same
// microphone, the same waveform inside the composer bar, the completed transcript inserted into the
// draft (never sent) and no separate review preview. Only the draft limit is the Workbench's own.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_TASK_INTENT_MAX_CHARS } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import * as api from "@/lib/api";
import type { VoiceCapabilityResolution } from "@/lib/types";
import { clearVoiceCapabilityCacheForTests } from "../../hooks/useVoiceCapability";
import {
  remainingDictationCharacters,
  type DictationController,
  type UseDictationOptions,
} from "../../hooks/useDictation";
import { TaskStartSection, type TaskComposerActions } from "./CodingWorkbenchSections";

const dictationMock = vi.hoisted(() => ({
  options: [] as unknown[],
  state: {} as Record<string, unknown>,
}));

vi.mock("../../hooks/useDictation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useDictation")>();
  return {
    ...actual,
    useDictation: vi.fn((options: unknown) => {
      dictationMock.options.push(options);
      return {
        phase: "idle",
        mode: "batch",
        transcript: "",
        liveTranscript: "",
        finalizationNote: undefined,
        error: undefined,
        emptyResult: false,
        audioLevel: 0,
        heardSpeech: false,
        micReady: false,
        busy: false,
        start: vi.fn(),
        stop: vi.fn(),
        cancel: vi.fn(),
        retry: vi.fn(),
        discard: vi.fn(),
        insert: vi.fn(),
        setTranscript: vi.fn(),
        ...dictationMock.state,
      } satisfies Partial<DictationController>;
    }),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchVoiceCapability: vi.fn() };
});

class StubMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }
}

const STT: VoiceCapabilityResolution = {
  available: true,
  profile: "speech-to-text",
  capabilities: { speechToText: true, speechOutput: false, realtimeVoice: false },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: [],
  providerLocality: "azure-foundry",
};

const CODING_MODEL: ModelCapability = {
  id: "gemma-4-31b-it",
  kind: "chat",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  toolCalling: true,
  structuredOutput: true,
  streaming: true,
  supportsImageInput: false,
  supportsDocumentInput: false,
  workflowEligible: true,
  costClass: "medium",
  latencyClass: "standard",
  throughputHint: "standard",
  preferredUseCases: ["Coding"],
  knownLimitations: [],
  reasoningEfforts: [],
};

function actions(): TaskComposerActions {
  return {
    onStart: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
  };
}

function renderComposer(taskIntent: string, runId?: string): void {
  render(
    <TaskStartSection
      taskIntent={taskIntent}
      onTaskIntentChange={vi.fn()}
      actions={actions()}
      canStart
      canResume
      runState="idle"
      mutationPending={false}
      stopPending={false}
      startBusy={false}
      startBlockedReason={null}
      projectMemoryEnabled
      onProjectMemoryEnabledChange={vi.fn()}
      autonomyMode="supervised-coding"
      autonomyLabel="Supervised workspace"
      activeRunMode={null}
      requestedMode="supervised-coding"
      runtimePreference="managed-gateway"
      configurationLocked={false}
      onRequestedModeChange={vi.fn()}
      onRuntimePreferenceChange={vi.fn()}
      models={[CODING_MODEL]}
      selectedModelId={CODING_MODEL.id}
      reasoningEffort={null}
      onSelectedModelChange={vi.fn()}
      onReasoningEffortChange={vi.fn()}
      offeredAgents={["build"]}
      agent="build"
      agentLocked={false}
      onAgentChange={vi.fn()}
      {...(runId === undefined ? {} : { runId })}
    />,
  );
}

function lastOptions(): UseDictationOptions {
  const options = dictationMock.options.at(-1);
  if (options === undefined) throw new Error("useDictation was not called");
  return options as UseDictationOptions;
}

beforeEach(() => {
  clearVoiceCapabilityCacheForTests();
  vi.mocked(api.fetchVoiceCapability).mockReset();
  vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: STT });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream) },
  });
  vi.stubGlobal("MediaRecorder", StubMediaRecorder);
  dictationMock.options.length = 0;
  dictationMock.state = {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "mediaDevices");
});

describe("Coding Workbench composer dictation", () => {
  it("inserts the completed transcript like Chat, within the task's own draft limit", async () => {
    renderComposer("Fix the parser", "run-1");
    await screen.findByRole("button", { name: /dictate/i });
    expect(lastOptions()).toMatchObject({
      insertOnComplete: true,
      contextKey: "run-1",
      availableCharacters: remainingDictationCharacters(
        "Fix the parser",
        CODING_WORKBENCH_TASK_INTENT_MAX_CHARS,
      ),
      realtime: { enabled: false },
    });
    expect(lastOptions().captureOwner).toEqual(expect.any(String));
  });

  // Turn-based capture is the Workbench's only dictation path (ADR-0154, #3559): even a deployment
  // with Realtime voice and a browser that could carry it must not open the live connection.
  it("keeps dictation turn-based when the deployment and browser offer Realtime voice", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: {
        ...STT,
        profile: "full-realtime",
        capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
        transport: { websocketControl: true, webrtcMedia: true },
      },
    });
    class StubPeerConnection {
      addTransceiver(): void {
        // Present only so the browser reports Realtime support.
      }
    }
    vi.stubGlobal("RTCPeerConnection", StubPeerConnection);
    renderComposer("");
    await screen.findByRole("button", { name: /dictate/i });
    expect(lastOptions().realtime).toEqual({ enabled: false });
  });

  it("draws the shared waveform inside the composer bar while recording, with no review preview", async () => {
    dictationMock.state = { phase: "recording", micReady: true, busy: true, audioLevel: 0.5 };
    renderComposer("");
    await waitFor(() => {
      expect(document.querySelector(".cmp-bar svg line")).not.toBeNull();
    });
    expect(screen.getByRole("status")).toHaveTextContent(/listening/i);
    expect(screen.queryByRole("button", { name: /insert/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /transcript/i })).toBeNull();
  });

  it("reports an empty dictation in the composer status, as Chat does", async () => {
    dictationMock.state = { emptyResult: true };
    renderComposer("");
    await screen.findByRole("button", { name: /dictate/i });
    expect(await screen.findByText(/no speech was recognized/i)).toBeVisible();
  });
});
