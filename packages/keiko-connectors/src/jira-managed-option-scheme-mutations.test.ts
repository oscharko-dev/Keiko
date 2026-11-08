import { describe, expect, it } from "vitest";
import { executeJiraOptionSchemeMutation } from "./jira-managed-option-scheme-mutations.js";
import {
  OPTION_SCHEME_MUTATION_CASES,
  ISSUE_SCHEME_REVIEW,
  PRIORITY_SCHEME_REVIEW,
  optionSchemeFixture,
} from "../../../tests/support/jira-option-scheme-fixture.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

describe("native issue-type and priority scheme mutation admission", () => {
  it.each(OPTION_SCHEME_MUTATION_CASES)(
    "binds $tool before exactly one native effect and independent readback",
    async (scenario) => {
      const native = optionSchemeFixture();
      const result = await executeJiraOptionSchemeMutation(
        scenario.tool,
        scenario.args,
        native.request,
      );
      expect(result).toMatchObject({ ok: scenario.confirmed, receipt: scenario.receipt });
      if (!scenario.confirmed) expect(result).toMatchObject({ reason: "unavailable" });
      const effects = native.calls.filter(({ method }) => method !== "GET");
      expect(effects).toEqual([
        {
          path: scenario.path,
          method: scenario.method,
          ...(scenario.body === undefined ? {} : { body: scenario.body }),
        },
      ]);
      const index = native.calls.findIndex(({ method }) => method !== "GET");
      expect(native.calls.slice(index + 1).some(({ method }) => method === "GET")).toBe(true);
    },
  );
  it.each(OPTION_SCHEME_MUTATION_CASES)(
    "performs no effect while checking $tool",
    async (scenario) => {
      const native = optionSchemeFixture();
      expect(
        await executeJiraOptionSchemeMutation(scenario.tool, scenario.args, native.request, true),
      ).toEqual({ ok: true, receipt: {} });
      expect(native.calls.every(({ method }) => method === "GET")).toBe(true);
    },
  );
  it.each(OPTION_SCHEME_MUTATION_CASES)(
    "keeps $tool uncertain after losing its ACK without a retry or guessed ID",
    async (scenario) => {
      const native = optionSchemeFixture();
      native.controls.lostAck = true;
      const result = await executeJiraOptionSchemeMutation(
        scenario.tool,
        scenario.args,
        native.request,
      );
      expect(result).toMatchObject({
        ok: false,
        reason: "timeout",
        receipt: { userKey: "synthetic-actor" },
      });
      expect(native.calls.filter(({ method }) => method !== "GET")).toHaveLength(1);
      expect(native.calls.at(-1)?.method).toBe(scenario.method);
      if (scenario.tool.startsWith("jira.create-"))
        expect(result.receipt).not.toHaveProperty("schemeId");
      else expect(result.receipt).toMatchObject(scenario.receipt);
    },
  );
  it.each(OPTION_SCHEME_MUTATION_CASES)(
    "retains $tool's known target when post-ACK observation is denied",
    async (scenario) => {
      const native = optionSchemeFixture();
      native.controls.denyReadback = true;
      expect(
        await executeJiraOptionSchemeMutation(scenario.tool, scenario.args, native.request),
      ).toMatchObject({ ok: false, reason: "permission-denied", receipt: scenario.receipt });
      expect(native.calls.filter(({ method }) => method !== "GET")).toHaveLength(1);
    },
  );
  it.each(OPTION_SCHEME_MUTATION_CASES)(
    "preserves $tool's receipt on a post-ACK programming exception",
    async (scenario) => {
      const native = optionSchemeFixture();
      native.controls.throwReadback = true;
      await expect(
        executeJiraOptionSchemeMutation(scenario.tool, scenario.args, native.request),
      ).rejects.toBeInstanceOf(JiraAcknowledgedMutationError);
      expect(native.calls.filter(({ method }) => method !== "GET")).toHaveLength(1);
    },
  );
  it.each([200, 202, 204])(
    "uses readable %s ACK only to start independent known-target reads",
    async (status) => {
      const scenario = OPTION_SCHEME_MUTATION_CASES[1];
      const native = optionSchemeFixture();
      native.controls.ackStatus = status;
      expect(
        await executeJiraOptionSchemeMutation(scenario.tool, scenario.args, native.request),
      ).toMatchObject({ ok: true, receipt: scenario.receipt });
    },
  );
  it.each([0, 1, 7, 8])(
    "withholds confirmation for changed configuration after ACK in case %s",
    async (index) => {
      const scenario = OPTION_SCHEME_MUTATION_CASES[index];
      if (scenario === undefined) throw new TypeError("Missing configuration fixture");
      const native = optionSchemeFixture();
      native.controls.wrongReadback = true;
      expect(
        await executeJiraOptionSchemeMutation(scenario.tool, scenario.args, native.request),
      ).toMatchObject({
        ok: false,
        reason: "unavailable",
        receipt: scenario.receipt,
      });
      expect(native.calls.filter(({ method }) => method !== "GET")).toHaveLength(1);
    },
  );
  it.each([0, 7])("requires a real new native ID for creation case %s", async (index) => {
    const scenario = OPTION_SCHEME_MUTATION_CASES[index];
    if (scenario === undefined) throw new TypeError("Missing creation fixture");
    const native = optionSchemeFixture();
    native.controls.omitAckId = true;
    const result = await executeJiraOptionSchemeMutation(
      scenario.tool,
      scenario.args,
      native.request,
    );
    expect(result).toMatchObject({
      ok: false,
      receipt: { userKey: "synthetic-actor", schemePresent: true },
    });
    expect(result.receipt).not.toHaveProperty("schemeId");
    expect(native.calls.at(-1)?.method).toBe("POST");
  });
  it.each(["description", "defaultIssueType", "issueTypes"])(
    "does not turn missing %s into a reviewed empty value",
    async (field) => {
      const scenario = OPTION_SCHEME_MUTATION_CASES[1];
      const native = optionSchemeFixture();
      const scheme = native.issueSchemes.get("7");
      if (scheme === undefined) throw new TypeError("Missing scheme");
      delete scheme[field];
      expect(
        await executeJiraOptionSchemeMutation(scenario.tool, scenario.args, native.request),
      ).toMatchObject({ ok: false });
      expect(native.calls.every(({ method }) => method === "GET")).toBe(true);
    },
  );
  it.each([
    { ...ISSUE_SCHEME_REVIEW, issueTypeIds: ["2", "1"] },
    { ...ISSUE_SCHEME_REVIEW, defaultIssueTypeId: "2" },
  ])(
    "refuses a stale observed default or reordered review before writing",
    async (expectedScheme) => {
      const scenario = OPTION_SCHEME_MUTATION_CASES[1];
      const native = optionSchemeFixture();
      expect(
        await executeJiraOptionSchemeMutation(
          scenario.tool,
          { ...scenario.args, expectedScheme },
          native.request,
        ),
      ).toMatchObject({ ok: false, reason: "conflict" });
      expect(native.calls.every(({ method }) => method === "GET")).toBe(true);
    },
  );
  it("requires the selected option IDs to exist natively instead of interpreting names as IDs", async () => {
    const scenario = OPTION_SCHEME_MUTATION_CASES[0];
    const native = optionSchemeFixture();
    expect(
      await executeJiraOptionSchemeMutation(
        scenario.tool,
        { ...scenario.args, issueTypeIds: ["99"], defaultIssueTypeId: "99" },
        native.request,
      ),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(native.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it("refuses a changed connected actor before scheme observation or effects", async () => {
    const scenario = OPTION_SCHEME_MUTATION_CASES[0];
    const native = optionSchemeFixture();
    native.actor.key = "different-actor";
    expect(
      await executeJiraOptionSchemeMutation(scenario.tool, scenario.args, native.request),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(native.calls).toEqual([{ path: "myself", method: "GET" }]);
  });
  it("does not delete the observed global default priority scheme", async () => {
    const scenario = OPTION_SCHEME_MUTATION_CASES[9];
    const native = optionSchemeFixture();
    const current = native.prioritySchemes.get("9");
    if (current === undefined) throw new TypeError("Missing priority scheme");
    current.defaultScheme = true;
    expect(
      await executeJiraOptionSchemeMutation(
        scenario.tool,
        { ...scenario.args, expectedScheme: { ...PRIORITY_SCHEME_REVIEW, defaultScheme: true } },
        native.request,
      ),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(native.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it("keeps an unavailable association collection distinct from [] before any effect", async () => {
    const scenario = OPTION_SCHEME_MUTATION_CASES[3];
    const native = optionSchemeFixture();
    native.controls.missingAssociations = true;
    expect(
      await executeJiraOptionSchemeMutation(scenario.tool, scenario.args, native.request),
    ).toMatchObject({ ok: false });
    expect(native.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it("binds each reviewed project by numeric ID, key and name before association", async () => {
    const scenario = OPTION_SCHEME_MUTATION_CASES[3];
    const native = optionSchemeFixture();
    const project = native.projects.get("10001");
    if (project === undefined) throw new TypeError("Missing project");
    project.key = "MOVED";
    expect(
      await executeJiraOptionSchemeMutation(scenario.tool, scenario.args, native.request),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(native.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it("distinguishes append, replacement and removal while withholding global consequence confirmation", async () => {
    const expected = [["10000", "10001"], ["10001"], [], []];
    for (const [index, scenario] of OPTION_SCHEME_MUTATION_CASES.slice(3, 7).entries()) {
      const native = optionSchemeFixture();
      expect(
        await executeJiraOptionSchemeMutation(scenario.tool, scenario.args, native.request),
      ).toMatchObject({ ok: false, reason: "unavailable" });
      expect(native.snapshot().associations).toEqual(expected[index]);
    }
  });
  it("reports a matching scheme as unchanged without rewriting it", async () => {
    const native = optionSchemeFixture();
    expect(
      await executeJiraOptionSchemeMutation(
        "jira.update-issue-type-scheme",
        {
          expectedActorKey: "synthetic-actor",
          expectedScheme: ISSUE_SCHEME_REVIEW,
          name: ISSUE_SCHEME_REVIEW.name,
          description: ISSUE_SCHEME_REVIEW.description,
          issueTypeIds: ISSUE_SCHEME_REVIEW.issueTypeIds,
          defaultIssueTypeId: ISSUE_SCHEME_REVIEW.defaultIssueTypeId,
        },
        native.request,
      ),
    ).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true } });
    expect(native.calls.every(({ method }) => method === "GET")).toBe(true);
  });
  it("refuses unknown argument routes without reading or dispatching", async () => {
    const scenario = OPTION_SCHEME_MUTATION_CASES[0];
    const native = optionSchemeFixture();
    expect(
      await executeJiraOptionSchemeMutation(
        scenario.tool,
        { ...scenario.args, url: "https://untrusted.invalid/" },
        native.request,
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(native.calls).toEqual([]);
  });
});
