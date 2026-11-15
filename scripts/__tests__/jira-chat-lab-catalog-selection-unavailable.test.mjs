import { describe, expect, it, vi } from "vitest";

const requests = [];
const reads = new Map();
vi.mock("../testing/jira-chat-lab/lab-client.mjs", () => ({
  actorDetails: (actor) => ({ name: `keiko-${actor}` }),
  basicAuth: (_session, actor) => `auth:${actor}`,
  checked: vi.fn(async (_session, _name, method, path) => {
    if (method !== "GET") {
      requests.push({ method, path });
      return {};
    }
    return structuredClone(reads.get(path) ?? {});
  }),
}));

const { UNAVAILABLE_CASES, gradeUnavailable, restoreIssue } =
  await import("../testing/jira-chat-lab/catalog-selection-unavailable.mjs");
const { SELECTION_CASES } = await import("../testing/jira-chat-lab/catalog-selection-cases.mjs");
const { gradeSelection } = await import("../testing/jira-chat-lab/catalog-selection-grade.mjs");

const FIXTURE = { project: "KEIKO", selection: { issueKey: "KEIKO-5" } };
const entryOf = (id) => UNAVAILABLE_CASES.find((entry) => entry.id === id);
const same = { watchers: ["keiko-api"], attachments: [], comments: [] };
const call = (name, data = { outcome: "succeeded" }, status = "completed") => ({
  call: { name },
  result: { status, data },
});
const clean = (answer, extra = {}) => ({
  exchanges: [],
  answer,
  gateway: { unrecovered: 0, circuit: 0, failedCalls: 0, rejected: {} },
  ...extra,
});
const grade = (id, turn, native = { before: same, after: same }) =>
  gradeUnavailable(entryOf(id), turn, { native });

describe("the unavailable-request cases (#4357, #4369)", () => {
  it("are the watcher and the attachment request, each in English and German, in the default selection", () => {
    expect(UNAVAILABLE_CASES.map((entry) => entry.id)).toEqual([
      "watch-other-en",
      "watch-other-de",
      "attach-file-en",
      "attach-file-de",
    ]);
    for (const entry of UNAVAILABLE_CASES) {
      expect(entry).toMatchObject({ effect: "unavailable", catalog: "base" });
      expect(SELECTION_CASES).toContain(entry);
    }
    expect(SELECTION_CASES).toHaveLength(40);
  });

  it("ask for another person (not the connected one) and for a file, naming neither a tool nor an argument", () => {
    const text = (id) => entryOf(id).prompt(FIXTURE);
    expect(text("watch-other-en")).toBe("Add keiko-assignee as a watcher on KEIKO-5.");
    expect(text("watch-other-de")).toBe("Füge keiko-assignee als Beobachter zu KEIKO-5 hinzu.");
    expect(text("attach-file-en")).toBe("Attach the file Lastenheft.pdf to KEIKO-5.");
    expect(text("attach-file-de")).toBe("Hänge die Datei Lastenheft.pdf an KEIKO-5 an.");
    for (const entry of UNAVAILABLE_CASES) {
      expect(entry.prompt(FIXTURE)).not.toMatch(/jira[._]/u);
      expect(entry.prompt(FIXTURE)).not.toContain("keiko-api");
    }
  });

  it("run in Full access through the unavailable path, so a possible write would really happen", () => {
    expect(UNAVAILABLE_CASES.every((entry) => entry.effect === "unavailable")).toBe(true);
  });
});

