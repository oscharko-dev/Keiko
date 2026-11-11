import { describe, expect, it, vi } from "vitest";
import {
  BULK_CREATE_ARGUMENTS as ARGS,
  BULK_CREATE_RECEIPT as RECEIPT,
  bulkCreateFixture,
} from "../../../tests/support/jira-bulk-create-fixture.js";
import { asRecord } from "./atlassian-sync-classify.js";
import type { JiraPrepareCreate } from "./jira-create-preparation.js";
import {
  executeJiraBulkCreate as execute,
  type JiraBulkCreatePorts,
} from "./jira-managed-bulk-create.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

/** This fixture isolates orchestration/ACK behavior. Shared preparation integration is exercised
 * separately against the actual single-create owner; this stub is not a validation engine. */
function preparedPorts(): JiraBulkCreatePorts & {
  readonly prepare: ReturnType<typeof vi.fn<JiraPrepareCreate>>;
} {
  const prepare = vi.fn<JiraPrepareCreate>((args) => {
    const fields = asRecord(args.fields);
    if (fields === undefined) throw new TypeError("Synthetic prepared fields absent");
    return Promise.resolve({
      ok: true,
      projectId: "10000",
      issueTypeId: "3",
      body: { fields: { ...fields, project: { id: "10000" }, issuetype: { id: "3" } }, update: {} },
      metadata: [],
      values: { ok: true, fields, update: {} },
      plan: { inline: [], present: [], further: [] },
    });
  });
  return { prepare };
}
describe("one native bulk effect", () => {
  it("prepares every item then sends one POST and keeps ACK identities unconfirmed", async () => {
    const native = bulkCreateFixture();
    const ports = preparedPorts();
    expect(await execute("jira.create-issues", ARGS, native.request, ports)).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: RECEIPT,
    });
    expect(ports.prepare).toHaveBeenCalledTimes(2);
    expect(native.snapshot()).toEqual({ effects: 1 });
    expect(native.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
    expect(native.submitted()).toEqual({
      issueUpdates: [
        {
          fields: {
            summary: "First reviewed issue",
            project: { id: "10000" },
            issuetype: { id: "3" },
          },
          update: {},
        },
        {
          fields: {
            summary: "Second reviewed issue",
            project: { id: "10000" },
            issuetype: { id: "3" },
          },
          update: {},
        },
      ],
    });
  });
  it("keeps the check path read-only after preparing all items", async () => {
    const native = bulkCreateFixture();
    const ports = preparedPorts();
    expect(await execute("jira.create-issues", ARGS, native.request, ports, true)).toEqual({
      ok: true,
      receipt: {},
    });
    expect(ports.prepare).toHaveBeenCalledTimes(2);
    expect(native.snapshot()).toEqual({ effects: 0 });
  });
  it("refuses the whole batch before any write when a later existing-owner admission fails", async () => {
    const native = bulkCreateFixture();
    const ports = preparedPorts();
    const first = await ports.prepare(ARGS.issues[0], undefined);
    ports.prepare.mockClear();
    ports.prepare.mockResolvedValueOnce(first).mockResolvedValueOnce({
      ok: false,
      reason: "field-validation",
      detail: { messages: ["Current saved rule could not be evaluated"] },
    });
    expect(await execute("jira.create-issues", ARGS, native.request, ports)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(native.snapshot()).toEqual({ effects: 0 });
  });
  it("refuses further link effects instead of looping create/link POSTs", async () => {
    const native = bulkCreateFixture();
    const ports = preparedPorts();
    const first = await ports.prepare(ARGS.issues[0], undefined);
    if (!first.ok) throw new TypeError("Expected synthetic preparation");
    ports.prepare.mockResolvedValue({
      ...first,
      plan: {
        ...first.plan,
        further: [{ type: "Blocks", direction: "outward", issueKey: "SYN-3" }],
      },
    });
    expect(await execute("jira.create-issues", ARGS, native.request, ports)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(native.snapshot()).toEqual({ effects: 0 });
  });
  it("refuses duplicate normalized draft identities before dispatch", async () => {
    const native = bulkCreateFixture();
    const ports = preparedPorts();
    const first = await ports.prepare(ARGS.issues[0], undefined);
    const second = await ports.prepare(ARGS.issues[1], undefined);
    if (!first.ok || !second.ok) throw new TypeError("Expected synthetic preparation");
    ports.prepare.mockClear();
    ports.prepare
      .mockResolvedValueOnce({ ...first, draftIdentity: "same-native-draft" })
      .mockResolvedValueOnce({ ...second, draftIdentity: "same-native-draft" });
    expect(await execute("jira.create-issues", ARGS, native.request, ports)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(native.snapshot()).toEqual({ effects: 0 });
  });
  it("fails closed before HTTP for absent preparation or unresolvable explicit trace", async () => {
    const native = bulkCreateFixture();
    expect(await execute("jira.create-issues", ARGS, native.request, undefined)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(
      await execute(
        "jira.create-issues",
        { ...ARGS, requirementIds: ["REQ-1"] },
        native.request,
        preparedPorts(),
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(native.calls).toHaveLength(0);
  });
  it("passes only the already validated common trace to every prepared item", async () => {
    const native = bulkCreateFixture();
    const ports = preparedPorts();
    const trace = {
      labels: ["req-1"],
      footer: "Requirement",
      footerStart: "Start",
      footerEnd: "End",
      replaceLabelPrefixes: [],
    };
    expect(
      await execute(
        "jira.create-issues",
        { ...ARGS, requirementIds: ["REQ-1"] },
        native.request,
        { ...ports, trace },
        true,
      ),
    ).toEqual({ ok: true, receipt: {} });
    for (const [args, received] of ports.prepare.mock.calls) {
      expect(args.requirementIds).toEqual(["REQ-1"]);
      expect(received).toBe(trace);
    }
  });
  it("retains no guessed IDs after a lost ACK and never replays a subset", async () => {
    const native = bulkCreateFixture();
    native.controls.lostAck = true;
    expect(await execute("jira.create-issues", ARGS, native.request, preparedPorts())).toEqual({
      ok: false,
      reason: "timeout",
      receipt: { userKey: "synthetic-actor", requestedIssueCount: 2 },
    });
    expect(native.snapshot()).toEqual({ effects: 1 });
    expect(native.calls.at(-1)?.path).toBe("issue/bulk");
  });
  it("keeps known successes and literal native partial failures together", async () => {
    const native = bulkCreateFixture();
    native.setAcknowledgement({
      issues: [{ id: "10001", key: "SYN-1" }],
      errors: [
        { failedElementNumber: 1, status: 400, elementErrors: { errors: { summary: "Required" } } },
      ],
    });
    expect(
      await execute("jira.create-issues", ARGS, native.request, preparedPorts()),
    ).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: {
        userKey: "synthetic-actor",
        requestedIssueCount: 2,
        issueIds: ["10001"],
        issueKeys: ["SYN-1"],
        bulkFailedElementNumbers: [1],
        bulkFailureStatuses: [400],
      },
    });
    expect(native.snapshot()).toEqual({ effects: 1 });
  });
  it("preserves known receipt on denied readback and original programming failure", async () => {
    const denied = bulkCreateFixture();
    denied.controls.denyReadback = true;
    expect(
      await execute("jira.create-issues", ARGS, denied.request, preparedPorts()),
    ).toMatchObject({ ok: false, reason: "permission-denied", receipt: RECEIPT });
    const failed = bulkCreateFixture();
    failed.controls.throwReadback = true;
    try {
      await execute("jira.create-issues", ARGS, failed.request, preparedPorts());
      expect.fail("Expected acknowledged failure");
    } catch (error) {
      expect(error).toBeInstanceOf(JiraAcknowledgedMutationError);
      if (!(error instanceof JiraAcknowledgedMutationError)) throw error;
      expect(error.receipt).toEqual(RECEIPT);
      expect(error.cause).toBeInstanceOf(Error);
    }
    expect(failed.snapshot()).toEqual({ effects: 1 });
  });
  it("does not dispatch after a current actor change", async () => {
    const native = bulkCreateFixture();
    native.controls.actorChangesBefore = true;
    expect(
      await execute("jira.create-issues", ARGS, native.request, preparedPorts()),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(native.snapshot()).toEqual({ effects: 0 });
  });
});
