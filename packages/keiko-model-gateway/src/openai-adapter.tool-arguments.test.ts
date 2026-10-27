import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openCodeGatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import type { GatewayCallRequest } from "./gateway.js";
import { logModelId, type ModelGatewayLogEvent } from "./observability.js";
import type {
  GatewayRequest,
  GatewayStreamChunk,
  ModelProviderConfig,
  NormalizedResponse,
} from "./types.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

// #4009: the governed changeset tool matches `oldString` byte for byte and writes `newString` to
// the file. The gateway used to pass every tool-call argument through the heuristic secret
// patterns, so ordinary prose such as "supports basic stock holds" reached the edit tool as
// "supports Basic [REDACTED] holds": every exact replacement of the README failed as
// old-string-not-found, and created file content was silently rewritten. Only the configured
// provider secrets may be scrubbed from tool-call arguments.

const NOW = Date.parse("2026-10-10T00:00:00Z");
const PROVIDER: ModelProviderConfig = {
  modelId: "fixture-coding-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture-provider-key-4009",
  timeoutMs: 30_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};

// The synthetic README of the failing benchmark, byte for byte, with its final LF.
const README = [
  "# Inventory reservation engine",
  "",
  "Synthetic warehouse checkout service. The starter implementation supports basic stock holds,",
  "but can partially mutate inventory on failure and has no lifecycle or idempotency handling.",
  "Run `npm test` for its two starter tests. The accepted enhancement is in SPEC.md.",
  "",
].join("\n");

// Ordinary workspace text every heuristic pattern of `redact()` rewrites. None of it is the
// configured provider secret, so every byte must reach the tool unchanged.
const HEURISTIC_LOOKALIKES = [
  "Use bearer tokens rather than basic authentication.",
  "Authorization: Bearer fixture-token-value",
  'const fixture = { token: "abc123", password: "hunter2" };',
  "api_key=example-value",
  "x-api-key: example-value",
  "Clone https://user:pass@git.example.test/repo.git for the mirror.",
  "Call +49 30 12345678 or wire DE89 3704 0044 0532 0130 00.",
  `sk-${"a".repeat(24)}`,
  `ghp_${"b".repeat(24)}`,
].join("\n");

function changesetArguments(oldString: string, newString: string): Record<string, unknown> {
  return {
    changeset: {
      selectedFiles: ["README.md"],
      files: [
        {
          file: "README.md",
          expectedContentHash: createHash("sha256").update(README).digest("hex"),
        },
      ],
      edits: [{ file: "README.md", oldString, newString, replaceAll: false }],
      deletions: [],
      renames: [],
    },
  };
}

const REQUEST: GatewayRequest = {
  modelId: PROVIDER.modelId,
  messages: [{ role: "user", content: "Rewrite the README." }],
  toolCatalog: openCodeGatewayCatalogAdvertisement(NOW),
};

function wholeBody(args: Record<string, unknown>, name = "keiko_changeset_edit"): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_readme",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 12 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

