import { describe, expect, it, vi } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import {
  executeJiraComponentDelete,
  isJiraComponentDelete,
} from "./jira-managed-component-delete.js";
import {
  executeJiraVersionLifecycleMutation,
  isJiraVersionLifecycleMutation,
} from "./jira-managed-version-lifecycle.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import {
  RELEASE_FIXTURE_ACTOR as ACTOR,
  RELEASE_FIXTURE_PROJECT as PROJECT,
  RELEASE_FIXTURE_VERSION as VERSION,
  RELEASE_FIXTURE_COMPONENT as COMPONENT,
  RELEASE_FIXTURE_BASE as BASE,
  RELEASE_LIFECYCLE_FIXTURE_CASES,
} from "../../../tests/support/jira-release-lifecycle-fixture.js";

const COMPONENT_ARGS = RELEASE_LIFECYCLE_FIXTURE_CASES[0].args;
const MERGE_ARGS = RELEASE_LIFECYCLE_FIXTURE_CASES[1].args;
const MOVE_ARGS = RELEASE_LIFECYCLE_FIXTURE_CASES[2].args;
const SWAP_ARGS = RELEASE_LIFECYCLE_FIXTURE_CASES[3].args;
const CONTEXT = { projectId: "10000", projectKey: "SYN", userKey: ACTOR.key };
const BASE_URL = "https://jira.synthetic.invalid/context";
const version = (id: string): Record<string, unknown> => ({
  id,
  projectId: 10000,
  ...VERSION,
  name: id === "82" ? "Retained release" : VERSION.name,
});
const component = (id: string): Record<string, unknown> => ({
  id,
  project: "SYN",
  description: "",
  archived: false,
  deleted: false,
  name: id === "72" ? "Retained component" : COMPONENT.name,
});
const objectResponse = (body: Record<string, unknown>): AtlassianWriteHttpOutcome => ({
  ok: true,
  status: 200,
  body,
});
const arrayResponse = (items: readonly unknown[]): AtlassianWriteHttpOutcome => ({
  ok: true,
  status: 200,
  body: undefined,
  items,
});
interface Options {
  readonly actor?: Record<string, unknown>;
  readonly afterActor?: Record<string, unknown>;
  readonly project?: Record<string, unknown>;
  readonly sourceVersion?: Record<string, unknown>;
  readonly targetVersion?: Record<string, unknown>;
  readonly sourceComponent?: Record<string, unknown>;
  readonly targetComponent?: Record<string, unknown>;
  readonly beforeVersions?: readonly unknown[];
  readonly afterVersions?: readonly unknown[];
  readonly afterComponents?: readonly unknown[];
  readonly fields?: readonly unknown[];
  readonly write?: AtlassianWriteHttpOutcome;
  readonly afterFailure?: AtlassianWriteHttpOutcome;
  readonly throwAfter?: boolean;
}
function fixture(options: Options = {}): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  let effected = false;
  let move = false;
  return vi.fn<JiraMutationRequest>(async (path, method = "GET") => {
    if (method !== "GET") {
      effected = true;
      move = path.endsWith("/move");
      return options.write ?? { ok: true, status: 204, body: undefined };
    }
    if (effected && options.throwAfter) throw new TypeError("Independent read interrupted");
    if (effected && options.afterFailure !== undefined) return options.afterFailure;
    if (path === "myself")
      return objectResponse(
        effected ? (options.afterActor ?? options.actor ?? ACTOR) : (options.actor ?? ACTOR),
      );
    if (path === "project/10000") return objectResponse(options.project ?? PROJECT);
    if (path === `version/${String(options.sourceVersion?.id ?? "81")}`)
      return objectResponse(options.sourceVersion ?? version("81"));
    if (path === "version/82") return objectResponse(options.targetVersion ?? version("82"));
    if (path === "component/71") return objectResponse(options.sourceComponent ?? component("71"));
    if (path === "component/72") return objectResponse(options.targetComponent ?? component("72"));
    if (path === "project/10000/versions")
      return arrayResponse(
        effected
          ? (options.afterVersions ?? (move ? [version("82"), version("81")] : [version("82")]))
          : (options.beforeVersions ?? [version("81"), version("82")]),
      );
    if (path === "project/10000/components")
      return arrayResponse(options.afterComponents ?? [component("72")]);
    if (path === "field")
      return arrayResponse(
        options.fields ?? [
          { id: "customfield_10001", schema: { type: "array", items: "version", customId: 10001 } },
        ],
      );
    throw new TypeError(`Unexpected synthetic native route: ${path}`);
  });
}
const effects = (request: ReturnType<typeof fixture>): readonly unknown[] =>
  request.mock.calls.filter((call) => call[1] !== undefined && call[1] !== "GET");
