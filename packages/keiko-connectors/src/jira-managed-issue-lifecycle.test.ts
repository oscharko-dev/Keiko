import { describe, expect, it } from "vitest";
import {
  ISSUE_LIFECYCLE_FIXTURE_CASES as CASES,
  ISSUE_LIFECYCLE_REVIEW as ISSUE,
  ISSUE_LIFECYCLE_SUBTASKS as CHILDREN,
  issueLifecycleFixture,
} from "../../../tests/support/jira-issue-lifecycle-fixture.js";
import {
  executeJiraIssueLifecycleMutation as execute,
  isJiraIssueLifecycleMutation,
} from "./jira-managed-issue-lifecycle.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { jiraIssueDeletionAdmission } from "./jira-managed-issue-lifecycle.js";

describe("reviewed native issue lifecycle effects", () => {
  it.each(CASES)("keeps $name acknowledged consequences unconfirmed", async (selected) => {
    const native = issueLifecycleFixture(selected);
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "unavailable", receipt: selected.receipt },
    );
    expect(native.snapshot()).toMatchObject({ effects: 1 });
    const effect = native.calls.findIndex((call) => call.method !== "GET");
    expect(native.calls[effect]).toMatchObject({ path: selected.path, method: selected.method });
    expect(native.calls.slice(effect + 1).every((call) => call.method === "GET")).toBe(true);
    expect(native.calls.slice(effect + 1).some((call) => call.path === "myself")).toBe(true);
  });
  it.each(CASES)("checks $name without an effect", async (selected) => {
    const native = issueLifecycleFixture(selected);
    expect(await execute(selected.name, selected.args, native.request, native.ports, true)).toEqual(
      { ok: true, receipt: {} },
    );
    expect(native.snapshot()).toMatchObject({ effects: 0 });
    expect(native.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each(CASES)("never repeats $name after lost ACK", async (selected) => {
    const native = issueLifecycleFixture(selected);
    native.controls.lostAck = true;
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "timeout", receipt: selected.receipt },
    );
    expect(native.snapshot()).toMatchObject({ effects: 1 });
    expect(native.calls.at(-1)).toMatchObject({ path: selected.path, method: selected.method });
  });
  it.each(CASES)("retains $name context through denied readback", async (selected) => {
    const native = issueLifecycleFixture(selected);
    native.controls.denyReadback = true;
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "permission-denied", receipt: selected.receipt },
    );
    expect(native.snapshot()).toMatchObject({ effects: 1 });
  });
  it.each(CASES)(
    "does not reinterpret $name readback404 as completed absence",
    async (selected) => {
      const native = issueLifecycleFixture(selected);
      native.controls.missingReadback = true;
      expect(
        await execute(selected.name, selected.args, native.request, native.ports),
      ).toMatchObject({ ok: false, reason: "not-found", receipt: selected.receipt });
      expect(native.snapshot()).toMatchObject({ effects: 1 });
    },
  );
  it.each(CASES)("refuses actor drift before $name effect", async (selected) => {
    const native = issueLifecycleFixture(selected);
    native.controls.actorChangesBefore = true;
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "conflict" },
    );
    expect(native.snapshot()).toMatchObject({ effects: 0 });
  });
  it.each(CASES)("refuses changed current issue before $name effect", async (selected) => {
    const native = issueLifecycleFixture(selected);
    native.controls.issueDrift = true;
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "conflict" },
    );
    expect(native.snapshot()).toMatchObject({ effects: 0 });
  });
  it("preserves known receipt and original programming error after ACK", async () => {
    const selected = CASES[0];
    const native = issueLifecycleFixture(selected);
    native.controls.throwReadback = true;
    try {
      await execute(selected.name, selected.args, native.request, native.ports);
      expect.fail("Expected acknowledged error");
    } catch (error) {
      expect(error).toBeInstanceOf(JiraAcknowledgedMutationError);
      if (!(error instanceof JiraAcknowledgedMutationError)) throw error;
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.receipt).toEqual(selected.receipt);
      expect(Object.isFrozen(error.receipt.issueIds)).toBe(true);
    }
    expect(native.snapshot()).toMatchObject({ effects: 1 });
  });
});

