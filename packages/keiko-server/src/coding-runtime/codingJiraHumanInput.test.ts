import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort, JiraHumanInputBinding } from "@oscharko-dev/keiko-connectors";
import type { JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  currentCodingJiraInput,
  prepareCodingJiraHumanInput,
  type PendingCodingJiraInput,
} from "./codingJiraHumanInput.js";
import { privateJiraCustodyFixture } from "../../../../tests/support/jira-private-custody-fixture.js";
import { response } from "../../../../tests/support/jira-managed-remote.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";

const ownedStores: UiStore[] = [];
afterEach(() => {
  for (const store of ownedStores.splice(0)) store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const binding: JiraHumanInputBinding = {
  context: { kind: "coding", runId: "run-one", taskId: "task-one", callId: "mcp-call-one" },
  authority: { runId: "run-one", envelopeDigest: "a".repeat(64) },
  principalDigest: "b".repeat(64),
  authRef: "atlassian-auth:12345678-1234-4123-8123-123456789abc",
  authenticationGeneration: 1,
  verificationRevision: 2,
  operation: "jira.login",
  argumentsDigest: "c".repeat(64),
  actorUserKey: "actor-key",
  actorUsername: "actor-name",
  expiresAt: 12345,
};
function fixture(): {
  pending: PendingCodingJiraInput;
  publish: ReturnType<typeof vi.fn>;
  revoke: () => void;
} {
  let current = true;
  const publish = vi.fn();
  const pending: PendingCodingJiraInput = {
    binding,
    argumentsValue: { expectedActorKey: "actor-key" },
    requestId: `jhi_${"d".repeat(64)}`,
    selection: undefined,
    current: () => current,
    publish,
    release: vi.fn(),
  };
  return {
    pending,
    publish,
    revoke: (): void => {
      current = false;
    },
  };
}
describe("current Coding input references carry no authority of their own", () => {
  it("returns only the public publisher for the same currently held invocation", () => {
    const f = fixture();
    const current = currentCodingJiraInput(
      f.pending,
      structuredClone(binding),
      f.pending.requestId ?? "",
    );
    expect(Object.keys(current ?? {})).toEqual(["publish"]);
    expect(current?.publish).toBe(f.publish);
    expect(current).not.toHaveProperty("selection");
    expect(current).not.toHaveProperty("values");
  });
  it.each([
    { context: { kind: "coding", runId: "other", taskId: "task-one", callId: "mcp-call-one" } },
    { context: { kind: "coding", runId: "run-one", taskId: "other", callId: "mcp-call-one" } },
    { context: { kind: "coding", runId: "run-one", taskId: "task-one", callId: "other" } },
    { authority: { runId: "run-one", envelopeDigest: "f".repeat(64) } },
    { argumentsDigest: "f".repeat(64) },
    { actorUserKey: "other" },
    { actorUsername: "other" },
    { authenticationGeneration: 2 },
    { verificationRevision: 3 },
    { principalDigest: "f".repeat(64) },
    { operation: "jira.update-my-password" },
    { expiresAt: 12346 },
  ] satisfies readonly Partial<JiraHumanInputBinding>[])(
    "refuses changed current invocation binding %#",
    (delta) => {
      const f = fixture();
      expect(
        currentCodingJiraInput(f.pending, { ...binding, ...delta }, f.pending.requestId ?? ""),
      ).toBeUndefined();
      expect(f.publish).not.toHaveBeenCalled();
    },
  );
  it("refuses an unknown request, released invocation or freshly revoked live guard", () => {
    const f = fixture();
    expect(currentCodingJiraInput(f.pending, binding, `jhi_${"e".repeat(64)}`)).toBeUndefined();
    expect(currentCodingJiraInput(undefined, binding, f.pending.requestId ?? "")).toBeUndefined();
    f.revoke();
    expect(currentCodingJiraInput(f.pending, binding, f.pending.requestId ?? "")).toBeUndefined();
  });
});

// The private custody and the ordinary Coding History owners are real here; the only remote
// boundary is a synthetic native /myself response. No OpenCode question receives human values.
function heldInputFixture(operation = "jira.login"): {
  privateState: import("../../../../tests/support/jira-private-custody-fixture.js").PrivateJiraCustodyFixture;
  store: UiStore;
  history: import("../store/codingHistory.js").CodingHistoryStore;
  task: import("@oscharko-dev/keiko-contracts/bff-wire").CodingHistoryTask;
  input: Parameters<typeof prepareCodingJiraHumanInput>[0];
  inputs: Map<string, PendingCodingJiraInput>;
  requested: Promise<JiraHumanInputView>;
  http: import("vitest").Mock<AtlassianHttpBodyPort>;
  controller: AbortController;
  refreshHistory: import("vitest").Mock<(runId: string) => Promise<void>>;
  notifications: string[];
  revoke: () => void;
} {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_800_000_000_000);
  const privateState = privateJiraCustodyFixture();
  const store = createInMemoryUiStore();
  ownedStores.push(store);
  const history = store.codingHistory;
  if (history === undefined) throw new TypeError("Missing Coding History");
  const task = history.begin({
    projectPath: process.cwd(),
    title: "Bound private input",
    modelId: "coding",
    workspaceId: "input-workspace",
    taskId: "input-task",
    branch: "codex/input-fixture",
    operatorDigest: "a".repeat(64),
    runId: "input-run",
    intent: "Use the selected Jira account",
  });
  history.bindNativeTurn("input-run", "msg_private_input", "Use the selected Jira account");
  const selected = privateState.custody.getMetadata(privateState.binding.authRef);
  if (selected?.deployment !== "data-center" || selected.livePod === undefined)
    throw new TypeError("Missing native fixture Pod");
  const credential = { ...selected, livePod: selected.livePod };
  let active = true;
  const controller = new AbortController();
  const authority = {
    taskId: "input-task",
    principalDigest: "a".repeat(64),
    authority: { runId: "input-run", envelopeDigest: "d".repeat(64) },
    expiresAt: Date.now() + 60_000,
  };
  const inputs = new Map<string, PendingCodingJiraInput>();
  let publishRequested: ((view: JiraHumanInputView) => void) | undefined;
  const requested = new Promise<JiraHumanInputView>((resolve) => {
    publishRequested = resolve;
  });
  const nativeTranscript = history.nativeToolTranscript.bind(history);
  vi.spyOn(history, "nativeToolTranscript").mockImplementation((runId, turn) => {
    const owner = nativeTranscript(runId, turn);
    return {
      ...owner,
      humanInput: (started, view, correlationId): void => {
        owner.humanInput(started, view, correlationId);
        if (view.state === "awaiting-input") publishRequested?.(view);
      },
    };
  });
  const http = vi.fn<AtlassianHttpBodyPort>(() =>
    Promise.resolve(
      response({
        key: "actor-key",
        name: "Native Actor",
        displayName: "Current Name",
        active: true,
      }),
    ),
  );
  const notifications: string[] = [];
  const refreshHistory = vi.fn(
    (runId: string): Promise<void> =>
      new Promise((resolve) => {
        const turn = history.nativeTurn(runId);
        const message = history
          .detail(task.id, "a".repeat(64))
          ?.messages.find((row) => row.id === turn?.userMessageId);
        expect(message?.toolTranscript?.exchanges[0]?.humanInput).toBeDefined();
        notifications.push(runId);
        resolve();
      }),
  );
  const input: Parameters<typeof prepareCodingJiraHumanInput>[0] = {
    deps: {
      store,
      codingRuntimeOrchestrator: { refreshHistory },
      atlassianConnectorCredentials: {
        custody: privateState.custody,
        httpBodyPortFactory: () => http,
      },
    },
    operation,
    args: { expectedActorKey: "actor-key" },
    context: {
      invocationId: "mcp-held-input",
      correlationId: "input-run",
      signal: controller.signal,
      beforeEffect: () => active,
    },
    inputs,
    currentAuthority: () => (active ? authority : undefined),
    currentCredential: () => credential,
  };
  return {
    privateState,
    store,
    history,
    task,
    input,
    inputs,
    requested,
    http,
    controller,
    refreshHistory,
    notifications,
    revoke: (): void => {
      active = false;
    },
  };
}

describe("Coding protected input on the existing native invocation and history", () => {
  it("clears ready values when authority changes before preparation can return", async () => {
    const f = heldInputFixture();
    const preparation = prepareCodingJiraHumanInput(f.input);
    const view = await f.requested;
    const pending = f.inputs.get(f.input.context.invocationId);
    if (pending === undefined) throw new TypeError("Missing held invocation");
    const secret = "synthetic-ready-before-revocation";
    f.privateState.inputs.submit(view.requestId, pending.binding, view.revision, {
      password: secret,
    });
    f.revoke();
    await expect(preparation).rejects.toMatchObject({ reason: "not-admitted" });
    expect([...f.privateState.sealedPortEntries.values()].join("")).not.toContain(secret);
    expect(
      f.privateState.inputs.cancelOwned(view.requestId, pending.binding.principalDigest)?.state,
    ).toBe("cancelled");
  });
  it.each([false, true])(
    "releases ready input at call completion without replacing a consumed claim (claimed=%s)",
    async (claimed) => {
      const f = heldInputFixture();
      const preparation = prepareCodingJiraHumanInput(f.input);
      const view = await f.requested;
      const pending = f.inputs.get(f.input.context.invocationId);
      if (pending === undefined) throw new TypeError("Missing held invocation");
      const secret = "synthetic-ready-before-call-exit";
      f.privateState.inputs.submit(view.requestId, pending.binding, view.revision, {
        password: secret,
      });
      const selected = await preparation;
      if (selected?.selection === undefined) throw new TypeError("Missing private selection");
      if (claimed)
        f.privateState.privateInputs.claim(
          view.requestId,
          selected.binding,
          selected.selection.revision,
        );
      selected.release();
      selected.release();
      expect([...f.privateState.sealedPortEntries.values()].join("")).not.toContain(secret);
      expect(f.privateState.clearedPhases).toEqual(claimed ? [] : ["cancelled"]);
      expect(f.privateState.inputs.inspect(view.requestId, selected.binding)?.state).toBe(
        claimed ? "consumed" : "cancelled",
      );
      expect(() =>
        f.privateState.privateInputs.claim(
          view.requestId,
          selected.binding,
          selected.selection?.revision ?? "",
        ),
      ).toThrow(claimed ? "not-ready" : "cancelled");
    },
  );
  it("persists a reloadable pending card, then binds only the submitted immutable revision", async () => {
    const f = heldInputFixture();
    const preparation = prepareCodingJiraHumanInput(f.input);
    const view = await f.requested;
    const pending = f.inputs.get(f.input.context.invocationId);
    if (pending === undefined) throw new TypeError("Missing held invocation");
    const turn = f.history.nativeTurn("input-run");
    if (turn === undefined) throw new TypeError("Missing native turn");
    const transcript = ():
      import("@oscharko-dev/keiko-contracts/bff-wire").ChatToolTranscript | undefined =>
      f.history
        .detail(turn.chatId, "a".repeat(64))
        ?.messages.find((message) => message.id === turn.userMessageId)?.toolTranscript;
    const exchange = transcript()?.exchanges[0];
    expect(exchange).toMatchObject({
      call: { id: "mcp-held-input", name: "jira_login" },
      humanInput: view,
    });
    expect(exchange).not.toHaveProperty("result");
    expect(exchange).not.toHaveProperty("mutationOutcome");
    expect(f.notifications).toEqual(["input-run"]);
    const authorityBefore = structuredClone(f.input.currentAuthority());
    const secret = ["synthetic", "private", "human", "value"].join("-");
    const ready = f.privateState.inputs.submit(view.requestId, pending.binding, view.revision, {
      password: secret,
    });
    currentCodingJiraInput(pending, pending.binding, view.requestId)?.publish(ready);
    const prepared = await preparation;
    expect(prepared?.selection).toMatchObject({
      requestId: view.requestId,
      revision: ready.revision,
    });
    expect(prepared?.current()).toBe(true);
    expect(f.input.currentAuthority()).toEqual(authorityBefore);
    expect(f.notifications.every((runId) => runId === "input-run")).toBe(true);
    expect(JSON.stringify(transcript())).not.toContain(secret);
    expect(f.store.findMessageById(turn.userMessageId)).toBeUndefined();
    expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
    f.revoke();
    expect(prepared?.current()).toBe(false);
    expect(currentCodingJiraInput(prepared, pending.binding, view.requestId)).toBeUndefined();
  });
  it("refuses changed current authority while awaiting input and cancels the held call", async () => {
    const f = heldInputFixture();
    const preparation = prepareCodingJiraHumanInput(f.input);
    const view = await f.requested;
    const pending = f.inputs.get(f.input.context.invocationId);
    if (pending === undefined) throw new TypeError("Missing held invocation");
    f.revoke();
    expect(currentCodingJiraInput(pending, pending.binding, view.requestId)).toBeUndefined();
    f.controller.abort();
    await expect(preparation).rejects.toMatchObject({ reason: "aborted" });
    expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });
  it("does not request input for a native no-op profile or malformed secret-bearing args", async () => {
    const f = heldInputFixture("jira.update-myself");
    await expect(
      prepareCodingJiraHumanInput({
        ...f.input,
        args: {
          expectedActorKey: "actor-key",
          expectedUser: {
            key: "actor-key",
            name: "Native Actor",
            displayName: "Current Name",
            active: true,
          },
          displayName: "Current Name",
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      prepareCodingJiraHumanInput({
        ...f.input,
        args: { expectedActorKey: "actor-key", password: "never-model-input" },
      }),
    ).resolves.toBeUndefined();
    expect(f.inputs.size).toBe(0);
    expect(f.refreshHistory).not.toHaveBeenCalled();
    expect(f.privateState.sealedPortEntries.size).toBeGreaterThan(0);
    expect(
      [...f.privateState.sealedPortEntries.keys()].some((key) => key.startsWith("jira-input:")),
    ).toBe(false);
  });
  it("does not notify when the actual native turn rejects transcript persistence", async () => {
    const f = heldInputFixture();
    const preparation = prepareCodingJiraHumanInput(f.input);
    const view = await f.requested;
    const pending = f.inputs.get(f.input.context.invocationId);
    if (pending === undefined) throw new TypeError("Missing held invocation");
    f.refreshHistory.mockClear();
    f.history.bindNativeTurn("input-run", "msg_next_input", "A later native turn");
    expect(() => {
      pending.publish(view);
    }).toThrow();
    expect(f.refreshHistory).not.toHaveBeenCalled();
    f.controller.abort();
    await expect(preparation).rejects.toMatchObject({ reason: "aborted" });
  });
});