// The arguments arrive as small fragments, so a redaction applied per fragment and one applied to
// the assembled text are both exercised.
function streamed(args: Record<string, unknown>, name = "keiko_changeset_edit"): Response {
  const text = JSON.stringify(args);
  const frames: unknown[] = [];
  for (let offset = 0; offset < text.length; offset += 7) {
    const first = offset === 0;
    frames.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                ...(first ? { id: "call_readme", type: "function" } : {}),
                function: {
                  ...(first ? { name } : {}),
                  arguments: text.slice(offset, offset + 7),
                },
              },
            ],
          },
        },
      ],
    });
  }
  frames.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  frames.push({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 12 } });
  return new Response(
    `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function adapter(
  answer: () => Response,
  events: ModelGatewayLogEvent[] = [],
  correlationId = "run-4009-fixture",
): OpenAiAdapter {
  return new OpenAiAdapter({
    fetchImpl: (): Promise<Response> => Promise.resolve(answer()),
    now: (): number => NOW,
    requestId: "tool-arguments-fixture",
    costClass: "medium",
    log: { write: (event): void => void events.push(event) },
    logContext: { correlationId },
  });
}

async function streamedAnswer(
  value: OpenAiAdapter,
  request: GatewayRequest = REQUEST,
): Promise<NormalizedResponse> {
  const chunks: GatewayStreamChunk[] = [];
  for await (const chunk of value.callStream(request, PROVIDER)) chunks.push(chunk);
  const done = chunks.at(-1);
  if (done?.type !== "done") throw new TypeError("expected a terminal done chunk");
  return done.response;
}

type ReadPath = (args: Record<string, unknown>) => Promise<NormalizedResponse>;

const readBuffered: ReadPath = (args) => adapter(() => wholeBody(args)).call(REQUEST, PROVIDER);
const readStreamed: ReadPath = (args) => streamedAnswer(adapter(() => streamed(args)));

const READ_PATHS = [
  ["buffered", readBuffered],
  ["streamed", readStreamed],
] as const;

function firstEdit(response: NormalizedResponse): Record<string, unknown> {
  const changeset = response.toolCalls[0]?.arguments.changeset as
    { readonly edits: readonly Record<string, unknown>[] } | undefined;
  const edit = changeset?.edits[0];
  if (edit === undefined) throw new TypeError("expected a bound changeset edit");
  return edit;
}

function redactionLines(events: readonly ModelGatewayLogEvent[]): ModelGatewayLogEvent[] {
  return events.filter((event) => event.op === "gateway.tool-arguments.redacted");
}

describe("tool-call arguments reach the governed tool byte for byte (#4009)", () => {
  it.each(READ_PATHS)("keeps the exact README oldString on a %s answer", async (_path, read) => {
    const response = await read(changesetArguments(README, "# Inventory reservation engine\n"));
    const edit = firstEdit(response);
    expect(edit.oldString).toBe(README);
    expect(Buffer.byteLength(String(edit.oldString))).toBe(299);
    expect(response.toolCalls[0]?.invocation).toBeDefined();
  });

  it.each(READ_PATHS)(
    "never rewrites heuristic secret lookalikes in written content on a %s answer",
    async (_path, read) => {
      const args = changesetArguments(HEURISTIC_LOOKALIKES, `${README}\n${HEURISTIC_LOOKALIKES}\n`);
      const response = await read(args);
      const edit = firstEdit(response);
      expect(edit.oldString).toBe(HEURISTIC_LOOKALIKES);
      expect(edit.newString).toBe(`${README}\n${HEURISTIC_LOOKALIKES}\n`);
      expect(JSON.stringify(response.toolCalls)).not.toContain("[REDACTED]");
    },
  );

  it.each(READ_PATHS)(
    "still scrubs the configured provider key and base URL on a %s answer",
    async (_path, read) => {
      const leaked = `key ${PROVIDER.apiKey} at ${PROVIDER.baseUrl} beside basic stock holds`;
      const response = await read(changesetArguments(README, leaked));
      const edit = firstEdit(response);
      expect(edit.newString).toBe("key [REDACTED] at [REDACTED] beside basic stock holds");
      expect(edit.oldString).toBe(README);
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain(PROVIDER.apiKey);
      expect(serialized).not.toContain(PROVIDER.baseUrl);
    },
  );

  it("records a configured-secret scrub of tool arguments, body-free, under the run correlation", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const leaked = `${PROVIDER.apiKey}\n${PROVIDER.apiKey}`;
    await adapter(() => wholeBody(changesetArguments(leaked, README)), events).call(
      REQUEST,
      PROVIDER,
    );
    const lines = redactionLines(events);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "warn",
      correlationId: "run-4009-fixture",
      extra: {
        modelId: logModelId(PROVIDER.modelId),
        toolCallCount: 1,
        redactedStringCount: 1,
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(PROVIDER.apiKey);
    expect(serialized).not.toContain("Inventory reservation engine");
    const persisted = expectActivityLogProof(
      "gateway.tool-arguments.redacted.emitted-line",
      formatActivityLogProofLine(lines[0] ?? {}),
    );
    expect(persisted).toMatchObject({ toolCallCount: 1, redactedStringCount: 1 });
  });

  it("records the same scrub on a streamed answer", async () => {
    const events: ModelGatewayLogEvent[] = [];
    await streamedAnswer(
      adapter(() => streamed(changesetArguments(README, `x ${PROVIDER.apiKey}`)), events),
    );
    expect(redactionLines(events)).toEqual([
      expect.objectContaining({
        correlationId: "run-4009-fixture",
        extra: expect.objectContaining({ toolCallCount: 1, redactedStringCount: 1 }) as unknown,
      }),
    ]);
  });

  it.each(READ_PATHS)(
    "writes no redaction line when the %s arguments carry no configured secret",
    async (path) => {
      const events: ModelGatewayLogEvent[] = [];
      const args = changesetArguments(README, HEURISTIC_LOOKALIKES);
      const value = adapter(() => (path === "buffered" ? wholeBody(args) : streamed(args)), events);
      await (path === "buffered" ? value.call(REQUEST, PROVIDER) : streamedAnswer(value));
      expect(redactionLines(events)).toEqual([]);
    },
  );

  it("keeps heuristic redaction of assistant prose, which no governed tool consumes", async () => {
    const value = adapter(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Authorization: Bearer fixture-token-value",
                },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const response = await value.call(REQUEST, PROVIDER);
    expect(response.content).not.toContain("fixture-token-value");
    expect(response.content).toContain("[REDACTED]");
  });

  // Independent review on PR #4012: only the changeset edit consumes its arguments as file content.
  // A native `question` is shown to the operator and a research target is fetched from the
  // internet, so a credential-shaped value the model echoed must still be scrubbed from both.
  it.each([
    [
      "question",
      {
        questions: [
          {
            header: "Token",
            question: "Use Authorization: Bearer fixture-token-value for the mirror?",
            options: [{ label: "Yes", description: "token=abc123secret" }],
          },
        ],
      },
    ],
    ["keiko_research_fetch", { target: "https://docs.example.test/?api_key=fixture-canary-value" }],
  ])("keeps heuristic redaction of %s arguments", async (name, args) => {
    const response = await adapter(() => wholeBody(args, name)).call(REQUEST, PROVIDER);
    const serialized = JSON.stringify(response.toolCalls);
    expect(response.toolCalls[0]?.name).toBe(name);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("fixture-token-value");
    expect(serialized).not.toContain("abc123secret");
    expect(serialized).not.toContain("fixture-canary-value");
  });

  it("records no exact-content scrub for a heuristically redacted tool", async () => {
    const events: ModelGatewayLogEvent[] = [];
    await adapter(
      () =>
        wholeBody(
          { target: `https://docs.example.test/?q=${PROVIDER.apiKey}` },
          "keiko_research_fetch",
        ),
      events,
    ).call(REQUEST, PROVIDER);
    expect(redactionLines(events)).toEqual([]);
  });
});

