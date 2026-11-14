import { describe, expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import {
  executeJiraEntityPropertyMutation as mutate,
  isJiraEntityPropertyMutation,
} from "./jira-managed-entity-property-mutations.js";
import { jiraPropertyBindingFailure } from "./jira-entity-property-write-admission.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import {
  BASE,
  ISSUE,
  PROPERTY_CASES as CASES,
  type PropertyScenario,
} from "./jira-property-test/_support.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { scriptedJiraMutationRequest as port } from "./jira-test-request/_support.js";

const KEY = "review ~key";
const OLD = { old: "Before" };
const OLD_NODES: readonly CatalogJsonObject[] = [
  { path: "", kind: "object", childCount: 1 },
  { path: "/old", kind: "string", textValue: "Before" },
];
const FALSE_NODES: readonly CatalogJsonObject[] = [
  { path: "", kind: "boolean", booleanValue: false },
];
const ACK: AtlassianWriteHttpOutcome = { ok: true, status: 204, body: undefined };
const ABSENT: AtlassianWriteHttpOutcome = { ok: false, reason: "not-found", httpStatus: 404 };
const ISSUE_SCENARIO = CASES.find((scenario) => scenario.prefix === "issue");
if (ISSUE_SCENARIO === undefined) throw new TypeError("Missing issue scenario");
const CANONICAL_PATHS: Readonly<Record<string, readonly string[]>> = {
  comment: ["issue/10002?fields=summary", "issue/10002/comment/9"],
  issue: ["issue/10002?fields=summary"],
  project: ["project/10000"],
  user: ["user?key=user-key"],
};
function reply(body: Record<string, unknown>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body };
}
function keys(...values: readonly string[]): AtlassianWriteHttpOutcome {
  return reply({ keys: values.map((key) => ({ key })) });
}
function value(value: unknown): AtlassianWriteHttpOutcome {
  return reply({ key: KEY, value });
}
function operation(prefix: string, remove = false): Parameters<typeof mutate>[0] {
  const name = `jira.${remove ? "delete" : "set"}-${prefix}-property`;
  if (!isJiraEntityPropertyMutation(name)) throw new TypeError("Unknown property mutation fixture");
  return name;
}
function propertyPath(scenario: PropertyScenario): string {
  const split = scenario.path.indexOf("?");
  const path = split < 0 ? scenario.path : scenario.path.slice(0, split);
  return `${path}/${encodeURIComponent(KEY)}${split < 0 ? "" : scenario.path.slice(split)}`;
}
function fixture(
  scenario: PropertyScenario,
  script: readonly (AtlassianWriteHttpOutcome | Error)[],
): {
  readonly selected: ReturnType<typeof port>;
  readonly unused: ReturnType<typeof port>;
  readonly ports: {
    readonly platform: ReturnType<typeof port>;
    readonly agile: ReturnType<typeof port>;
    readonly baseUrl: string;
  };
} {
  const selected = port(script);
  const unused = port([]);
  return {
    selected,
    unused,
    ports: {
      platform: scenario.agile ? unused : selected,
      agile: scenario.agile ? selected : unused,
      baseUrl: BASE,
    },
  };
}
function script(scenario: PropertyScenario, remove: boolean): readonly AtlassianWriteHttpOutcome[] {
  return [
    ...scenario.admission.map(reply),
    keys(KEY),
    value(OLD),
    ACK,
    ...scenario.admission.map(reply),
    remove ? keys() : keys(KEY),
    remove ? ABSENT : value(false),
  ];
}
function effects(selected: ReturnType<typeof port>): Parameters<JiraMutationRequest>[] {
  return selected.mock.calls.filter(([, method]) => method !== undefined && method !== "GET");
}