describe("issue deletion and subtask boundaries", () => {
  it("composes the real deletion-impact owner and refuses surviving formal parent relations before DELETE", async () => {
    const parsed = parseJiraIssueTemplate(
      "---\nkeiko: jira-issue-template\nversion: 1\nproject: OTHER\nissueType: Task\nactivateOn: [edit]\nparentLink: Blocks\n---\n",
    );
    if (!parsed.ok) throw new TypeError("Expected synthetic formal rule");
    const selected = CASES[1];
    const native = issueLifecycleFixture(selected);
    const ports = jiraIssueDeletionAdmission(native.request, () => ({
      templates: [parsed.template],
      unreadable: 0,
    }));
    expect(await execute(selected.name, selected.args, native.request, ports)).toMatchObject({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "template-unreadable" }],
    });
    expect(native.calls.some((call) => call.method === "DELETE")).toBe(false);
  });
  it("fails closed before any request when the current deletion-rule owner is missing", async () => {
    const selected = CASES[1];
    const native = issueLifecycleFixture(selected);
    expect(await execute(selected.name, selected.args, native.request, undefined)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(native.calls).toHaveLength(0);
  });
  it("uses existing formal admission in check and execution without treating visible emptiness as relation completeness", async () => {
    for (const check of [true, false]) {
      const selected = CASES[1];
      const native = issueLifecycleFixture(selected);
      native.controls.formalRefusal = true;
      expect(
        await execute(selected.name, selected.args, native.request, native.ports, check),
      ).toMatchObject({ ok: false, reason: "field-validation" });
      expect(native.snapshot()).toEqual({ effects: 0, formalCalls: 1 });
    }
  });
  it("refuses observed children and never sends deleteSubtasks=true", async () => {
    const selected = CASES[1];
    const native = issueLifecycleFixture(selected);
    native.setSubtasks(CHILDREN);
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "conflict" },
    );
    expect(native.snapshot()).toMatchObject({ effects: 0, formalCalls: 0 });
    const injected = issueLifecycleFixture(selected);
    expect(
      await execute(
        selected.name,
        { ...selected.args, deleteSubtasks: true },
        injected.request,
        injected.ports,
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(injected.calls).toHaveLength(0);
  });
  it("retains native deletion refusal when a hidden or concurrent child exists", async () => {
    const selected = CASES[1];
    const native = issueLifecycleFixture(selected);
    native.controls.reject = true;
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "field-validation", receipt: selected.receipt },
    );
    expect(native.snapshot()).toMatchObject({ effects: 0 });
    expect(native.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });
  it("never evaluates the deletion impact for archive or restore", async () => {
    for (const selected of [CASES[0], CASES[2], CASES[3]]) {
      const native = issueLifecycleFixture(selected);
      native.controls.formalRefusal = true;
      expect(await execute(selected.name, selected.args, native.request, undefined, true)).toEqual({
        ok: true,
        receipt: {},
      });
      expect(native.snapshot()).toMatchObject({ formalCalls: 0 });
    }
  });
  it("requires explicit current native reorder availability", async () => {
    const selected = CASES[4];
    const native = issueLifecycleFixture(selected);
    native.controls.canMove = false;
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "unavailable" },
    );
    expect(native.snapshot()).toMatchObject({ effects: 0 });
  });
  it("refuses partial, reordered, duplicate or cross-parent child evidence", async () => {
    const selected = CASES[4];
    const candidates = [
      CHILDREN.slice(0, 1),
      [...CHILDREN].reverse(),
      [CHILDREN[0], CHILDREN[0]],
      [{ ...CHILDREN[0], fields: { parent: { id: "999", key: ISSUE.key } } }, CHILDREN[1]],
    ];
    for (const children of candidates) {
      const native = issueLifecycleFixture(selected);
      native.setSubtasks(children);
      expect(
        await execute(selected.name, selected.args, native.request, native.ports),
      ).toMatchObject({ ok: false });
      expect(native.snapshot()).toMatchObject({ effects: 0 });
    }
  });
  it("accepts comparison-only proxy self identities without following them", async () => {
    const selected = CASES[4];
    const native = issueLifecycleFixture(selected);
    native.setSubtasks(
      CHILDREN.map((child) => ({
        ...child,
        self: `http://proxy.invalid/context/rest/api/2/issue/${child.id}`,
        fields: { parent: { id: ISSUE.id, key: ISSUE.key } },
      })),
    );
    expect(await execute(selected.name, selected.args, native.request, native.ports, true)).toEqual(
      { ok: true, receipt: {} },
    );
    expect(native.calls.every((call) => !call.path.includes("proxy.invalid"))).toBe(true);
  });
  it("refuses literal parent changes, same positions, unsafe integers and request controls", async () => {
    const selected = CASES[4];
    for (const patch of [
      { parentId: "99" },
      { currentPosition: 1 },
      { currentPosition: 9007199254740992 },
      { currentPosition: -1 },
      { method: "PUT" },
      { headers: {} },
    ]) {
      const native = issueLifecycleFixture(selected);
      expect(
        await execute(selected.name, { ...selected.args, ...patch }, native.request, native.ports),
      ).toMatchObject({ ok: false, reason: "field-validation" });
      expect(native.calls).toHaveLength(0);
    }
  });
  it("refuses duplicate bulk issue identities and unreviewed notification suppression", async () => {
    for (const patch of [
      { expectedIssues: [ISSUE, ISSUE] },
      { notifyUsers: false },
      { confirmUnverifiedEffect: false },
    ]) {
      const selected = CASES[0];
      const native = issueLifecycleFixture(selected);
      expect(
        await execute(selected.name, { ...selected.args, ...patch }, native.request, native.ports),
      ).toMatchObject({ ok: false, reason: "field-validation" });
      expect(native.calls).toHaveLength(0);
    }
    expect(isJiraIssueLifecycleMutation("jira.reparent-subtask")).toBe(false);
  });
});