// #3897 review: a native Code Mode program and a native shell command line are executable source.
// A heuristic rewrite changes what runs (`basic stock holds` became `Basic [REDACTED] holds`), so
// they reach OpenCode byte for byte like file content; the configured provider literals are still
// removed from them.
describe("native executable arguments reach the original runtime byte for byte (#3897)", () => {
  const nativeTool = (name: string): Record<string, unknown> => ({
    name,
    description: `${name} fixture`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
  });
  const NATIVE_REQUEST: GatewayRequest = {
    modelId: PROVIDER.modelId,
    messages: [{ role: "user", content: "Run the fixture." }],
    toolCatalog: {
      kind: "native",
      runtime: { id: "opencode", version: "2.1.4" },
      tools: ["read", "execute", "shell"].map(nativeTool),
      toolSetDigest: "c".repeat(64),
      offered: {
        offerId: "opencode-native-fixture",
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
    } as unknown as GatewayRequest["toolCatalog"],
  };
  const PROGRAM = `const phrase = "The starter implementation supports basic stock holds.";\n${HEURISTIC_LOOKALIKES.split(
    "\n",
  )
    .map((line) => `// ${line}`)
    .join("\n")}\nreturn phrase;`;
  const COMMAND =
    "printf '%s' 'The implementation supports basic stock holds.' && echo api_key=example-value";
  const nativePaths = [
    [
      "buffered",
      (name: string, args: Record<string, unknown>): Promise<NormalizedResponse> =>
        adapter(() => wholeBody(args, name)).call(NATIVE_REQUEST, PROVIDER),
    ],
    [
      "streamed",
      (name: string, args: Record<string, unknown>): Promise<NormalizedResponse> =>
        streamedAnswer(
          adapter(() => streamed(args, name)),
          NATIVE_REQUEST,
        ),
    ],
  ] as const;

  it.each(nativePaths)(
    "keeps a Code Mode program and a shell command exact on a %s answer",
    async (_path, read) => {
      const program = await read("execute", { code: PROGRAM });
      expect(program.toolCalls[0]?.arguments.code).toBe(PROGRAM);
      const shell = await read("shell", { command: COMMAND, description: "print" });
      expect(shell.toolCalls[0]?.arguments.command).toBe(COMMAND);
      expect(JSON.stringify([program.toolCalls, shell.toolCalls])).not.toContain("[REDACTED]");
    },
  );

  it.each(nativePaths)(
    "still removes the configured provider literals on a %s answer",
    async (_path, read) => {
      const leaked = `curl -H 'x: ${PROVIDER.apiKey}' ${PROVIDER.baseUrl} # basic stock holds`;
      const shell = await read("shell", { command: leaked, description: "leak" });
      expect(shell.toolCalls[0]?.arguments.command).toBe(
        "curl -H 'x: [REDACTED]' [REDACTED] # basic stock holds",
      );
      const program = await read("execute", { code: `return "${PROVIDER.apiKey}";` });
      expect(program.toolCalls[0]?.arguments.code).toBe('return "[REDACTED]";');
    },
  );

  it("keeps heuristic redaction for a native tool that carries no executable source", async () => {
    const read = await adapter(() =>
      wholeBody({ path: "README.md", note: "Authorization: Bearer fixture-token-value" }, "read"),
    ).call(NATIVE_REQUEST, PROVIDER);
    expect(JSON.stringify(read.toolCalls)).toContain("[REDACTED]");
  });
});

it.each(["buffered", "streamed"] as const)(
  "keeps heuristic and configured-secret tool protection on a preserving %s Chat call",
  async (transport) => {
    const args = {
      questions: [
        {
          header: "Synthetic contact",
          question: `Contact +49 30 12345678 with Authorization: Bearer fixture-token-value and ${PROVIDER.apiKey}`,
          options: [{ label: "Continue", description: "Synthetic review" }],
        },
      ],
    };
    const request: GatewayCallRequest = { ...REQUEST, contentRedaction: "preserve" };
    const response =
      transport === "buffered"
        ? await adapter(() => wholeBody(args, "question")).call(request, PROVIDER)
        : await streamedAnswer(
            adapter(() => streamed(args, "question")),
            request,
          );
    expect(response.toolCalls[0]?.name).toBe("question");
    const serialized = JSON.stringify(response.toolCalls[0]?.arguments);
    expect(serialized).toContain("Synthetic review");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("+49 30 12345678");
    expect(serialized).not.toContain("fixture-token-value");
    expect(serialized).not.toContain(PROVIDER.apiKey);
  },
);
