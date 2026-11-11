import { describe, expect, it } from "vitest";
import { jiraRemoteVersionLinkDetails as details } from "./jira-remote-version-link-presentation";

describe("saved remote version link values", () => {
  it("reuses typed property paths and keeps literal JSON-looking text as text", () => {
    const cards = details("jira_version_remote_link", {
      outcome: "succeeded",
      versionId: "9223372036854775807",
      versionName: "Release",
      selectedGlobalId: "reviewed-id",
      items: [
        {
          name: "Native link name",
          valueAvailable: true,
          valueNodes: [
            { path: "", kind: "object", childCount: 2 },
            { path: "/a~0~1b", kind: "string", textValue: '{"url":"https://untrusted.invalid"}' },
            { path: "/", kind: "null" },
          ],
        },
      ],
    });
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.fact.versionId",
      value: "9223372036854775807",
    });
    expect(cards[1]?.facts).toContainEqual({
      label: "chat.jira.versionLinks.name",
      value: "Native link name",
    });
    expect(cards[2]?.labels).toContain("chat.jira.properties.root");
    expect(cards[3]?.body).toBe('{"url":"https://untrusted.invalid"}');
    expect(cards[3]?.facts).toContainEqual({
      label: "chat.jira.properties.pointer",
      value: "/a~0~1b",
    });
    expect(cards[4]?.labels).toContain("chat.jira.properties.null");
    expect(cards[4]?.facts).toContainEqual({ label: "chat.jira.properties.pointer", value: "/" });
    for (const card of cards.slice(1))
      expect(card.facts).toContainEqual({ label: "chat.jira.versionLinks.position", value: "1" });
  });
  it("keeps absent content distinct from real null, empty containers, false and zero", () => {
    const values = [
      { path: "", kind: "null" },
      { path: "", kind: "object", childCount: 0 },
      { path: "", kind: "array", childCount: 0 },
      { path: "", kind: "boolean", booleanValue: false },
      { path: "", kind: "number", numberValue: 0 },
    ];
    const cards = details("jira_remote_version_links", {
      outcome: "succeeded",
      selectedGlobalId: "selected-context",
      startAt: 5,
      items: [
        {
          valueAvailable: false,
          valueNodes: [{ path: "", kind: "string", textValue: "Ignored stale value" }],
        },
        ...values.map((node) => ({ valueAvailable: true, valueNodes: [node] })),
      ],
    });
    expect(cards[1]?.labels).toEqual([
      "chat.jira.versionLinkWrite.identityUnavailable",
      "chat.jira.versionLinks.valueUnknown",
    ]);
    expect(cards[1]?.facts).toContainEqual({
      label: "chat.jira.versionLinks.position",
      value: "6",
    });
    expect(cards.flatMap((card) => card.labels)).toEqual(
      expect.arrayContaining([
        "chat.jira.properties.null",
        "chat.jira.properties.emptyObject",
        "chat.jira.properties.emptyArray",
        "chat.jira.properties.false",
      ]),
    );
    expect(cards.flatMap((card) => card.facts)).toContainEqual({
      label: "chat.jira.properties.value",
      value: "0",
    });
    expect(cards.some((card) => card.body === "Ignored stale value")).toBe(false);
    expect(cards[0]?.facts.some((entry) => entry.label === "chat.jira.fact.versionId")).toBe(false);
  });
  it("keeps unavailable collections and explicit empty collections distinct", () => {
    expect(details("jira_version_remote_links", { outcome: "succeeded" })[0]?.labels).toContain(
      "chat.jira.versionLinks.listUnknown",
    );
    expect(
      details("jira_version_remote_links", { outcome: "succeeded", items: [] })[0]?.labels,
    ).toContain("chat.jira.versionLinks.emptyList");
    expect(details("jira_version_remote_links", { outcome: "failed", items: [] })).toEqual([]);
    expect(details("jira_issue", { outcome: "succeeded", items: [] })).toEqual([]);
  });
});