it.each(CASES)(
  "sets $prefix property once, preserving a literal false body and rebinding canonical identity",
  async (scenario) => {
    const f = fixture(scenario, script(scenario, false));
    expect(
      await mutate(
        operation(scenario.prefix),
        {
          ...scenario.args,
          propertyKey: KEY,
          expectedValueNodes: OLD_NODES,
          valueNodes: FALSE_NODES,
        },
        f.ports,
      ),
    ).toEqual({
      ok: true,
      receipt: { ...scenario.context, propertyKey: KEY, propertyPresent: true },
    });
    const path = propertyPath(scenario);
    expect(f.selected.mock.calls.map(([path]) => path)).toEqual([
      ...scenario.admissionPaths,
      scenario.path,
      path,
      path,
      ...(CANONICAL_PATHS[scenario.prefix] ?? scenario.admissionPaths),
      scenario.path,
      path,
    ]);
    expect(effects(f.selected)).toEqual([[path, "PUT", false, "none"]]);
    expect(f.unused).not.toHaveBeenCalled();
  },
);

it.each(CASES)(
  "deletes $prefix property only after complete reviewed value and two-source native absence proof",
  async (scenario) => {
    const f = fixture(scenario, script(scenario, true));
    expect(
      await mutate(
        operation(scenario.prefix, true),
        {
          ...scenario.args,
          propertyKey: KEY,
          expectedValueNodes: OLD_NODES,
        },
        f.ports,
      ),
    ).toEqual({
      ok: true,
      receipt: { ...scenario.context, propertyKey: KEY, propertyPresent: false },
    });
    expect(effects(f.selected)).toEqual([[propertyPath(scenario), "DELETE", undefined, "none"]]);
    expect(f.unused).not.toHaveBeenCalled();
  },
);

it("requires complete keys plus native404 to admit explicitly reviewed absence", async () => {
  const f = fixture(ISSUE_SCENARIO, [
    reply(ISSUE),
    keys(),
    ABSENT,
    ACK,
    reply(ISSUE),
    keys(KEY),
    value(null),
  ]);
  expect(
    await mutate(
      "jira.set-issue-property",
      {
        issueIdOrKey: "syn-2",
        propertyKey: KEY,
        expectAbsent: true,
        valueNodes: [{ path: "", kind: "null" }],
      },
      f.ports,
    ),
  ).toEqual({
    ok: true,
    receipt: { issueId: "10002", issueKey: "SYN-2", propertyKey: KEY, propertyPresent: true },
  });
  expect(effects(f.selected)).toEqual([[propertyPath(ISSUE_SCENARIO), "PUT", null, "none"]]);
});

it("does not treat a present native null as absence", async () => {
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), value(null)]);
  expect(
    await mutate(
      "jira.set-issue-property",
      {
        issueIdOrKey: "syn-2",
        propertyKey: KEY,
        expectAbsent: true,
        valueNodes: FALSE_NODES,
      },
      f.ports,
    ),
  ).toMatchObject({ ok: false, reason: "conflict" });
  expect(effects(f.selected)).toEqual([]);
});

it("preflights complete data without issuing PUT or DELETE", async () => {
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), value(OLD)]);
  expect(
    await mutate(
      "jira.set-issue-property",
      {
        issueIdOrKey: "syn-2",
        propertyKey: KEY,
        expectedValueNodes: OLD_NODES,
        valueNodes: FALSE_NODES,
      },
      f.ports,
      true,
    ),
  ).toEqual({ ok: true, receipt: {} });
  expect(effects(f.selected)).toEqual([]);
});

it("compares object data independently of key order and reports a real no-op", async () => {
  const observed = { count: 0, old: "Before" };
  const nodes: readonly CatalogJsonObject[] = [
    { path: "", kind: "object", childCount: 2 },
    { path: "/old", kind: "string", textValue: "Before" },
    { path: "/count", kind: "number", numberValue: 0 },
  ];
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), value(observed)]);
  expect(
    await mutate(
      "jira.set-issue-property",
      {
        issueIdOrKey: "syn-2",
        propertyKey: KEY,
        expectedValueNodes: nodes,
        valueNodes: nodes,
      },
      f.ports,
    ),
  ).toMatchObject({
    ok: false,
    reason: "conflict",
    detail: { unchanged: true },
    receipt: { issueId: "10002", propertyKey: KEY, propertyPresent: true },
  });
  expect(effects(f.selected)).toEqual([]);
});

