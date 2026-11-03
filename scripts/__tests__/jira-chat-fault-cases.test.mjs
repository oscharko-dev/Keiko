import { beforeEach, expect, it, vi } from "vitest";
import { readFaultState } from "../testing/jira-chat-lab/chat-fault-cases.mjs";
import { issueState, projectState } from "../testing/jira-chat-lab/catalog-state.mjs";
import { commentState } from "../testing/jira-chat-lab/chat-write.mjs";

vi.mock("../testing/jira-chat-lab/catalog-state.mjs", () => ({
  issueState: vi.fn(),
  projectState: vi.fn(),
  remoteRead: vi.fn(),
}));
vi.mock("../testing/jira-chat-lab/chat-write.mjs", () => ({ commentState: vi.fn() }));

beforeEach(() => {
  vi.mocked(projectState).mockResolvedValue({ count: 1, digest: "synthetic" });
  vi.mocked(issueState).mockResolvedValue({ historyCount: 1, fields: { summary: "Synthetic" } });
  vi.mocked(commentState).mockResolvedValue({ total: 1, matches: 1 });
});

it.each(["jira.create", "jira.edit", "jira.assign", "jira.comment", "jira.transition"])(
  "preserves the independent %s witness across a private JSON/process boundary",
  async (operation) => {
    const state = await readFaultState(
      {},
      { operation, fieldId: "customfield_1", marker: "Synthetic" },
      "SYN-1",
    );
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state.comments).toEqual(
      operation === "jira.comment" ? { total: 1, matches: 1 } : undefined,
    );
  },
);
