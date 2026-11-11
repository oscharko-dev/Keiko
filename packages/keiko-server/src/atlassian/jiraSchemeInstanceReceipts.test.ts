import { describe, expect, it, vi } from "vitest";
import {
  JIRA_OPTION_SCHEME_MUTATIONS,
  JIRA_WORKFLOW_SCHEME_MUTATIONS,
  JIRA_INSTANCE_SETTING_MUTATIONS,
  JIRA_EMAIL_TEMPLATE_MUTATIONS,
  JIRA_ATTACHMENT_MAX_BYTES,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { OPTION_SCHEME_MUTATION_CASES } from "../../../../tests/support/jira-option-scheme-fixture.js";
import { WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES } from "../../../../tests/support/jira-workflow-scheme-mutation-fixture.js";
import { INSTANCE_SETTING_FIXTURE_CASES } from "../../../../tests/support/jira-instance-setting-mutation-fixture.js";
import { validJiraMutationAttempt, jiraAttemptToolResult } from "./jiraMutationResult.js";
import {
  validJiraSchemeInstanceReceipt as valid,
  canConfirmJiraSchemeInstance,
  type JiraSchemeInstanceOperation,
} from "./jiraSchemeInstanceReceipts.js";

const EMAIL_CASES = [
  {
    operation: "jira.upload-email-template-pack",
    receipt: {
      userKey: "actor",
      emailTemplateAction: "upload",
      uploadSha256: "a".repeat(64),
      uploadBytes: 50,
    },
    confirm: false,
  },
  {
    operation: "jira.apply-email-template-pack",
    receipt: {
      userKey: "actor",
      emailTemplateAction: "apply",
      priorManifestSha256: "b".repeat(64),
    },
    confirm: false,
  },
  {
    operation: "jira.revert-email-template-pack",
    receipt: {
      userKey: "actor",
      emailTemplateAction: "revert",
      priorManifestSha256: "b".repeat(64),
      observedManifestSha256: "c".repeat(64),
    },
    confirm: false,
  },
] as const;
const CASES: readonly {
  operation: JiraSchemeInstanceOperation;
  receipt: JiraMutationReceipt;
  confirm: boolean;
}[] = [
  ...OPTION_SCHEME_MUTATION_CASES.map(({ tool, receipt, confirmed }) => ({
    operation: tool,
    receipt,
    confirm: confirmed,
  })),
  ...WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES.map(({ name, receipt, confirmed }) => ({
    operation: name,
    receipt,
    confirm: confirmed,
  })),
  ...INSTANCE_SETTING_FIXTURE_CASES.map(({ name, receipt, confirmed }) => ({
    operation: name,
    receipt,
    confirm: confirmed,
  })),
  ...EMAIL_CASES,
];
function changed(
  receipt: JiraMutationReceipt,
  key: PropertyKey,
  value: unknown,
): JiraMutationReceipt {
  const copy = { ...receipt };
  Object.defineProperty(copy, key, { value, enumerable: true, configurable: true });
  return copy;
}
function refused(receipt: JiraMutationReceipt, operation: JiraSchemeInstanceOperation): void {
  expect(valid(receipt, operation)).toBe(false);
  expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
    ok: false,
    reason: "malformed-payload",
  });
  expect(
    validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation),
  ).not.toHaveProperty("receipt");
}
describe("scheme and instance configuration receipt evidence", () => {
  it("pins all thirty-five closed operations independently", () => {
    expect(CASES.map(({ operation }) => operation).sort()).toEqual(
      [
        ...JIRA_OPTION_SCHEME_MUTATIONS,
        ...JIRA_WORKFLOW_SCHEME_MUTATIONS,
        ...JIRA_INSTANCE_SETTING_MUTATIONS,
        ...JIRA_EMAIL_TEMPLATE_MUTATIONS,
      ].sort(),
    );
  });
  it.each(CASES)(
    "retains $operation context without upgrading global consequences",
    ({ operation, receipt, confirm }) => {
      expect(valid(receipt, operation)).toBe(true);
      expect(canConfirmJiraSchemeInstance(operation, receipt)).toBe(confirm);
      expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual(
        confirm ? { ok: true, receipt } : { ok: false, reason: "malformed-payload", receipt },
      );
      for (const outcome of ["unknown", "succeeded-unconfirmed"] as const) {
        const retained = validJiraMutationAttempt(
          { ok: false, reason: "timeout", receipt },
          operation,
        );
        const stored = JSON.parse(
          JSON.stringify(jiraAttemptToolResult(outcome, retained)),
        ) as unknown;
        expect(stored).toMatchObject({ isError: true, data: { outcome, ...receipt } });
      }
    },
  );
  it.each(CASES)(
    "rejects hidden, inherited, accessor and foreign $operation context before copying",
    ({ operation, receipt }) => {
      for (const key of [
        "browseUrl",
        "baseUrl",
        "value",
        "published",
        "migrationCompleted",
        "entries",
        Symbol("foreign"),
      ])
        refused(changed(receipt, key, "synthetic"), operation);
      for (const key of Object.keys(receipt)) {
        const hidden = { ...receipt };
        Object.defineProperty(hidden, key, { value: Reflect.get(receipt, key), enumerable: false });
        refused(hidden, operation);
        const getter = vi.fn(() => Reflect.get(receipt, key) as unknown);
        const accessor = { ...receipt };
        Object.defineProperty(accessor, key, { get: getter, enumerable: true });
        refused(accessor, operation);
        expect(getter).not.toHaveBeenCalled();
        const inherited = { ...receipt };
        Reflect.deleteProperty(inherited, key);
        Object.setPrototypeOf(inherited, { [key]: Reflect.get(receipt, key) as unknown });
        refused(inherited, operation);
      }
    },
  );
  it.each([
    {
      operation: "jira.create-issue-type-scheme",
      receipt: { userKey: "actor", schemePresent: true },
    },
    {
      operation: "jira.create-priority-scheme",
      receipt: { userKey: "actor", schemePresent: true },
    },
    {
      operation: "jira.create-workflow-scheme",
      receipt: { userKey: "actor", schemePresent: true, workflowSchemeScope: "scheme" },
    },
    {
      operation: "jira.create-workflow-scheme-draft",
      receipt: {
        userKey: "actor",
        schemeId: "37",
        schemePresent: true,
        workflowSchemeScope: "draft",
      },
    },
  ] as const)(
    "retains only known context after missing $operation ACK identity",
    ({ operation, receipt }) => {
      expect(valid(receipt, operation)).toBe(true);
      expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
        ok: false,
        reason: "malformed-payload",
        receipt,
      });
      expect(
        validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation),
      ).toEqual({ ok: false, reason: "timeout", receipt });
      refused(changed(receipt, "userKey", undefined), operation);
    },
  );
  it("requires known parent/draft identities while accepting exact int64 maximum", () => {
    const draft = WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES[4].receipt;
    expect(
      valid(
        { ...draft, schemeId: "9223372036854775807", draftSchemeId: "9223372036854775807" },
        "jira.update-workflow-scheme-draft",
      ),
    ).toBe(true);
    // Equality is not guessed invalid: native observations define the distinct ID meanings.
    for (const key of ["schemeId", "draftSchemeId"] as const) {
      const missing = { ...draft };
      Reflect.deleteProperty(missing, key);
      refused(missing, "jira.update-workflow-scheme-draft");
      for (const value of ["0", "01", "9223372036854775808", 9007199254740992, null])
        refused(changed(draft, key, value), "jira.update-workflow-scheme-draft");
    }
  });
  it("requires explicit metadata-only evidence for current base-update success, retaining legacy and uncertain context", () => {
    const metadata = WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES[1].receipt;
    const legacy = { ...metadata };
    Reflect.deleteProperty(legacy, "workflowMappingChanged");
    for (const receipt of [legacy, { ...metadata, workflowMappingChanged: true }]) {
      expect(valid(receipt, "jira.update-workflow-scheme")).toBe(true);
      expect(canConfirmJiraSchemeInstance("jira.update-workflow-scheme", receipt)).toBe(false);
      expect(
        validJiraMutationAttempt({ ok: true, receipt }, "jira.update-workflow-scheme"),
      ).toEqual({ ok: false, reason: "malformed-payload", receipt });
      expect(
        validJiraMutationAttempt(
          { ok: false, reason: "unavailable", receipt },
          "jira.update-workflow-scheme",
        ),
      ).toEqual({ ok: false, reason: "unavailable", receipt });
    }
    expect(
      validJiraMutationAttempt({ ok: true, receipt: metadata }, "jira.update-workflow-scheme"),
    ).toEqual({ ok: true, receipt: metadata });
    refused(changed(metadata, "workflowMappingChanged", "false"), "jira.update-workflow-scheme");
    refused(
      { ...WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES[4].receipt, workflowMappingChanged: false },
      "jira.update-workflow-scheme-draft",
    );
    const getter = vi.fn(() => false);
    const accessor = { ...metadata };
    Object.defineProperty(accessor, "workflowMappingChanged", { get: getter, enumerable: true });
    refused(accessor, "jira.update-workflow-scheme");
    expect(getter).not.toHaveBeenCalled();
  });
  it("keeps base, draft, requested mapping presence and whole deletion distinct", () => {
    const draft = WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES[16].receipt;
    expect(
      valid({ ...draft, mappingPresent: false }, "jira.set-workflow-scheme-draft-workflow"),
    ).toBe(true);
    refused(
      changed(draft, "workflowSchemeScope", "published"),
      "jira.set-workflow-scheme-draft-workflow",
    );
    refused(
      changed(draft, "workflowSchemeScope", "scheme"),
      "jira.set-workflow-scheme-draft-workflow",
    );
    refused(
      changed(WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES[8].receipt, "mappingPresent", false),
      "jira.set-workflow-scheme-draft-default",
    );
    refused(
      changed(WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES[5].receipt, "schemePresent", true),
      "jira.delete-workflow-scheme-draft",
    );
    refused(
      changed(WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES[7].receipt, "workflowName", "Fallback"),
      "jira.delete-workflow-scheme-default",
    );
  });
  it("checks paired project arrays, exact selected cardinality and key namespaces", () => {
    const association = OPTION_SCHEME_MUTATION_CASES[3].receipt;
    refused(
      { ...association, projectIds: ["10001", "10001"], projectKeys: ["OTHER", "SECOND"] },
      "jira.add-issue-type-scheme-projects",
    );
    refused(
      { ...association, projectIds: ["10001", "10002"], projectKeys: ["OTHER", "other"] },
      "jira.add-issue-type-scheme-projects",
    );
    refused({ ...association, projectKeys: [] }, "jira.add-issue-type-scheme-projects");
    refused(
      { ...association, projectIds: [], projectKeys: [] },
      "jira.add-issue-type-scheme-projects",
    );
    refused({ ...association, associationChange: "clear" }, "jira.add-issue-type-scheme-projects");
    expect(
      valid(
        { ...association, projectIds: [], projectKeys: [], associationChange: "replace" },
        "jira.set-issue-type-scheme-projects",
      ),
    ).toBe(true);
    refused(
      { ...OPTION_SCHEME_MUTATION_CASES[6].receipt, projectIds: [], projectKeys: [] },
      "jira.remove-issue-type-scheme-project",
    );
  });
  it("copies project and column arrays for both successes and partial outcomes", () => {
    const columnIds = ["summary", "issuekey", "summary"];
    const columns = validJiraMutationAttempt(
      { ok: true, receipt: { userKey: "actor", columnIds } },
      "jira.set-system-columns",
    );
    const projectIds = ["10001"];
    const projectKeys = ["OTHER"];
    const association = validJiraMutationAttempt(
      {
        ok: false,
        reason: "timeout",
        receipt: { ...OPTION_SCHEME_MUTATION_CASES[3].receipt, projectIds, projectKeys },
      },
      "jira.add-issue-type-scheme-projects",
    );
    columnIds.reverse();
    columnIds[0] = "other";
    projectIds[0] = "99";
    projectKeys[0] = "CHANGED";
    expect(columns.receipt?.columnIds).toEqual(["summary", "issuekey", "summary"]);
    expect(association.receipt).toMatchObject({ projectIds: ["10001"], projectKeys: ["OTHER"] });
    expect(Object.isFrozen(columns.receipt?.columnIds)).toBe(true);
    expect(Object.isFrozen(association.receipt?.projectIds)).toBe(true);
    expect(Object.isFrozen(association.receipt?.projectKeys)).toBe(true);
  });
  it("refuses unsafe array descriptors and oversized complete receipts without invoking getters", () => {
    const source = INSTANCE_SETTING_FIXTURE_CASES[1].receipt;
    const getter = vi.fn(() => "summary");
    const accessor = ["summary"];
    Object.defineProperty(accessor, "0", { get: getter, enumerable: true });
    refused(changed(source, "columnIds", accessor), "jira.set-system-columns");
    expect(getter).not.toHaveBeenCalled();
    const hidden = ["summary"];
    Object.defineProperty(hidden, "0", { value: "summary", enumerable: false });
    refused(changed(source, "columnIds", hidden), "jira.set-system-columns");
    const extra = ["summary"];
    Object.defineProperty(extra, Symbol("foreign"), { value: true });
    refused(changed(source, "columnIds", extra), "jira.set-system-columns");
    const hole = new Array<string>(1);
    refused(changed(source, "columnIds", hole), "jira.set-system-columns");
    refused(
      { ...source, columnIds: Array.from({ length: 100 }, () => "x".repeat(255)) },
      "jira.set-system-columns",
    );
    refused({ ...source, columnIds: [] }, "jira.set-system-columns");
  });
  it("retains false configuration targets and only closed nonsecret property digests", () => {
    expect(valid({ userKey: "actor", readOnlyEnabled: false }, "jira.set-read-only-mode")).toBe(
      true,
    );
    const property = INSTANCE_SETTING_FIXTURE_CASES[0].receipt;
    refused({ ...property, propertyKey: "jira.home" }, "jira.set-application-property");
    refused({ ...property, valueDigest: "A".repeat(64) }, "jira.set-application-property");
    refused(changed(property, "value", false), "jira.set-application-property");
    refused({ userKey: "\ud800", readOnlyEnabled: true }, "jira.set-read-only-mode");
  });
  it("preserves an explicit reviewed pre-effect no-op without declaring an acknowledged global effect confirmed", () => {
    const receipt = INSTANCE_SETTING_FIXTURE_CASES[2].receipt;
    expect(
      validJiraMutationAttempt(
        { ok: false, reason: "conflict", detail: { unchanged: true }, receipt },
        "jira.set-instance-base-url",
      ),
    ).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true }, receipt });
    expect(validJiraMutationAttempt({ ok: true, receipt }, "jira.set-instance-base-url")).toEqual({
      ok: false,
      reason: "malformed-payload",
      receipt,
    });
  });
  it("never turns an email upload or observed active digest into confirmed staging/application", () => {
    const upload = EMAIL_CASES[0].receipt;
    expect(
      valid(
        { ...upload, uploadBytes: JIRA_ATTACHMENT_MAX_BYTES },
        "jira.upload-email-template-pack",
      ),
    ).toBe(true);
    for (const uploadBytes of [0, -1, 1.5, JIRA_ATTACHMENT_MAX_BYTES + 1])
      refused({ ...upload, uploadBytes }, "jira.upload-email-template-pack");
    refused(
      changed(upload, "observedManifestSha256", "c".repeat(64)),
      "jira.upload-email-template-pack",
    );
    refused(changed(upload, "emailTemplateAction", "apply"), "jira.upload-email-template-pack");
    refused(
      changed(EMAIL_CASES[1].receipt, "observedManifestSha256", null),
      "jira.apply-email-template-pack",
    );
    expect(
      validJiraMutationAttempt(
        { ok: true, receipt: EMAIL_CASES[2].receipt },
        "jira.revert-email-template-pack",
      ),
    ).toMatchObject({ ok: false, receipt: EMAIL_CASES[2].receipt });
  });
});