it.each([
  [keys(), value(OLD)],
  [keys(KEY), ABSENT],
  [keys(KEY), value({ old: "Changed" })],
] as const)(
  "refuses inconsistent or stale native snapshots before an effect: %#",
  async (keyResponse, valueResponse) => {
    const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keyResponse, valueResponse]);
    expect(
      (
        await mutate(
          "jira.delete-issue-property",
          {
            issueIdOrKey: "syn-2",
            propertyKey: KEY,
            expectedValueNodes: OLD_NODES,
          },
          f.ports,
        )
      ).ok,
    ).toBe(false);
    expect(effects(f.selected)).toEqual([]);
  },
);

it.each([
  reply({}),
  reply({ keys: null }),
  reply({
    keys: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
      key: String(index),
    })),
  }),
])(
  "does not accept absent, malformed or truncated keys as a complete list: %#",
  async (keyResponse) => {
    const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keyResponse]);
    expect(
      (
        await mutate(
          "jira.set-issue-property",
          {
            issueIdOrKey: "syn-2",
            propertyKey: KEY,
            expectAbsent: true,
            valueNodes: FALSE_NODES,
          },
          f.ports,
        )
      ).ok,
    ).toBe(false);
    expect(effects(f.selected)).toEqual([]);
  },
);

it("refuses an unavailable value instead of inferring absence from a permission gap", async () => {
  const f = fixture(ISSUE_SCENARIO, [
    reply(ISSUE),
    keys(),
    { ok: false, reason: "permission-denied", httpStatus: 403 },
  ]);
  expect(
    await mutate(
      "jira.set-issue-property",
      {
        issueIdOrKey: "syn-2",
        propertyKey: KEY,
        expectAbsent: true,
        valueNodes: FALSE_NODES,
      },
      f.ports,
    ),
  ).toEqual({ ok: false, reason: "permission-denied" });
  expect(effects(f.selected)).toEqual([]);
});

it("never invokes a supplied value accessor while admitting native property data", async () => {
  const getter = vi.fn(() => OLD);
  const body = Object.defineProperty({ key: KEY }, "value", { get: getter, enumerable: true });
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), reply(body)]);
  expect(
    (
      await mutate(
        "jira.delete-issue-property",
        {
          issueIdOrKey: "syn-2",
          propertyKey: KEY,
          expectedValueNodes: OLD_NODES,
        },
        f.ports,
      )
    ).ok,
  ).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  expect(effects(f.selected)).toEqual([]);
});

it("does not turn a missing parent after acknowledged deletion into confirmed property absence", async () => {
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), value(OLD), ACK, ABSENT]);
  expect(
    await mutate(
      "jira.delete-issue-property",
      {
        issueIdOrKey: "syn-2",
        propertyKey: KEY,
        expectedValueNodes: OLD_NODES,
      },
      f.ports,
    ),
  ).toMatchObject({
    ok: false,
    reason: "not-found",
    receipt: { issueId: "10002", propertyKey: KEY, propertyPresent: false },
  });
  expect(effects(f.selected)).toHaveLength(1);
});

it.each(CASES)(
  "retains target-only receipt after a lost $prefix property acknowledgement without another effect",
  async (scenario) => {
    const f = fixture(scenario, [
      ...scenario.admission.map(reply),
      keys(KEY),
      value(OLD),
      { ok: false, reason: "timeout" },
    ]);
    expect(
      await mutate(
        operation(scenario.prefix),
        {
          ...scenario.args,
          propertyKey: KEY,
          expectedValueNodes: OLD_NODES,
          valueNodes: FALSE_NODES,
        },
        f.ports,
      ),
    ).toEqual({
      ok: false,
      reason: "timeout",
      receipt: { ...scenario.context, propertyKey: KEY, propertyPresent: true },
    });
    expect(effects(f.selected)).toHaveLength(1);
  },
);