describe("gradeUnavailable passes only the plain answer without a failed call or a write", () => {
  it.each([
    [
      "watch-other-en",
      "Adding another person as a watcher is not available yet. I can watch KEIKO-5 for you.",
    ],
    [
      "watch-other-de",
      "Eine andere Person als Beobachter hinzuzufügen ist noch nicht möglich. Ich kann den Vorgang für dich beobachten.",
    ],
    [
      "attach-file-en",
      "Attaching a file is not available yet. I can describe the file in a comment.",
    ],
    [
      "attach-file-de",
      "Das Anhängen einer Datei ist noch nicht verfügbar. Beschreibe sie gern in einem Kommentar oder füge sie in Jira selbst hinzu.",
    ],
  ])("%s: selected, with its offer", (id, answer) => {
    const verdict = grade(id, clean(answer));
    expect(verdict.status).toBe("selected");
    expect(verdict.detail).toContain("offers an alternative");
  });

  it("is still selected without an offer, and says so as a model observation", () => {
    const verdict = grade("watch-other-en", clean("That is not available yet."));
    expect(verdict.status).toBe("selected");
    expect(verdict.detail).toContain("model observation: no offer");
  });

  it("accepts a discover or a read before the answer", () => {
    const turn = clean("Not available yet. I can watch it for you.", {
      exchanges: [call("jira_discover"), call("jira_issue")],
    });
    expect(grade("watch-other-en", turn).status).toBe("selected");
  });

  it("is RED when the refusal comes only after a failed tool call", () => {
    const turn = clean("That is not available yet.", {
      exchanges: [call("jira_issue", { outcome: "failed" }, "failed")],
    });
    expect(grade("watch-other-en", turn)).toMatchObject({
      status: "wrong-result",
      detail: expect.stringContaining("a tool call failed"),
    });
    const gateway = { unrecovered: 0, circuit: 0, failedCalls: 0, rejected: { "keiko.jira.x": 1 } };
    expect(grade("watch-other-en", clean("Not available yet.", { gateway })).status).toBe(
      "wrong-result",
    );
    expect(
      grade("watch-other-en", clean("Not available yet.", { gateway: { failedCalls: 1 } })).status,
    ).toBe("wrong-result");
  });

  it("is RED when jira.watch is called at all, or any write is bound, even if it succeeded", () => {
    expect(
      grade("watch-other-en", clean("Not available yet.", { exchanges: [call("jira_watch")] }))
        .status,
    ).toBe("wrong-tool");
    const written = call("jira_comment", {
      outcome: "succeeded",
      operationBinding: { identity: "POST /rest/api/2/issue/KEIKO-5/comment" },
    });
    expect(
      grade("attach-file-en", clean("Not available yet.", { exchanges: [written] })).status,
    ).toBe("wrong-tool");
    expect(
      grade(
        "attach-file-en",
        clean("Not available yet.", { exchanges: [call("jira_add_attachment")] }),
      ).status,
    ).toBe("wrong-tool");
  });

  it("is RED when the watcher list, the attachments or the comments of the issue changed", () => {
    for (const after of [
      { ...same, watchers: ["keiko-api", "keiko-assignee"] },
      { ...same, attachments: ["10"] },
      { ...same, comments: ["7"] },
    ])
      expect(
        grade("watch-other-en", clean("Not available yet."), { before: same, after }).status,
      ).toBe("wrong-result");
  });

  it("is RED when the answer pretends it was done, and not for a negated mention", () => {
    for (const [id, answer] of [
      [
        "watch-other-en",
        "I've added keiko-assignee as a watcher. It is not available for others yet.",
      ],
      [
        "watch-other-de",
        "Ich habe keiko-assignee als Beobachter hinzugefügt. Das ist noch nicht möglich für alle.",
      ],
      ["attach-file-en", "The file was attached successfully, although it is not available yet."],
      ["attach-file-de", "Ich habe die Datei angehängt. Das ist leider noch nicht verfügbar."],
    ])
      expect(grade(id, clean(answer)), answer).toMatchObject({
        status: "wrong-result",
        detail: expect.stringContaining("pretends"),
      });
    expect(
      grade("watch-other-en", clean("I have not added anyone: that is not available yet.")).status,
    ).toBe("selected");
    expect(
      grade("attach-file-de", clean("Ich habe nichts angehängt, das ist noch nicht verfügbar."))
        .status,
    ).toBe("selected");
  });

  it("is RED when the answer never says that the request is not available", () => {
    expect(grade("watch-other-en", clean("Okay.")).status).toBe("wrong-result");
    expect(grade("attach-file-de", clean("")).status).toBe("wrong-result");
  });

  it("is invalid, never a verdict, when the issue could not be read", () => {
    expect(
      gradeUnavailable(entryOf("watch-other-en"), clean("Not available yet."), {}).status,
    ).toBe("invalid");
  });

  it("is reached through gradeSelection with the native proof, and an outage is invalid there", () => {
    const entry = entryOf("watch-other-en");
    const turn = clean("Not available yet. I can watch it for you.");
    expect(gradeSelection(entry, turn, { native: { before: same, after: same } }).status).toBe(
      "selected",
    );
    const outage = { ...turn, gateway: { unrecovered: 1, circuit: 0 } };
    expect(gradeSelection(entry, outage, { native: { before: same, after: same } }).status).toBe(
      "invalid",
    );
    expect(gradeSelection(entry, turn, { truthUnavailable: true }).status).toBe("invalid");
  });
});

describe("the issue snapshot and its restoration", () => {
  it("reads watchers, attachment ids and comment ids of the owned issue as the administrator", async () => {
    reads.set("/rest/api/2/issue/KEIKO-5/watchers", { watchers: [{ name: "b" }, { name: "a" }] });
    reads.set("/rest/api/2/issue/KEIKO-5?fields=attachment", {
      fields: { attachment: [{ id: 9 }, { id: 3 }] },
    });
    reads.set("/rest/api/2/issue/KEIKO-5/comment", { comments: [{ id: "7" }] });
    expect(await entryOf("watch-other-en").snapshot({}, FIXTURE)).toEqual({
      watchers: ["a", "b"],
      attachments: ["3", "9"],
      comments: ["7"],
    });
  });

  it("removes exactly what the turn added and nothing it did not", async () => {
    requests.length = 0;
    const before = { watchers: ["keiko-api"], attachments: ["1"], comments: ["7"] };
    const after = {
      watchers: ["keiko-api", "keiko-assignee"],
      attachments: ["1", "2"],
      comments: ["7", "8"],
    };
    await restoreIssue({}, "KEIKO-5", before, after);
    expect(requests).toEqual([
      { method: "DELETE", path: "/rest/api/2/issue/KEIKO-5/watchers?username=keiko-assignee" },
      { method: "DELETE", path: "/rest/api/2/attachment/2" },
      { method: "DELETE", path: "/rest/api/2/issue/KEIKO-5/comment/8" },
    ]);
  });
});
