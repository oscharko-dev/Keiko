import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort } from "@oscharko-dev/keiko-connectors";
import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  jiraApprovalFieldReferences,
  jiraApprovalTransitionTarget,
  reviewedJiraFieldNames,
  reviewedJiraTransition,
} from "./jiraChatApprovalNames.js";
import * as authority from "./jiraChatAuthority.js";

// R04 of the regression walk: the approval card for a status change showed "Transition 11" and the
// issue key. The server names the transition and the status it leads to from Jira's own answer for
// this issue, in the words Jira shows this person, when it builds the approval.
type Deps = Parameters<typeof reviewedJiraTransition>[0];
const REFERENCE = {
  envelopeDigest: "d".repeat(64),
} as unknown as EditorAgentGovernedAuthorityReference;
let logs: ReturnType<typeof createBufferedServerLogSink>;
let requested: { readonly method: string; readonly path: string }[];

beforeEach(() => {
  logs = createBufferedServerLogSink();
  requested = [];
  vi.spyOn(processServerLogSink(), "write").mockImplementation(logs.write);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function admitted(): void {
  vi.spyOn(authority, "resolveCurrentJiraChatAuthority").mockReturnValue({
    ok: true,
    credential: { baseUrl: "https://jira.example.invalid", deployment: "data-center" },
  } as unknown as ReturnType<typeof authority.resolveCurrentJiraChatAuthority>);
}
function respond(status: number, body: unknown): ReturnType<AtlassianHttpBodyPort> {
  const bodyText = JSON.stringify(body);
  return Promise.resolve({
    kind: "response",
    status,
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText),
    truncated: false,
  });
}
function deps(answer: (path: string) => ReturnType<AtlassianHttpBodyPort>): Deps {
  const factory: NonNullable<
    UiHandlerDeps["atlassianConnectorCredentials"]
  >["httpBodyPortFactory"] = (_metadata, _correlation, lifecycle) => (request) => {
    if (lifecycle?.beforeDispatch?.(request) !== true) throw new TypeError("not admitted");
    const path = new URL(request.url).pathname;
    requested.push({ method: request.method, path });
    lifecycle.onResponse?.(request, 200);
    return answer(path);
  };
  return {
    atlassianConnectorCredentials: { httpBodyPortFactory: factory },
    redactor: (value: unknown) => value,
  } as unknown as Deps;
}
const OPTIONS = (extra: object = {}): Parameters<typeof reviewedJiraTransition>[1] => ({
  chatId: "chat-1",
  authorityReference: REFERENCE,
  signal: new AbortController().signal,
  correlationId: "corr-transition",
  ...extra,
});
const TARGET = { issueKey: "REQ-4", transitionId: "11" } as const;
const GERMAN = {
  transitions: [
    { id: "21", name: "Erledigen", to: { id: "9", name: "Erledigt" } },
    { id: "11", name: "Fortschritt starten", to: { id: "3", name: "In Arbeit" } },
  ],
};
const line = (): string =>
  formatActivityLogProofLine(
    logs.events.at(-1) ??
      ((): never => {
        throw new TypeError("No Activity Log line was written");
      })(),
  );

describe("which transition an approval's action covers", () => {
  it("takes the issue key and transition id of a jira.transition, and nothing from any other call", () => {
    expect(jiraApprovalTransitionTarget("jira.transition", TARGET)).toEqual(TARGET);
    expect(jiraApprovalTransitionTarget("jira.edit", TARGET)).toBeUndefined();
    expect(
      jiraApprovalTransitionTarget("jira.transition", { issueKey: "REQ-4", transitionId: 11 }),
    ).toBeUndefined();
    expect(
      jiraApprovalTransitionTarget("jira.transition", {
        issueKey: "../issue",
        transitionId: "11",
      }),
    ).toBeUndefined();
    expect(
      jiraApprovalTransitionTarget("jira.transition", { issueKey: "REQ-4", transitionId: "x1" }),
    ).toBeUndefined();
  });
});

describe("reading the transition an approval names", () => {
  it("returns the transition's name and its target status in Jira's words, through one GET", async () => {
    admitted();
    const shown = await reviewedJiraTransition(
      deps(() => respond(200, GERMAN)),
      OPTIONS(),
      TARGET,
    );
    expect(shown).toEqual({
      ref: "11",
      name: "Fortschritt starten",
      targetStatusName: "In Arbeit",
    });
    expect(requested).toEqual([{ method: "GET", path: "/rest/api/2/issue/REQ-4/transitions" }]);
    expect(expectActivityLogProof("jira.approval.names.line", line())).toMatchObject({
      op: "jira.approval.names",
      level: "info",
      kind: "transition",
      requestedCount: 1,
      resolvedCount: 1,
      failure: "none",
    });
    // Body-free: the line carries counts and a closed value, never a key, a name or an id.
    expect(JSON.stringify(logs.events)).not.toMatch(/Fortschritt|In Arbeit|REQ-4/u);
  });

  it("names nothing a card cannot show and keeps the other name", async () => {
    admitted();
    const shown = await reviewedJiraTransition(
      deps(() =>
        respond(200, {
          transitions: [{ id: "11", name: "Start\u0007", to: { name: "In Arbeit" } }],
        }),
      ),
      OPTIONS(),
      TARGET,
    );
    expect(shown).toEqual({ ref: "11", targetStatusName: "In Arbeit" });
  });

  it.each([
    [404, "not-found", "info"],
    [503, "timeout", "warn"],
  ])(
    "leaves the reference alone when Jira answers %i and records %s at %s",
    async (status, failure, level) => {
      admitted();
      const shown = await reviewedJiraTransition(
        deps(() => respond(status, {})),
        OPTIONS({ timeoutMs: 300 }),
        TARGET,
      );
      expect(shown).toEqual({ ref: "11" });
      expect(expectActivityLogProof("jira.approval.names.line", line())).toMatchObject({
        level,
        resolvedCount: 0,
        failure,
      });
    },
  );

  it("leaves the reference alone for a transition the issue does not offer", async () => {
    admitted();
    const shown = await reviewedJiraTransition(
      deps(() => respond(200, { transitions: [{ id: "21", name: "Erledigen" }] })),
      OPTIONS(),
      TARGET,
    );
    expect(shown).toEqual({ ref: "11" });
    expect(logs.events.at(-1)?.extra).toMatchObject({ failure: "invalid-transition" });
    expect(logs.events.at(-1)?.level).toBe("info");
  });

  it("refuses a malformed answer instead of showing a name it cannot trust", async () => {
    admitted();
    const shown = await reviewedJiraTransition(
      deps(() => respond(200, { transitions: "none" })),
      OPTIONS(),
      TARGET,
    );
    expect(shown).toEqual({ ref: "11" });
    expect(logs.events.at(-1)?.extra).toMatchObject({ failure: "malformed-payload" });
    expect(logs.events.at(-1)?.level).toBe("warn");
  });

  it("reads nothing when the authority is not current, and records that it was not admitted", async () => {
    vi.spyOn(authority, "resolveCurrentJiraChatAuthority").mockReturnValue({
      ok: false,
    } as unknown as ReturnType<typeof authority.resolveCurrentJiraChatAuthority>);
    expect(
      await reviewedJiraTransition(
        deps(() => respond(200, GERMAN)),
        OPTIONS(),
        TARGET,
      ),
    ).toEqual({ ref: "11" });
    expect(requested).toEqual([]);
    expect(logs.events.at(-1)?.extra).toMatchObject({ failure: "not-admitted", resolvedCount: 0 });
    expect(logs.events.at(-1)?.level).toBe("info");
  });

  it("is absent for a write that is no transition and reads nothing", async () => {
    admitted();
    expect(
      await reviewedJiraTransition(
        deps(() => respond(200, GERMAN)),
        OPTIONS(),
        undefined,
      ),
    ).toBeUndefined();
    expect(requested).toEqual([]);
    expect(logs.events).toEqual([]);
  });

  it("falls back to the reference when the lookup throws, and says so as a closed failure", async () => {
    admitted();
    const shown = await reviewedJiraTransition(
      deps(() => {
        throw new TypeError("boom");
      }),
      OPTIONS(),
      TARGET,
    );
    expect(shown).toEqual({ ref: "11" });
    expect(logs.events.at(-1)?.extra).toMatchObject({ failure: "failed" });
  });
});

// R04 (a): a carried field showed as `customfield_10112`. The server names the fields a write carries
// from one read of the instance's field list, in the words Jira shows this person.
const FIELD_LIST = [
  { id: "customfield_10112", name: "Geschätzte Punkte" },
  { id: "summary", name: "Zusammenfassung" },
  { id: "customfield_99999", name: "Nicht gefragt" },
];

describe("which fields an approval's action carries", () => {
  const none = {};
  it("lists the keys of fields, of each update and of a draft's items once", () => {
    expect(
      jiraApprovalFieldReferences(none, "chat-1", "jira.transition", {
        issueKey: "REQ-4",
        transitionId: "11",
        fields: { customfield_10112: 5, resolution: { name: "Done" } },
        updates: [
          { fieldId: "labels", operation: "add", value: "x" },
          { fieldId: "customfield_10112" },
        ],
      }),
    ).toEqual(["customfield_10112", "resolution", "labels"]);
    expect(jiraApprovalFieldReferences(none, "chat-1", "jira.edit", { issueKey: "REQ-4" })).toEqual(
      [],
    );
  });
  it("never takes a key that is not a field id", () => {
    expect(
      jiraApprovalFieldReferences(none, "chat-1", "jira.edit", {
        fields: { "a b": 1, "../x": 2, ok1: 3 },
      }),
    ).toEqual(["ok1"]);
  });
});

describe("reading the field names an approval shows", () => {
  it("returns only the requested fields, as Jira names them, through one GET", async () => {
    admitted();
    const names = await reviewedJiraFieldNames(
      deps(() => respond(200, FIELD_LIST)),
      OPTIONS(),
      ["customfield_10112", "summary", "unlisted"],
    );
    expect(names).toEqual([
      { id: "customfield_10112", name: "Geschätzte Punkte" },
      { id: "summary", name: "Zusammenfassung" },
    ]);
    expect(requested).toEqual([{ method: "GET", path: "/rest/api/2/field" }]);
    expect(expectActivityLogProof("jira.approval.names.line", line())).toMatchObject({
      op: "jira.approval.names",
      kind: "fields",
      requestedCount: 3,
      resolvedCount: 2,
      failure: "none",
    });
    expect(JSON.stringify(logs.events)).not.toMatch(/Geschätzte|customfield_10112/u);
  });
  it("is absent when the write carries no field, reading nothing", async () => {
    admitted();
    const names = await reviewedJiraFieldNames(
      deps(() => respond(200, FIELD_LIST)),
      OPTIONS(),
      [],
    );
    expect(names).toBeUndefined();
    expect(requested).toEqual([]);
  });
  it("is absent, with the failure recorded, when the list cannot be read", async () => {
    admitted();
    expect(
      await reviewedJiraFieldNames(
        deps(() => respond(404, {})),
        OPTIONS({ timeoutMs: 300 }),
        ["customfield_10112"],
      ),
    ).toBeUndefined();
    expect(logs.events.at(-1)?.extra).toMatchObject({ kind: "fields", failure: "not-found" });
  });
  it("shows no name a card must not show", async () => {
    admitted();
    const names = await reviewedJiraFieldNames(
      deps(() => respond(200, [{ id: "customfield_1", name: "Bad\u0007" }])),
      OPTIONS(),
      ["customfield_1"],
    );
    expect(names).toBeUndefined();
  });
});