it("retains acknowledged context when canonical parent readback throws", async () => {
  const cause = new TypeError("Synthetic canonical parent readback failure");
  const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), value(OLD), ACK, cause]);
  const failure = await mutate(
    "jira.set-issue-property",
    {
      issueIdOrKey: "syn-2",
      propertyKey: KEY,
      expectedValueNodes: OLD_NODES,
      valueNodes: FALSE_NODES,
    },
    f.ports,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(JiraAcknowledgedMutationError);
  expect(failure).toMatchObject({
    cause,
    receipt: { issueId: "10002", propertyKey: KEY, propertyPresent: true },
  });
  expect(effects(f.selected)).toHaveLength(1);
});

it.each(["expectedValueNodes", "valueNodes"] as const)(
  "preserves native UTF-8 bounds guidance for %s before any I/O",
  async (field) => {
    const f = fixture(ISSUE_SCENARIO, []);
    const args = {
      issueIdOrKey: "syn-2",
      propertyKey: KEY,
      expectedValueNodes: OLD_NODES,
      valueNodes: FALSE_NODES,
      [field]: [{ path: "", kind: "string", textValue: "界".repeat(12000) }],
    };
    expect(await mutate("jira.set-issue-property", args, f.ports)).toMatchObject({
      ok: false,
      reason: "field-validation",
      detail: {
        fieldId: field,
        validation: "bounds-exceeded",
        messages: [expect.stringContaining("32768 UTF-8")],
      },
    });
    expect(f.selected).not.toHaveBeenCalled();
  },
);

it("refuses a native user key that URL encoding would silently replace", async () => {
  const user = CASES.find((scenario) => scenario.prefix === "user");
  if (user === undefined) throw new TypeError("Missing user scenario");
  const f = fixture(user, [reply({ key: "\ud800", name: "synthetic user" })]);
  expect(
    (
      await mutate(
        "jira.set-user-property",
        {
          ...user.args,
          propertyKey: KEY,
          expectedValueNodes: OLD_NODES,
          valueNodes: FALSE_NODES,
        },
        f.ports,
      )
    ).ok,
  ).toBe(false);
  expect(f.selected).toHaveBeenCalledTimes(1);
  expect(effects(f.selected)).toEqual([]);
});

const INVALID: readonly CatalogJsonObject[] = [
  { issueIdOrKey: "syn-2", propertyKey: "a/b", expectAbsent: true, valueNodes: FALSE_NODES },
  { issueIdOrKey: "syn-2", propertyKey: KEY, expectAbsent: false, valueNodes: FALSE_NODES },
  {
    issueIdOrKey: "syn-2",
    propertyKey: KEY,
    expectAbsent: true,
    expectedValueNodes: OLD_NODES,
    valueNodes: FALSE_NODES,
  },
  { issueIdOrKey: "syn-2", propertyKey: KEY, valueNodes: FALSE_NODES },
  { issueIdOrKey: "syn-2", propertyKey: KEY, expectedValueNodes: OLD_NODES, valueNodes: [] },
  {
    issueIdOrKey: "syn-2",
    propertyKey: KEY,
    expectedValueNodes: OLD_NODES,
    valueNodes: FALSE_NODES,
    url: "https://untrusted.invalid",
  },
];
it.each(INVALID)(
  "refuses unsupported or ambiguous property review inputs before any lookup: %#",
  async (args) => {
    const f = fixture(ISSUE_SCENARIO, []);
    expect((await mutate("jira.set-issue-property", args, f.ports)).ok).toBe(false);
    expect(f.selected).not.toHaveBeenCalled();
  },
);

it("does not let delete claim an absent review or smuggle a replacement value", async () => {
  const selections: readonly CatalogJsonObject[] = [
    { expectAbsent: true },
    { expectedValueNodes: OLD_NODES, valueNodes: FALSE_NODES },
  ];
  for (const args of selections) {
    const f = fixture(ISSUE_SCENARIO, []);
    expect(
      (
        await mutate(
          "jira.delete-issue-property",
          { issueIdOrKey: "syn-2", propertyKey: KEY, ...args },
          f.ports,
        )
      ).ok,
    ).toBe(false);
    expect(f.selected).not.toHaveBeenCalled();
  }
});

