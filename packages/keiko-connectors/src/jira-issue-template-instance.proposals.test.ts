import { describe, expect, it } from "vitest";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { proposeJiraIssueTemplates } from "./jira-issue-template-instance.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { REQUIRED_CUSTOM, field } from "../../../tests/support/jira-managed-remote.js";

// #4354 F04: a lead asked Keiko to propose templates for a project and got proposals for some types
// only, without a word about the others. Every issue type of the project is accounted for: a proposal,
// or one closed reason why there is none, and the type count equals the two together.
interface FakeType {
  readonly id: string;
  readonly name: string;
  readonly subtask?: boolean;
  /** What the create metadata answers: fields, or a failure of the read. */
  readonly metadata: "none" | "required-field" | "unavailable";
  /** The sampled descriptions, or a failed search. */
  readonly samples: readonly string[] | "unavailable";
}

const STRUCTURED = [
  "h2. Beschreibung\nWas?\nh2. Akzeptanzkriterien\n* eins",
  "h2. Beschreibung\nWarum?\nh2. Akzeptanzkriterien\n* zwei",
];
const ok = (body: Record<string, unknown>): AtlassianWriteHttpOutcome => ({
  ok: true,
  status: 200,
  body,
});
const unavailable: AtlassianWriteHttpOutcome = { ok: false, reason: "unavailable" };

function projectReply(types: readonly FakeType[]): AtlassianWriteHttpOutcome {
  return ok({
    id: "10000",
    key: "REQ",
    issueTypes: types.map(({ id, name, subtask }) => ({
      id,
      name,
      ...(subtask === undefined ? {} : { subtask }),
    })),
  });
}
function metadataReply(type: FakeType | undefined): AtlassianWriteHttpOutcome {
  if (type?.metadata === "unavailable") return unavailable;
  const values =
    type?.metadata === "required-field"
      ? [field("summary", "string", true), REQUIRED_CUSTOM]
      : [field("summary", "string", true)];
  return ok({ values, total: values.length, startAt: 0, maxResults: 100, isLast: true });
}
function searchReply(type: FakeType | undefined): AtlassianWriteHttpOutcome {
  if (type?.samples === "unavailable") return unavailable;
  return ok({ issues: (type?.samples ?? []).map((description) => ({ fields: { description } })) });
}

function jira(types: readonly FakeType[]): JiraMutationRequest {
  return (path) => {
    if (path === "project/REQ") return Promise.resolve(projectReply(types));
    const meta = /^issue\/createmeta\/10000\/issuetypes\/(\d+)\?/u.exec(path);
    if (meta !== null)
      return Promise.resolve(metadataReply(types.find((candidate) => candidate.id === meta[1])));
    if (!path.startsWith("search?")) return Promise.resolve(unavailable);
    const jql = new URLSearchParams(path.slice("search?".length)).get("jql") ?? "";
    return Promise.resolve(
      searchReply(types.find((candidate) => jql.includes(`issuetype = ${candidate.id} `))),
    );
  };
}

async function propose(types: readonly FakeType[]): Promise<{
  readonly proposals: readonly { readonly issueType: string }[];
  readonly withoutProposal: readonly { readonly issueType: string; readonly reason: string }[];
  readonly typeCount: number;
}> {
  const result = await proposeJiraIssueTemplates(jira(types), "REQ");
  if (!result.ok) throw new TypeError("The proposal read failed");
  return result;
}

describe("proposeJiraIssueTemplates accounts for every issue type of the project (#4354 F04)", () => {
  const FIVE: readonly FakeType[] = [
    { id: "1", name: "Task", metadata: "none", samples: STRUCTURED },
    { id: "2", name: "Story", metadata: "none", samples: [] },
    { id: "3", name: "Bug", metadata: "unavailable", samples: "unavailable" },
    { id: "4", name: "Epic", metadata: "required-field", samples: [] },
    { id: "5", name: "Sub-task", subtask: true, metadata: "none", samples: [] },
  ];

  it("returns a proposal or one closed reason for each type, and the count says so", async () => {
    const result = await propose(FIVE);
    expect(result.typeCount).toBe(5);
    expect(result.proposals.map((proposal) => proposal.issueType)).toEqual(["Task", "Epic"]);
    expect(result.withoutProposal).toEqual([
      { issueType: "Story", reason: "nothing-to-learn" },
      { issueType: "Bug", reason: "jira-unavailable" },
      { issueType: "Sub-task", reason: "nothing-to-learn" },
    ]);
    expect(result.proposals.length + result.withoutProposal.length).toBe(result.typeCount);
  });

  it("calls a failed metadata read or sample search unavailable, never nothing to learn", async () => {
    const result = await propose([
      { id: "1", name: "Task", metadata: "unavailable", samples: [] },
      { id: "2", name: "Story", metadata: "none", samples: "unavailable" },
    ]);
    expect(result.withoutProposal).toEqual([
      { issueType: "Task", reason: "jira-unavailable" },
      { issueType: "Story", reason: "jira-unavailable" },
    ]);
  });

  it("keeps a proposal that one read supports when the other read failed", async () => {
    const result = await propose([
      { id: "1", name: "Task", metadata: "required-field", samples: "unavailable" },
    ]);
    expect(result.proposals.map((proposal) => proposal.issueType)).toEqual(["Task"]);
    expect(result.withoutProposal).toEqual([]);
  });

  it("names the types beyond the limit instead of dropping them", async () => {
    const many = Array.from({ length: 14 }, (_, index): FakeType => ({
      id: String(index + 1),
      name: `Type ${String(index + 1)}`,
      metadata: "required-field",
      samples: [],
    }));
    const result = await propose(many);
    expect(result.typeCount).toBe(14);
    expect(result.proposals).toHaveLength(12);
    expect(result.withoutProposal).toEqual([
      { issueType: "Type 13", reason: "beyond-limit" },
      { issueType: "Type 14", reason: "beyond-limit" },
    ]);
  });

  it("reports a template that does not parse as template-invalid", async () => {
    const result = await propose([
      { id: "1", name: "Bad\nType", metadata: "required-field", samples: [] },
    ]);
    expect(result.withoutProposal).toEqual([{ issueType: "Bad Type", reason: "template-invalid" }]);
  });

  it("bounds a type name, and the count stays true for a very wide project", async () => {
    const long = "L".repeat(400);
    const result = await propose([{ id: "1", name: long, metadata: "none", samples: [] }]);
    expect(result.withoutProposal[0]?.issueType).toHaveLength(255);
    const many = Array.from({ length: 150 }, (_, index): FakeType => ({
      id: String(index + 1),
      name: `T${String(index + 1)}`,
      metadata: "none",
      samples: [],
    }));
    const wide = await propose(many);
    expect(wide.typeCount).toBe(150);
    expect(wide.proposals.length + wide.withoutProposal.length).toBe(150);
  });
});
