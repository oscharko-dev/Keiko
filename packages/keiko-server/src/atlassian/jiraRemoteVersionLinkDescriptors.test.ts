import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  JIRA_REMOTE_VERSION_LINK_READ_DEFINITIONS,
  jiraRemoteVersionLinkDeclarationForTool,
} from "./jiraRemoteVersionLinkDescriptors.js";

function declaration(name: string) {
  const selected = jiraRemoteVersionLinkDeclarationForTool(name);
  if (selected === undefined) throw new TypeError("Missing remote version link declaration");
  return selected;
}
it("compiles only the three bounded fixed native link reads", () => {
  expect(Object.keys(JIRA_REMOTE_VERSION_LINK_READ_DEFINITIONS)).toHaveLength(3);
  for (const [name, definition] of Object.entries(JIRA_REMOTE_VERSION_LINK_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(declaration(name).risk).toBe("read");
  }
  expect(jiraRemoteVersionLinkDeclarationForTool("jira.set-version-remote-link")).toBeUndefined();
  expect(jiraRemoteVersionLinkDeclarationForTool("constructor")).toBeUndefined();
});
it.each([
  [
    "jira.remote-version-links",
    { globalId: "system=https://support.invalid&id=1", startAt: 0, maxResults: 100 },
  ],
  ["jira.version-remote-links", { versionId: "9223372036854775807" }],
  ["jira.version-remote-link", { versionId: "42", globalId: "system:123" }],
] as const)("admits exact bounded selection for %s", (name, args) => {
  expect(
    describeCatalogSchemaMismatch(declaration(name).descriptor.inputSchema, args),
  ).toBeUndefined();
});
it.each([
  ["jira.remote-version-links", {}],
  ["jira.remote-version-links", { globalId: "x", maxResults: 101 }],
  ["jira.version-remote-links", { versionId: 42 }],
  ["jira.version-remote-links", { versionId: "42", url: "https://external.invalid" }],
  ["jira.version-remote-link", { versionId: "42", globalId: "." }],
  ["jira.version-remote-link", { versionId: "42", globalId: "a/b" }],
  ["jira.version-remote-link", { versionId: "42", globalId: "a%2Fb" }],
  ["jira.version-remote-link", { versionId: "42", globalId: "selected", value: {} }],
] as const)("refuses arbitrary routes or unsupported selectors for %s", (name, args) => {
  expect(
    describeCatalogSchemaMismatch(declaration(name).descriptor.inputSchema, args),
  ).toBeDefined();
});
it("preserves complete typed nodes and unknown payloads without raw JSON or URL fields", () => {
  const schema = declaration("jira.version-remote-links").descriptor.resultSchema;
  const base = {
    outcome: "succeeded",
    linkScope: "native-version-links",
    versionId: "42",
    versionName: "Release",
    startAt: 0,
    total: 2,
  };
  const nodes = [
    { path: "", kind: "object", childCount: 1 },
    { path: "/value", kind: "boolean", booleanValue: false },
  ];
  expect(
    describeCatalogSchemaMismatch(schema, {
      ...base,
      items: [
        {
          reviewIdentityAvailable: true,
          globalId: "native:link",
          valueAvailable: true,
          valueNodes: nodes,
        },
        { reviewIdentityAvailable: false, valueAvailable: false },
      ],
    }),
  ).toBeUndefined();
  for (const row of [
    { valueAvailable: false, valueNodes: nodes },
    { valueAvailable: true },
    { valueAvailable: true, link: "{}" },
    { valueAvailable: false, self: "https://external.invalid" },
    { valueAvailable: true, valueNodes: [{ path: "", kind: "boolean", booleanValue: "false" }] },
  ])
    expect(
      describeCatalogSchemaMismatch(schema, {
        ...base,
        items: [{ reviewIdentityAvailable: false, ...row }],
      }),
    ).toBeDefined();
});