// #4357 AC3: a refused property write names the rule the model must satisfy, one fixed sentence per
// cause. The sentences are pinned exactly, and none may be cut by the 200-byte bound of a message.
const DETAIL_MESSAGE_BYTES = 200;
const REFUSAL_SCENARIO: PropertyScenario = ISSUE_SCENARIO;
async function refusal(
  operationName: Parameters<typeof mutate>[0],
  args: CatalogJsonObject,
  script: readonly (AtlassianWriteHttpOutcome | Error)[] = [],
): Promise<{ readonly reason: string; readonly detail: Record<string, unknown> }> {
  const f = fixture(REFUSAL_SCENARIO, script);
  const attempt = await mutate(operationName, args, f.ports);
  if (attempt.ok) throw new TypeError("Expected a refusal");
  expect(effects(f.selected)).toEqual([]);
  for (const message of attempt.detail?.messages ?? []) {
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(DETAIL_MESSAGE_BYTES);
    expect(message).not.toMatch(/…$/u);
  }
  return { reason: attempt.reason, detail: { ...attempt.detail } };
}
const SET_ARGS = {
  issueIdOrKey: "syn-2",
  propertyKey: KEY,
  expectAbsent: true,
  valueNodes: FALSE_NODES,
};
it("names the arguments a property write takes when another one is sent, without echoing it", async () => {
  expect(await refusal("jira.set-issue-property", { ...SET_ARGS, secretPath: "x" })).toEqual({
    reason: "field-validation",
    detail: {
      validation: "invalid-field",
      messages: [
        "This call takes only issueIdOrKey, propertyKey, expectedValueNodes, valueNodes, expectAbsent. Nothing was changed.",
      ],
    },
  });
  expect(
    await refusal("jira.delete-issue-property", {
      issueIdOrKey: "syn-2",
      propertyKey: KEY,
      expectedValueNodes: OLD_NODES,
      valueNodes: FALSE_NODES,
    }),
  ).toMatchObject({
    detail: {
      messages: [
        "This call takes only issueIdOrKey, propertyKey, expectedValueNodes. Nothing was changed.",
      ],
    },
  });
});
it.each(["a/b", "a\\b", "a%b", ".", "..", "x".repeat(256), "line\nbreak", "   ", undefined])(
  "states the property key rule for a refused key %j",
  async (propertyKey) => {
    const { propertyKey: _dropped, ...rest } = SET_ARGS;
    const args = propertyKey === undefined ? rest : { ...rest, propertyKey };
    expect(await refusal("jira.set-issue-property", args)).toEqual({
      reason: "field-validation",
      detail: {
        fieldId: "propertyKey",
        validation: "invalid-field",
        messages: [
          "propertyKey must be the exact property key: not blank, at most 255 bytes, no control characters, no / \\ or %, and not . or .. Nothing was changed.",
        ],
      },
    });
  },
);
it("names the arguments that identify the entity when they do not select one", async () => {
  const { issueIdOrKey: _dropped, ...rest } = SET_ARGS;
  expect(await refusal("jira.set-issue-property", rest)).toMatchObject({
    reason: "field-validation",
    detail: {
      messages: [
        "Name the entity with issueIdOrKey, exactly as the property read for it takes them. Nothing was changed.",
      ],
    },
  });
});
it.each([
  [
    "a delete that claims absence",
    "jira.delete-issue-property",
    { issueIdOrKey: "syn-2", propertyKey: KEY, expectAbsent: true },
    undefined,
    "This call takes only issueIdOrKey, propertyKey, expectedValueNodes. Nothing was changed.",
  ],
  [
    "an expectAbsent that is not true",
    "jira.set-issue-property",
    { ...SET_ARGS, expectAbsent: false },
    "expectAbsent",
    "expectAbsent must be true, and only for a property that does not exist yet. Nothing was changed.",
  ],
  [
    "both review forms",
    "jira.set-issue-property",
    { ...SET_ARGS, expectedValueNodes: OLD_NODES },
    "expectAbsent",
    "Send exactly one of expectAbsent:true or expectedValueNodes, not both. Nothing was changed.",
  ],
  [
    "a set without a review form",
    "jira.set-issue-property",
    { issueIdOrKey: "syn-2", propertyKey: KEY, valueNodes: FALSE_NODES },
    "expectedValueNodes",
    "Send expectAbsent:true for a property that does not exist yet, or expectedValueNodes: the complete current value as the property read lists it. Nothing was changed.",
  ],
  [
    "a delete without a review form",
    "jira.delete-issue-property",
    { issueIdOrKey: "syn-2", propertyKey: KEY },
    "expectedValueNodes",
    "Send expectedValueNodes: the complete current value as the property read lists it. Nothing was changed.",
  ],
] as const)(
  "names the review rule for %s",
  async (_name, operationName, args, fieldId, message) => {
    expect(await refusal(operationName, args)).toEqual({
      reason: "field-validation",
      detail: {
        ...(fieldId === undefined ? {} : { fieldId }),
        validation: "invalid-field",
        messages: [message],
      },
    });
  },
);
it("says what is too large and that it cannot be written as one value", async () => {
  expect(
    await refusal("jira.set-issue-property", {
      ...SET_ARGS,
      valueNodes: [{ path: "", kind: "string", textValue: "界".repeat(12000) }],
    }),
  ).toEqual({
    reason: "field-validation",
    detail: {
      fieldId: "valueNodes",
      validation: "bounds-exceeded",
      messages: [
        "A property value must fit 32768 UTF-8 JSON bytes and the depth, field and node limits. A larger value cannot be written as one value: shorten it or split it across property keys. Nothing was written.",
      ],
    },
  });
});
const UNCERTAIN_STATE =
  "Jira's answer about this property is incomplete or inconsistent, so its current state is not certain. Read it again and review the complete current value. Nothing was written.";
