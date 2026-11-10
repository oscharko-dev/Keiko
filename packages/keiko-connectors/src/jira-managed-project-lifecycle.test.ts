import { describe, expect, it } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  PROJECT_LIFECYCLE_FIXTURE_CASES as CASES,
  PROJECT_LIFECYCLE_REVIEW as PROJECT,
  PROJECT_PRIORITY_REVIEW,
  projectLifecycleFixture,
} from "../../../tests/support/jira-project-lifecycle-fixture.js";
import { executeJiraProjectLifecycleMutation as execute } from "./jira-managed-project-lifecycle.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { safeSchemeBodyId } from "./jira-project-lifecycle-values.js";

describe("one reviewed project lifecycle effect", () => {
  it.each(CASES)("keeps $name aggregate consequences unconfirmed", async (selected) => {
    const native = projectLifecycleFixture(selected);
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "unavailable", receipt: selected.receipt },
    );
    expect(native.snapshot().effects).toBe(1);
    expect(native.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  });
  it.each(CASES)("checks $name without a native write", async (selected) => {
    const native = projectLifecycleFixture(selected);
    expect(await execute(selected.name, selected.args, native.request, native.ports, true)).toEqual(
      { ok: true, receipt: {} },
    );
    expect(native.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each(CASES)("retains $name known context after lost ACK without retry", async (selected) => {
    const native = projectLifecycleFixture(selected);
    native.controls.lostAck = true;
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "timeout", receipt: selected.receipt },
    );
    expect(native.calls.at(-1)?.path).toBe(selected.path);
    expect(native.snapshot().effects).toBe(1);
  });
  it.each(CASES)("keeps $name denied or missing readback uncertain", async (selected) => {
    for (const control of ["denyReadback", "missingReadback"] as const) {
      const native = projectLifecycleFixture(selected);
      native.controls[control] = true;
      expect(
        await execute(selected.name, selected.args, native.request, native.ports),
      ).toMatchObject({
        ok: false,
        reason: control === "denyReadback" ? "permission-denied" : "not-found",
        receipt: selected.receipt,
      });
      expect(native.snapshot().effects).toBe(1);
    }
  });
  it.each(CASES)("refuses current actor drift before $name", async (selected) => {
    const native = projectLifecycleFixture(selected);
    native.controls.actorChanged = true;
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "conflict" },
    );
    expect(native.snapshot().effects).toBe(0);
  });
  it("preserves known receipt when an ACK is followed by a programming exception", async () => {
    const selected = CASES[1];
    const native = projectLifecycleFixture(selected);
    native.controls.throwReadback = true;
    try {
      await execute(selected.name, selected.args, native.request, native.ports);
      expect.fail("Expected acknowledged error");
    } catch (error) {
      expect(error).toBeInstanceOf(JiraAcknowledgedMutationError);
      if (!(error instanceof JiraAcknowledgedMutationError)) throw error;
      expect(error.receipt).toEqual(selected.receipt);
    }
  });
  it("never starts restoration's separately required reindex", async () => {
    const selected = CASES[2];
    const native = projectLifecycleFixture(selected);
    const result = await execute(selected.name, selected.args, native.request, native.ports);
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(result.ok ? undefined : result.detail?.messages?.[0]).toContain("required reindex");
    expect(native.calls.some((call) => call.path.startsWith("reindex"))).toBe(false);
  });
});
describe("current project and association prerequisites", () => {
  it("admits the reviewed native default permission scheme without allowing zero priority IDs", async () => {
    const selected = CASES[4];
    const native = projectLifecycleFixture(selected);
    const target = { id: "0", name: "Default Permission Scheme", description: "", permissions: [] };
    native.permission.set("0", target);
    expect(
      await execute(
        selected.name,
        { ...selected.args, scheme: target },
        native.request,
        native.ports,
        true,
      ),
    ).toEqual({ ok: true, receipt: {} });
    expect(native.snapshot().effects).toBe(0);
    expect(safeSchemeBodyId("0", true)).toBe(0);
    expect(safeSchemeBodyId("0")).toBeUndefined();
  });
  it("does not infer an omitted/null archived boolean", async () => {
    for (const archived of [undefined, null, "false"]) {
      const selected = CASES[1];
      const native = projectLifecycleFixture(selected);
      native.project.archived = archived;
      expect(
        await execute(selected.name, selected.args, native.request, native.ports),
      ).toMatchObject({ ok: false, reason: "unavailable" });
      expect(native.snapshot().effects).toBe(0);
    }
  });
  it("requires observed prior type and accessible new type", async () => {
    const selected = CASES[3];
    const native = projectLifecycleFixture(selected);
    native.controls.inaccessibleType = true;
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "permission-denied" },
    );
    const project = {
      id: PROJECT.id,
      key: PROJECT.key,
      name: PROJECT.name,
      archived: PROJECT.archived,
    };
    const absent = projectLifecycleFixture(selected);
    expect(
      await execute(
        selected.name,
        { ...selected.args, expectedProject: project },
        absent.request,
        absent.ports,
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(absent.calls).toHaveLength(0);
  });
  it("uses global surviving-reference formal admission for project deletion", async () => {
    const parsed = parseJiraIssueTemplate(
      "---\nkeiko: jira-issue-template\nversion: 1\nproject: OTHER\nissueType: Task\nactivateOn: [edit]\nparentLink: Blocks\n---\n",
    );
    if (!parsed.ok) throw new TypeError("Expected synthetic formal rule");
    const selected = CASES[0];
    const native = projectLifecycleFixture(selected);
    expect(
      await execute(selected.name, selected.args, native.request, native.ports, false, () => ({
        templates: [parsed.template],
        unreadable: 0,
      })),
    ).toMatchObject({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "template-unreadable" }],
    });
    expect(native.snapshot().effects).toBe(0);
  });
  it("refuses absent priority composition before any native request", async () => {
    const selected = CASES[5];
    const native = projectLifecycleFixture(selected);
    expect(await execute(selected.name, selected.args, native.request, undefined)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(native.calls).toHaveLength(0);
  });
  it("refuses reassigned source schemes and unreviewed grants", async () => {
    const selected = CASES[4];
    const native = projectLifecycleFixture(selected);
    native.controls.wrongAssociation = true;
    expect(await execute(selected.name, selected.args, native.request, native.ports)).toMatchObject(
      { ok: false, reason: "conflict" },
    );
    const changed = projectLifecycleFixture(selected);
    const scheme = changed.permission.get("8");
    if (scheme === undefined) throw new TypeError("Missing fixture scheme");
    scheme.permissions = [];
    expect(
      await execute(selected.name, selected.args, changed.request, changed.ports),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(changed.snapshot().effects).toBe(0);
  });
  it("refuses native default priority removal and unsafe numeric target IDs", async () => {
    const selected = CASES[6];
    const native = projectLifecycleFixture(selected);
    const scheme = native.priority.get("9");
    if (scheme === undefined) throw new TypeError("Missing fixture scheme");
    scheme.defaultScheme = true;
    expect(
      await execute(
        selected.name,
        { ...selected.args, expectedScheme: { ...PROJECT_PRIORITY_REVIEW, defaultScheme: true } },
        native.request,
        native.ports,
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    const assignment = CASES[5];
    const unsafe = projectLifecycleFixture(assignment);
    expect(
      await execute(
        assignment.name,
        { ...assignment.args, scheme: { ...PROJECT_PRIORITY_REVIEW, id: "9223372036854775807" } },
        unsafe.request,
        unsafe.ports,
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(unsafe.calls).toHaveLength(0);
  });
  it("reports an exact observed archive no-op without claiming global completion", async () => {
    const selected = CASES[1];
    const native = projectLifecycleFixture(selected);
    native.project.archived = true;
    expect(
      await execute(
        selected.name,
        { ...selected.args, expectedProject: { ...PROJECT, archived: true } },
        native.request,
        native.ports,
      ),
    ).toMatchObject({
      ok: false,
      reason: "conflict",
      detail: { unchanged: true },
      receipt: selected.receipt,
    });
    expect(native.snapshot().effects).toBe(0);
  });
});
