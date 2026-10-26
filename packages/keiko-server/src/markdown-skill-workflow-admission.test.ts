import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type {
  GatewayCallRequest,
  GatewayStreamChunk,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
import {
  SelectedMarkdownSkillUnavailableError,
  withSelectedMarkdownSkill,
} from "./markdown-skill-admission.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { createInMemoryUiStore } from "./store/index.js";

const MARKER = "SYNTHETIC_WORKFLOW_SKILL_RECEIPT";
const BODY = `# Test method\nName every generated test after ${MARKER}.\n`;
const RUN_ID = "run-workflow-skill";

const RESPONSE: NormalizedResponse = {
  modelId: "m",
  content: "done",
  finishReason: "stop",
  toolCalls: [],
  structuredOutput: null,
  usage: { requestId: "r", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
};

function captureLog(): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  return sink;
}

function encoded(body: string): { readonly fileName: string; readonly contentBase64: string } {
  return { fileName: "method.md", contentBase64: Buffer.from(body).toString("base64") };
}

function recordingModel(): { readonly model: ModelPort; readonly sent: GatewayCallRequest[] } {
  const sent: GatewayCallRequest[] = [];
  return {
    sent,
    model: {
      call: (request): Promise<NormalizedResponse> => {
        sent.push(request);
        return Promise.resolve(RESPONSE);
      },
      callStream: async function* (request): AsyncIterable<GatewayStreamChunk> {
        sent.push(request);
        await Promise.resolve();
        yield { type: "done", response: RESPONSE };
      },
    },
  };
}

function setup(authority: () => boolean = () => true): {
  readonly store: ReturnType<typeof createInMemoryUiStore>;
  readonly skill: ReturnType<ReturnType<typeof createInMemoryUiStore>["markdownSkills"]["import"]>;
  readonly sent: GatewayCallRequest[];
  readonly model: ModelPort;
} {
  const store = createInMemoryUiStore();
  const skill = store.markdownSkills.import(encoded(BODY));
  const recording = recordingModel();
  const model = withSelectedMarkdownSkill(recording.model, {
    library: store.markdownSkills,
    reference: { id: skill.id, revision: skill.revision, digest: skill.digest },
    authorityCurrent: authority,
    runId: RUN_ID,
    workflow: "unit-tests",
  });
  return { store, skill, sent: recording.sent, model };
}

const occurrences = (request: GatewayCallRequest | undefined, text: string): number =>
  JSON.stringify(request?.messages ?? []).split(text).length - 1;

const PROMPT = {
  modelId: "m",
  messages: [
    { role: "system" as const, content: "Write unit tests." },
    { role: "user" as const, content: "Target: src/add.ts" },
  ],
};

const signal = new AbortController().signal;

afterEach(resetServerLogger);

describe("a workflow run's selected skill at the model boundary (#4025 AC1)", () => {
  it("leads the first user message of every call once and records only its identity", async () => {
    const sink = captureLog();
    const { store, skill, sent, model } = setup();
    try {
      await model.call(PROMPT, signal);
      await model.call(PROMPT, signal);

      expect(sent.map((request) => occurrences(request, MARKER))).toEqual([1, 1]);
      expect(sent[0]?.messages[0]).toEqual(PROMPT.messages[0]);
      expect(sent[0]?.messages[1]?.content).toMatch(
        /<selected_skill>[\s\S]*Target: src\/add\.ts$/u,
      );
      const attached = sink.events.filter((event) => event.op === "skills.workflow.attached");
      expect(attached).toHaveLength(2);
      expect(attached[0]?.extra).toMatchObject({
        runId: RUN_ID,
        workflow: "unit-tests",
        phase: "attached",
        skillRevision: skill.revision,
        skillDigest: skill.digest,
        skillByteCount: Buffer.byteLength(BODY),
      });
      expect(attached[0]?.correlationId).toBe(RUN_ID);
      expect(JSON.stringify(sink.events)).not.toContain(MARKER);
      expectActivityLogProof(
        "skills.workflow.attached.line",
        formatActivityLogProofLine(attached[0] ?? {}),
      );
    } finally {
      store.close();
    }
  });

  it("carries the skill on a streamed call too", async () => {
    const { store, sent, model } = setup();
    try {
      const chunks: GatewayStreamChunk[] = [];
      for await (const chunk of model.callStream?.(PROMPT, signal) ?? []) chunks.push(chunk);
      expect(chunks.map((chunk) => chunk.type)).toEqual(["done"]);
      expect(occurrences(sent[0], MARKER)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("keeps the bound revision when the skill is replaced during the run", async () => {
    const { store, skill, sent, model } = setup();
    try {
      store.markdownSkills.replace(
        skill.id,
        skill.revision,
        encoded("# Other\nA REPLACED METHOD.\n"),
      );
      await model.call(PROMPT, signal);
      expect(occurrences(sent[0], MARKER)).toBe(1);
      expect(occurrences(sent[0], "A REPLACED METHOD")).toBe(0);
    } finally {
      store.close();
    }
  });

  it("checks every physical attempt again, composed with the request's own admission", async () => {
    const sink = captureLog();
    const { store, skill, sent, model } = setup();
    const own = vi.fn<NonNullable<GatewayCallRequest["attemptAdmission"]>>(() => ({
      settle: (): void => undefined,
    }));
    try {
      await model.call({ ...PROMPT, attemptAdmission: own }, signal);
      const admit = sent[0]?.attemptAdmission;
      if (admit === undefined) throw new Error("expected a per-attempt admission");

      expect(admit({ promptTokens: 1, maxOutputTokens: 1 })).toBeDefined();
      expect(own).toHaveBeenCalledTimes(1);

      store.markdownSkills.delete(skill.id, skill.revision);
      expect(() => admit({ promptTokens: 1, maxOutputTokens: 1 })).toThrow(
        SelectedMarkdownSkillUnavailableError,
      );
      expect(own).toHaveBeenCalledTimes(1);
      expect(
        sink.events.find(
          (event) => event.op === "skills.workflow.attached" && event.extra?.phase === "refused",
        )?.extra,
      ).toMatchObject({ reason: "skill-unavailable", skillRevision: skill.revision });
    } finally {
      store.close();
    }
  });

  it("sends nothing once the skill is deleted or the run's authority is gone", async () => {
    const sink = captureLog();
    let current = true;
    const { store, skill, sent, model } = setup(() => current);
    try {
      current = false;
      await expect(model.call(PROMPT, signal)).rejects.toBeInstanceOf(
        SelectedMarkdownSkillUnavailableError,
      );
      current = true;
      store.markdownSkills.delete(skill.id, skill.revision);
      await expect(model.call(PROMPT, signal)).rejects.toBeInstanceOf(
        SelectedMarkdownSkillUnavailableError,
      );
      expect(sent).toHaveLength(0);
      expect(
        sink.events
          .filter((event) => event.op === "skills.workflow.attached")
          .map((event) => event.extra?.reason),
      ).toEqual(["authority-invalid", "skill-unavailable"]);
    } finally {
      store.close();
    }
  });
});