const TOO_LARGE_TO_READ =
  "The property's keys or value are larger than Keiko can read completely, so it cannot be changed here. Change it in Jira. Nothing was written.";
it.each([
  [
    "a key list without the listed key",
    [reply(ISSUE), keys(), value(OLD)],
    "conflict",
    UNCERTAIN_STATE,
  ],
  [
    "a listed key whose value is gone",
    [reply(ISSUE), keys(KEY), ABSENT],
    "conflict",
    UNCERTAIN_STATE,
  ],
  [
    "a key list that is not a list",
    [reply(ISSUE), reply({})],
    "malformed-payload",
    UNCERTAIN_STATE,
  ],
  [
    "a key list over the item bound",
    [
      reply(ISSUE),
      reply({
        keys: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
          key: String(index),
        })),
      }),
    ],
    "bounds-exceeded",
    TOO_LARGE_TO_READ,
  ],
] as const)(
  "tells the model what an inconsistent read means: %s",
  async (_name, script, reason, message) => {
    expect(
      await refusal(
        "jira.delete-issue-property",
        { issueIdOrKey: "syn-2", propertyKey: KEY, expectedValueNodes: OLD_NODES },
        script,
      ),
    ).toEqual({ reason, detail: { messages: [message] } });
  },
);
it.each([
  [
    { ok: false, reason: "not-found", httpStatus: 404 },
    "not-found",
    "The entity, or the parent it belongs to, was not found or is not visible to this connection. Check the entity arguments. Nothing was written.",
  ],
  [
    { ok: false, reason: "permission-denied", httpStatus: 403 },
    "permission-denied",
    "This connection may not read that entity, so its properties cannot be changed. Nothing was written.",
  ],
] as const)(
  "names what an entity that cannot be bound means: %j",
  async (outcome, reason, message) => {
    expect(
      await refusal(
        "jira.delete-issue-property",
        { issueIdOrKey: "syn-2", propertyKey: KEY, expectedValueNodes: OLD_NODES },
        [outcome],
      ),
    ).toEqual({ reason, detail: { messages: [message] } });
  },
);