const reorder = (
  request: JiraMutationRequest,
  args: CatalogJsonObject = MOVE_ARGS,
  check = false,
  baseUrl: string | undefined = BASE_URL,
) =>
  executeJiraVersionLifecycleMutation(
    "jira.move-version",
    args,
    request,
    check,
    undefined,
    baseUrl,
  );

describe("reviewed same-project release lifecycle", () => {
  it("exposes only the four selected native operations", () => {
    expect(isJiraComponentDelete("jira.delete-component")).toBe(true);
    expect(isJiraComponentDelete("jira.delete-version")).toBe(false);
    for (const name of ["jira.merge-version", "jira.move-version", "jira.remove-and-swap-version"])
      expect(isJiraVersionLifecycleMutation(name)).toBe(true);
    expect(isJiraVersionLifecycleMutation("jira.update-version")).toBe(false);
  });
  it.each([200, 202, 204])(
    "confirms a version move only from complete order after readable ACK %s",
    async (status) => {
      const request = fixture({ write: { ok: true, status, body: undefined } });
      expect(await reorder(request)).toEqual({
        ok: true,
        receipt: { ...CONTEXT, versionId: "81" },
      });
      expect(effects(request)).toEqual([
        ["version/81/move", "POST", { after: `${BASE_URL}/rest/api/2/version/82` }, "none"],
      ]);
      expect(request.mock.calls.at(-1)).toEqual([
        "project/10000/versions",
        "GET",
        undefined,
        "json-array",
      ]);
    },
  );
  it.each([
    ["First", ["82", "81"], ["81", "82"]],
    ["Last", ["81", "82"], ["82", "81"]],
    ["Earlier", ["82", "81"], ["81", "82"]],
    ["Later", ["81", "82"], ["82", "81"]],
  ] as const)(
    "uses native %s and proves its complete desired permutation",
    async (position, before, after) => {
      const request = fixture({
        beforeVersions: before.map(version),
        afterVersions: after.map(version),
      });
      expect(
        await reorder(request, {
          ...BASE,
          versionId: "81",
          expectedVersionSnapshot: VERSION,
          expectedVersionIds: [...before],
          position,
        }),
      ).toMatchObject({ ok: true });
      expect(effects(request)).toEqual([["version/81/move", "POST", { position }, "none"]]);
    },
  );
  it("reports observed unchanged order without an effect", async () => {
    const request = fixture();
    expect(
      await reorder(request, {
        ...BASE,
        versionId: "81",
        expectedVersionSnapshot: VERSION,
        expectedVersionIds: ["81", "82"],
        position: "First",
      }),
    ).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true } });
    expect(effects(request)).toHaveLength(0);
  });
  it("preflights a real move without writing or claiming completion", async () => {
    const request = fixture();
    expect(await reorder(request, MOVE_ARGS, true)).toEqual({ ok: true, receipt: {} });
    expect(effects(request)).toHaveLength(0);
  });
  it.each([
    undefined,
    "http://jira.synthetic.invalid",
    "https://user:password@jira.synthetic.invalid",
    "https://jira.synthetic.invalid/?next=elsewhere",
  ])("refuses after-URI creation without a safe bound base %s before requests", async (baseUrl) => {
    const request = fixture();
    expect(
      await executeJiraVersionLifecycleMutation(
        "jira.move-version",
        MOVE_ARGS,
        request,
        false,
        undefined,
        baseUrl,
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { ...MOVE_ARGS, position: "Last" },
    { ...MOVE_ARGS, afterVersionId: "81" },
    { ...MOVE_ARGS, afterVersionId: "83" },
    { ...MOVE_ARGS, expectedVersionIds: ["81", "81", "82"] },
    { ...MOVE_ARGS, expectedVersionSnapshot: { ...VERSION, released: undefined } },
    { ...MOVE_ARGS, after: "https://elsewhere.invalid/version/82" },
  ])("refuses ambiguous, incomplete or widened move input %#", async (args) => {
    const request = fixture();
    expect(await reorder(request, args as CatalogJsonObject)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { actor: { ...ACTOR, key: "other-actor" } },
    { project: { ...PROJECT, id: "10001" } },
    { sourceVersion: { ...version("81"), projectId: 10001 } },
    { sourceVersion: { ...version("81"), self: "https://native.invalid/rest/api/2/version/82" } },
    { sourceVersion: { ...version("81"), description: "changed" } },
    { beforeVersions: [version("82"), version("81")] },
    { beforeVersions: [version("81"), version("82"), version("82")] },
  ])(
    "refuses changed actor, parent, identity, snapshot or order before any effect %#",
    async (options) => {
      const request = fixture(options);
      expect(await reorder(request)).toMatchObject({ ok: false });
      expect(effects(request)).toHaveLength(0);
    },
  );
  it.each([
    { afterVersions: [version("81"), version("82")] },
    { afterVersions: [version("82"), { ...version("81"), description: "concurrent edit" }] },
    { afterVersions: [version("82")] },
    { afterActor: { ...ACTOR, key: "other" } },
    { afterFailure: { ok: false, reason: "permission-denied" } },
  ] satisfies Options[])(
    "never confirms or repeats a move after incomplete/changed readback %#",
    async (options) => {
      const request = fixture(options);
      expect(await reorder(request)).toMatchObject({
        ok: false,
        receipt: { ...CONTEXT, versionId: "81" },
      });
      expect(effects(request)).toHaveLength(1);
    },
  );
  it("retains known identity on lost ACK and does not read or repeat an uncertain effect", async () => {
    const request = fixture({ write: { ok: false, reason: "timeout" } });
    expect(await reorder(request)).toMatchObject({
      ok: false,
      reason: "timeout",
      receipt: { versionId: "81" },
    });
    expect(request.mock.calls.at(-1)?.[1]).toBe("POST");
    expect(effects(request)).toHaveLength(1);
  });
  it("preserves the acknowledged receipt when independent confirmation throws", async () => {
    const request = fixture({ throwAfter: true });
    await expect(reorder(request)).rejects.toMatchObject({
      name: JiraAcknowledgedMutationError.name,
      receipt: { ...CONTEXT, versionId: "81" },
    });
    expect(effects(request)).toHaveLength(1);
  });
});

describe("destructive release effects never infer full issue reassignment", () => {
  it.each([200, 202, 204])(
    "keeps component removal unconfirmed after ACK %s and complete parent absence",
    async (status) => {
      const request = fixture({ write: { ok: true, status, body: undefined } });
      expect(await executeJiraComponentDelete(COMPONENT_ARGS, request)).toMatchObject({
        ok: false,
        reason: "unavailable",
        receipt: { ...CONTEXT, componentId: "71", replacementComponentId: "72" },
      });
      expect(effects(request)).toEqual([
        ["component/71?moveIssuesTo=72", "DELETE", undefined, "none"],
      ]);
      expect(request.mock.calls.at(-1)).toEqual([
        "project/10000/components",
        "GET",
        undefined,
        "json-array",
      ]);
    },
  );
  it("requires explicit null to clear component references and emits no move query", async () => {
    const request = fixture();
    expect(
      await executeJiraComponentDelete(
        { ...BASE, componentId: "71", expectedComponentSnapshot: COMPONENT, moveIssuesTo: null },
        request,
      ),
    ).toMatchObject({ ok: false, receipt: { componentId: "71" } });
    expect(effects(request)).toEqual([["component/71", "DELETE", undefined, "none"]]);
  });
  it.each([
    { ...COMPONENT_ARGS, moveIssuesTo: "71" },
    { ...COMPONENT_ARGS, moveIssuesTo: null },
    {
      ...COMPONENT_ARGS,
      expectedReplacementSnapshot: {
        ...COMPONENT,
        name: "Retained component",
        archived: undefined,
      },
    },
  ])("refuses incomplete component selection %# without a request", async (args) => {
    const request = fixture();
    expect(await executeJiraComponentDelete(args as CatalogJsonObject, request)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(request).not.toHaveBeenCalled();
  });
  it("refuses a replacement from another project before DELETE", async () => {
    const request = fixture({ targetComponent: { ...component("72"), project: "OTHER" } });
    expect(await executeJiraComponentDelete(COMPONENT_ARGS, request)).toMatchObject({ ok: false });
    expect(effects(request)).toHaveLength(0);
  });
  it("performs one fixed merge and retains both IDs without claiming all references moved", async () => {
    const request = fixture();
    expect(
      await executeJiraVersionLifecycleMutation("jira.merge-version", MERGE_ARGS, request),
    ).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: { ...CONTEXT, versionId: "81", targetVersionId: "82" },
    });
    expect(effects(request)).toEqual([["version/81/mergeto/82", "PUT", undefined, "none"]]);
  });
  it("retains full int64 source identities in path-only merge operations", async () => {
    const id = "9007199254740993";
    const request = fixture({ sourceVersion: { ...version("81"), id } });
    expect(
      await executeJiraVersionLifecycleMutation(
        "jira.merge-version",
        { ...MERGE_ARGS, versionId: id },
        request,
      ),
    ).toMatchObject({ ok: false, receipt: { versionId: id, targetVersionId: "82" } });
    expect(effects(request)).toEqual([[`version/${id}/mergeto/82`, "PUT", undefined, "none"]]);
  });
  it("preserves unknown native release flags as null review fields instead of false", async () => {
    const native = { id: "81", projectId: 10000, name: VERSION.name, description: "" };
    const request = fixture({ sourceVersion: native });
    const expectedVersionSnapshot = { ...VERSION, released: null, archived: null };
    expect(
      await executeJiraVersionLifecycleMutation(
        "jira.merge-version",
        { ...MERGE_ARGS, expectedVersionSnapshot },
        request,
      ),
    ).toMatchObject({ ok: false, reason: "unavailable", receipt: { versionId: "81" } });
    expect(effects(request)).toHaveLength(1);
  });
  it("binds safe numeric swap body fields and leaves aggregate references unconfirmed", async () => {
    const request = fixture();
    expect(
      await executeJiraVersionLifecycleMutation("jira.remove-and-swap-version", SWAP_ARGS, request),
    ).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: { ...CONTEXT, versionId: "81", replacementVersionIds: ["82"] },
    });
    expect(effects(request)).toEqual([
      [
        "version/81/removeAndSwap",
        "POST",
        {
          moveFixIssuesTo: 82,
          moveAffectedIssuesTo: null,
          customFieldReplacementList: [{ customFieldId: 10001, moveTo: 82 }],
        },
        "none",
      ],
    ]);
  });
  it("keeps explicit null and empty custom replacement list as destructive clearing choices", async () => {
    const request = fixture();
    const args = {
      ...SWAP_ARGS,
      moveFixIssuesTo: null,
      customFieldReplacementList: [],
      expectedReplacementVersions: [],
    };
    expect(
      await executeJiraVersionLifecycleMutation("jira.remove-and-swap-version", args, request),
    ).toMatchObject({ ok: false, receipt: { replacementVersionIds: [] } });
    expect(effects(request)).toEqual([
      [
        "version/81/removeAndSwap",
        "POST",
        { moveFixIssuesTo: null, moveAffectedIssuesTo: null, customFieldReplacementList: [] },
        "none",
      ],
    ]);
  });
  it.each([
    { ...SWAP_ARGS, moveFixIssuesTo: "9007199254740993" },
    { ...SWAP_ARGS, moveFixIssuesTo: "81" },
    { ...SWAP_ARGS, expectedReplacementVersions: [] },
    {
      ...SWAP_ARGS,
      customFieldReplacementList: [{ customFieldId: "9007199254740993", moveTo: "82" }],
    },
    {
      ...SWAP_ARGS,
      customFieldReplacementList: [
        { customFieldId: "10001", moveTo: "82" },
        { customFieldId: "10001", moveTo: null },
      ],
    },
  ])(
    "rejects imprecise, self-targeted or unreviewed swap input %# before requests",
    async (args) => {
      const request = fixture();
      expect(
        await executeJiraVersionLifecycleMutation("jira.remove-and-swap-version", args, request),
      ).toMatchObject({ ok: false, reason: "field-validation" });
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("refuses a custom field with a different native type before swap", async () => {
    const request = fixture({
      fields: [{ id: "customfield_10001", schema: { type: "string", customId: 10001 } }],
    });
    expect(
      await executeJiraVersionLifecycleMutation("jira.remove-and-swap-version", SWAP_ARGS, request),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(effects(request)).toHaveLength(0);
  });
  it.each(["timeout", "permission-denied", "unavailable"] as const)(
    "retains reviewed component identities on %s without retry",
    async (reason) => {
      const request = fixture({ write: { ok: false, reason } });
      expect(await executeJiraComponentDelete(COMPONENT_ARGS, request)).toMatchObject({
        ok: false,
        reason,
        receipt: { componentId: "71", replacementComponentId: "72" },
      });
      expect(effects(request)).toHaveLength(1);
    },
  );
  it("never treats an inaccessible parent collection as proof of deletion", async () => {
    const request = fixture({ afterFailure: { ok: false, reason: "not-found" } });
    expect(await executeJiraComponentDelete(COMPONENT_ARGS, request)).toMatchObject({
      ok: false,
      receipt: { componentId: "71" },
    });
    expect(effects(request)).toHaveLength(1);
  });
  it("checks replacements and actor during a no-effect preflight", async () => {
    const request = fixture();
    expect(
      await executeJiraVersionLifecycleMutation(
        "jira.remove-and-swap-version",
        SWAP_ARGS,
        request,
        true,
      ),
    ).toEqual({ ok: true, receipt: {} });
    expect(effects(request)).toHaveLength(0);
  });
});

function formalRules(
  lines: readonly string[],
  project = "SYN",
  activation = "edit",
): JiraIssueTemplateSource {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      `project: ${project}`,
      "issueType: Story",
      `activateOn: [${activation}]`,
      ...lines,
      "---",
      "",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Invalid synthetic formal rule");
  return () => ({ templates: [parsed.template], unreadable: 0 });
}
describe("formal issue-rule impact is admitted before any native bulk reference effect", () => {
  it.each([false, true])(
    "refuses required components before deletion, including preflight=%s",
    async (check) => {
      const request = fixture();
      const result = await executeJiraComponentDelete(
        COMPONENT_ARGS,
        request,
        check,
        formalRules(["requiredFields: [components]"]),
      );
      expect(result).toMatchObject({
        ok: false,
        reason: "field-validation",
        violations: [{ ruleId: "template-unreadable", template: "SYN/Story" }],
      });
      expect(result.ok ? undefined : result.detail?.messages?.[0]).toContain("governed jira.edit");
      expect(effects(request)).toHaveLength(0);
    },
  );
  it.each([
    ["jira.merge-version", MERGE_ARGS, "requiredFields: [fixVersions]"],
    ["jira.remove-and-swap-version", SWAP_ARGS, "requiredFields: [versions]"],
    ["jira.remove-and-swap-version", SWAP_ARGS, "parentField: fixVersions"],
  ] as const)(
    "refuses %s for an affected active formal field before dispatch",
    async (operation, args, rule) => {
      const request = fixture();
      expect(
        await executeJiraVersionLifecycleMutation(
          operation,
          args,
          request,
          false,
          formalRules([rule]),
        ),
      ).toMatchObject({
        ok: false,
        reason: "field-validation",
        violations: [{ ruleId: "template-unreadable" }],
      });
      expect(effects(request)).toHaveLength(0);
    },
  );
  it("does not treat a replacement as proof that every affected issue satisfies a formal rule", async () => {
    const request = fixture();
    expect(
      await executeJiraVersionLifecycleMutation(
        "jira.merge-version",
        MERGE_ARGS,
        request,
        true,
        formalRules(["requiredFields: [fixVersions]"]),
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(effects(request)).toHaveLength(0);
  });
  it("resolves a native field display name through the existing catalog before bulk admission", async () => {
    const request = fixture({
      fields: [
        {
          id: "fixVersions",
          name: "Release selection",
          schema: { type: "array", items: "version", system: "fixVersions" },
        },
      ],
    });
    expect(
      await executeJiraVersionLifecycleMutation(
        "jira.merge-version",
        MERGE_ARGS,
        request,
        false,
        formalRules(['requiredFields: ["Release selection"]']),
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(effects(request)).toHaveLength(0);
  });
  it.each([
    {
      type: "array",
      items: "version",
      custom: "com.atlassian.jira.plugin.system.customfieldtypes:multiversion",
    },
    { type: "version", custom: "com.atlassian.jira.plugin.system.customfieldtypes:version" },
    { type: "string", custom: "plugin:unknown-reference" },
  ])(
    "refuses potentially affected custom required fields without inventing their complete issue population %#",
    async (schema) => {
      const request = fixture({
        fields: [{ id: "customfield_123", name: "Release choice", schema }],
      });
      expect(
        await executeJiraVersionLifecycleMutation(
          "jira.merge-version",
          MERGE_ARGS,
          request,
          false,
          formalRules(["requiredFields: [customfield_123]"]),
        ),
      ).toMatchObject({ ok: false, reason: "field-validation" });
      expect(effects(request)).toHaveLength(0);
    },
  );
  it("keeps an independently typed ordinary text-field rule outside native version-reference impact", async () => {
    const request = fixture({
      fields: [
        {
          id: "customfield_123",
          name: "Notes",
          schema: {
            type: "string",
            custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea",
          },
        },
      ],
    });
    expect(
      await executeJiraVersionLifecycleMutation(
        "jira.merge-version",
        MERGE_ARGS,
        request,
        false,
        formalRules(["requiredFields: [Notes]"]),
      ),
    ).toMatchObject({ ok: false, reason: "unavailable", receipt: { versionId: "81" } });
    expect(effects(request)).toHaveLength(1);
  });
  it("refuses unresolved field rules instead of treating missing catalog evidence as unrelated", async () => {
    const request = fixture({ fields: [] });
    expect(
      await executeJiraComponentDelete(
        COMPONENT_ARGS,
        request,
        false,
        formalRules(['requiredFields: ["Unresolved field"]']),
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(effects(request)).toHaveLength(0);
  });
  it.each([
    formalRules(["requiredFields: [components]"], "OTHER"),
    formalRules(["requiredFields: [components]"], "SYN", "create"),
    formalRules(["requiredFields: [components]"], "SYN", "transition"),
    formalRules(["requiredFields: [summary, fixVersions]", "parentLink: Blocks"]),
  ])(
    "leaves other projects, activations and unaffected fields/links operational %#",
    async (source) => {
      const request = fixture();
      expect(
        await executeJiraComponentDelete(COMPONENT_ARGS, request, false, source),
      ).toMatchObject({ ok: false, reason: "unavailable", receipt: { componentId: "71" } });
      expect(effects(request)).toHaveLength(1);
    },
  );
  it("never promotes a prose skill into formal enforcement", async () => {
    const prose = parseJiraIssueTemplate(
      "Please keep components and fix versions populated when preparing release work.",
    );
    expect(prose).toMatchObject({ ok: false });
    const source: JiraIssueTemplateSource = () => ({ templates: [], unreadable: 0 });
    const request = fixture();
    expect(await executeJiraComponentDelete(COMPONENT_ARGS, request, false, source)).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: { componentId: "71" },
    });
    expect(effects(request)).toHaveLength(1);
  });
  it("keeps unreadable formal rules fail-closed before a reference rewrite", async () => {
    const request = fixture();
    const source: JiraIssueTemplateSource = () => ({
      templates: [],
      unreadable: 1,
      unreadableNames: ["Formal rule"],
    });
    expect(await executeJiraComponentDelete(COMPONENT_ARGS, request, false, source)).toMatchObject({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "template-unreadable" }],
    });
    expect(effects(request)).toHaveLength(0);
  });
  it("does not invent issue-field impact for pure version ordering", async () => {
    const request = fixture();
    expect(
      await executeJiraVersionLifecycleMutation(
        "jira.move-version",
        MOVE_ARGS,
        request,
        false,
        formalRules(["requiredFields: [fixVersions]"]),
        BASE_URL,
      ),
    ).toMatchObject({ ok: true, receipt: { versionId: "81" } });
    expect(effects(request)).toHaveLength(1);
  });
});
