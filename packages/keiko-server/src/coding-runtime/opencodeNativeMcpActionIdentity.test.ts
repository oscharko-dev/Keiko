import type { CodingToolNativeEffectAdmission } from "./codingToolFacadePorts.js";
import { afterEach, expect, it, vi } from "vitest";
import { createOpenCodeV2ApprovalRequests } from "./opencodeV2ApprovalRequests.js";
import {
  decideOpenCodeNativePolicy,
  parseOpenCodeNativePolicyRequest,
  type OpenCodeNativePolicyRequest,
  type OpenCodeNativePolicyDecision,
} from "./opencodeNativePolicy.js";
import { OPENCODE_NATIVE_POLICY_ACTION } from "./opencodeNativePolicyPlugin.js";
import { realNativeRuntime } from "../tool-catalog/__fixtures__/nativeEffectRuntimeFixture.js";

const runtimes: ReturnType<typeof realNativeRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});
const source = { messageID: "msg_parent", id: "call_execute_parent" };
const sessionID = "ses_native0000000000001";
function request(
  permission: string,
  mcpInput: Readonly<Record<string, unknown>>,
): OpenCodeNativePolicyRequest {
  return { runId: "run-native", sessionID, source, permission, resources: ["*"], mcpInput };
}
function decision(
  value: OpenCodeNativePolicyRequest,
): Extract<OpenCodeNativePolicyDecision, { effect: "ask" }> {
  const result = decideOpenCodeNativePolicy({
    mode: "governed-assist",
    workspaceRoot: "/synthetic/workspace",
    nowMs: Date.now(),
    request: value,
    mcp: {
      actions: new Map([
        ["fixture_read", { risk: "read", remote: true, managed: true }],
        ["fixture_write", { risk: "write", remote: true, managed: true }],
      ]),
      servers: new Map(),
    },
  });
  if (result.effect !== "ask") throw new TypeError("Expected governed MCP approval");
  return result;
}

it("never reuses a human decision for a different inner MCP action sharing the producer parent", async () => {
  const approvals = createOpenCodeV2ApprovalRequests();
  const first = decision(request("fixture_read", { id: "a" }));
  const second = decision(request("fixture_write", { value: "b" }));
  expect(first.actionId).toBe(second.actionId);
  expect(first.event.requestId).not.toBe(second.event.requestId);
  const onPermission = vi.fn();
  const send = (ask: typeof first): ReturnType<typeof approvals.requestNative> =>
    approvals.requestNative({
      runId: "run-native",
      event: ask.event,
      actionId: ask.actionId,
      onPermission,
      signal: new AbortController().signal,
    });
  const firstPending = send(first);
  expect(approvals.resolve("run-native", first.event.requestId, true)).toBe(true);
  await expect(firstPending).resolves.toMatchObject({ outcome: "approved" });
  const secondPending = send(second);
  expect(onPermission).toHaveBeenCalledTimes(2);
  expect(approvals.resolve("run-native", first.event.requestId, true)).toBe(false);
  expect(approvals.resolve("run-native", second.event.requestId, false)).toBe(true);
  await expect(secondPending).resolves.toMatchObject({ outcome: "denied" });
  approvals.close();
});

function received(
  permission: string,
  input: unknown,
  suppliedDigest?: string,
): OpenCodeNativePolicyRequest {
  const parsed = parseOpenCodeNativePolicyRequest({
    ...request(permission, {}),
    action: OPENCODE_NATIVE_POLICY_ACTION,
    source: { type: "tool", ...source },
    mcpInput: input,
    mcpActionDigest: suppliedDigest,
  });
  if (parsed === undefined) throw new TypeError("Expected valid policy envelope");
  return parsed;
}
function runtimeWithBudget(
  count: number,
): (value: OpenCodeNativePolicyRequest) => CodingToolNativeEffectAdmission {
  const runtime = realNativeRuntime(count);
  runtimes.push(runtime);
  const facet = runtime.facade.nativeEffect;
  if (facet === undefined) throw new TypeError("Expected native admission owner");
  return (value) =>
    facet.admit({
      capability: runtime.capability,
      actionClass: "network-egress",
      invocation: {
        sessionId: sessionID,
        messageId: source.messageID,
        callId: source.id,
        ...(value.mcpActionDigest === undefined ? {} : { mcpActionDigest: value.mcpActionDigest }),
      },
    });
}
it("charges different inner actions, revalidates the same action once, and refuses the next over budget", () => {
  const admit = runtimeWithBudget(2);
  const first = received("fixture_read", { id: "a" });
  const second = received("fixture_write", { value: "b" });
  expect(admit(first)).toEqual({ ok: true, charge: "charged" });
  expect(admit(first)).toEqual({ ok: true, charge: "already-charged" });
  expect(admit(second)).toEqual({ ok: true, charge: "charged" });
  expect(admit(second)).toEqual({ ok: true, charge: "already-charged" });
  expect(admit(received("fixture_write", { value: "c" }))).toEqual({
    ok: false,
    reason: "authority-budget-exceeded",
  });
});
it("charges identical physical reads under one producer parent separately", () => {
  const admit = runtimeWithBudget(2);
  const first = received("fixture_read", { id: "same" });
  const repeated = received("fixture_read", { id: "same" });
  expect(admit(first)).toEqual({ ok: true, charge: "charged" });
  expect(admit(first)).toEqual({ ok: true, charge: "already-charged" });
  expect(admit(repeated)).toEqual({ ok: true, charge: "charged" });
  expect(admit(repeated)).toEqual({ ok: true, charge: "already-charged" });
  expect(admit(received("fixture_read", { id: "same" }))).toEqual({
    ok: false,
    reason: "authority-budget-exceeded",
  });
});
it("captures input and ignores a caller-supplied action digest", () => {
  const value = { nested: { value: "synthetic" } };
  const first = received("fixture_read", value, "a".repeat(64));
  const second = received("fixture_read", value, first.mcpActionDigest);
  expect(first.mcpActionDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(first.mcpActionDigest).not.toBe("a".repeat(64));
  expect(second.mcpActionDigest).not.toBe(first.mcpActionDigest);
  value.nested.value = "changed";
  expect(first.mcpInput).toEqual({ nested: { value: "synthetic" } });
});
const unsafeInput: unknown = JSON.parse('{"__proto__":{}}');
it.each([undefined, null, [], "invalid", { value: "x".repeat(262144) }, unsafeInput])(
  "leaves malformed MCP input unadmitted",
  (value) => {
    const captured = received("fixture_read", value);
    expect(captured.mcpInput).toBeUndefined();
    expect(captured.mcpActionDigest).toBeUndefined();
  },
);

it("charges repeated built-in MCP resource reads separately under the same parent", () => {
  const admit = runtimeWithBudget(2);
  const first = received("opencode_read_mcp_resource", undefined);
  const second = received("opencode_read_mcp_resource", undefined);
  expect(admit(first)).toEqual({ ok: true, charge: "charged" });
  expect(admit(first)).toEqual({ ok: true, charge: "already-charged" });
  expect(admit(second)).toEqual({ ok: true, charge: "charged" });
  expect(admit(received("opencode_read_mcp_resource", undefined))).toEqual({
    ok: false,
    reason: "authority-budget-exceeded",
  });
});