// After an acknowledged write the model is never told that nothing was written (#4357 AC3).
const UNVERIFIED_AFTER_ACK =
  "Jira acknowledged the write, but Keiko could not verify the property afterwards. Do not repeat the write: read the property to see its current value.";
const SET_AFTER_ARGS = {
  issueIdOrKey: "syn-2",
  propertyKey: KEY,
  expectedValueNodes: OLD_NODES,
  valueNodes: FALSE_NODES,
};
it.each([
  ["the entity can no longer be bound", [ABSENT], "not-found"],
  ["the key list cannot be read", [reply(ISSUE), reply({})], "malformed-payload"],
  ["the value is still the old one", [reply(ISSUE), keys(KEY), value(OLD)], "conflict"],
  [
    "the value read is over the bound",
    [
      reply(ISSUE),
      reply({
        keys: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
          key: String(index),
        })),
      }),
    ],
    "bounds-exceeded",
  ],
] as const)(
  "says the write was acknowledged, not that nothing was written, when %s",
  async (_name, reread, reason) => {
    const f = fixture(ISSUE_SCENARIO, [reply(ISSUE), keys(KEY), value(OLD), ACK, ...reread]);
    const attempt = await mutate("jira.set-issue-property", SET_AFTER_ARGS, f.ports);
    expect(attempt).toEqual({
      ok: false,
      reason,
      detail: { messages: [UNVERIFIED_AFTER_ACK] },
      receipt: { issueId: "10002", issueKey: "SYN-2", propertyKey: KEY, propertyPresent: true },
    });
    expect(effects(f.selected)).toHaveLength(1);
    expect(JSON.stringify(attempt)).not.toContain("Nothing was written");
  },
);
it("refuses a delete that claims absence by naming what a delete takes", async () => {
  expect(
    await refusal("jira.delete-issue-property", {
      issueIdOrKey: "syn-2",
      propertyKey: KEY,
      expectedValueNodes: OLD_NODES,
      expectAbsent: true,
    }),
  ).toMatchObject({
    reason: "field-validation",
    detail: {
      messages: [
        "This call takes only issueIdOrKey, propertyKey, expectedValueNodes. Nothing was changed.",
      ],
    },
  });
});
describe("the sentence of a binding that failed", () => {
  const failed = (
    data: Record<string, unknown>,
  ): Parameters<typeof jiraPropertyBindingFailure>[0] =>
    ({ ok: false, result: { data } }) as unknown as Parameters<
      typeof jiraPropertyBindingFailure
    >[0];
  it("is about the entity, not the property, for a reason it does not know", () => {
    expect(jiraPropertyBindingFailure(failed({ outcome: "failed", reason: "unheard-of" }))).toEqual(
      {
        ok: false,
        reason: "malformed-payload",
        detail: {
          messages: [
            "Jira's answer about the entity could not be read completely. Nothing was written.",
          ],
        },
      },
    );
  });
  it("is added when a sanitized detail carries no explanation of its own", () => {
    expect(
      jiraPropertyBindingFailure(
        failed({ outcome: "failed", reason: "not-found", fieldId: "issueIdOrKey" }),
      ),
    ).toEqual({
      ok: false,
      reason: "not-found",
      detail: {
        fieldId: "issueIdOrKey",
        messages: [
          "The entity, or the parent it belongs to, was not found or is not visible to this connection. Check the entity arguments. Nothing was written.",
        ],
      },
    });
  });
  it("leaves Jira's own explanation as it is", () => {
    expect(
      jiraPropertyBindingFailure(
        failed({ outcome: "failed", reason: "not-found", messages: ["Jira's words"] }),
      ),
    ).toEqual({ ok: false, reason: "not-found", detail: { messages: ["Jira's words"] } });
  });
});
