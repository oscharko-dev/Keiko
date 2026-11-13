import { describe, expect, it } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationContracts } from "./jiraManagedProvider.js";

// #4290 AC2 / #4357: what a model may put in the arguments of a Jira operation. The request URL,
// method, headers, credentials and authority belong to the server-owned operation contract; the
// argument schema is the only door a model has, so it has to be closed to every one of them.
const TRANSPORT_FIELDS = {
  url: "https://attacker.invalid/rest/api/2/project",
  baseUrl: "https://attacker.invalid",
  method: "DELETE",
  headers: { Authorization: "Bearer stolen" },
  authorization: "Bearer stolen",
  cookie: "JSESSIONID=stolen",
  credentials: { username: "admin", password: "stolen" },
  authority: "admin",
  endpoint: "/rest/api/2/project",
} as const;
const FORBIDDEN_ROOT_PROPERTIES = new Set([
  ...Object.keys(TRANSPORT_FIELDS),
  "uri",
  "path",
  "host",
  "origin",
  "header",
  "token",
  "apiKey",
  "password",
  "pat",
  "bearer",
  "authToken",
  "accessToken",
  "requestUrl",
  "httpMethod",
]);

/** A project's own website field: stored as Jira data, never fetched and never a request target. */
const PROJECT_URL_DATA = new Set(["jira.create-project.url", "jira.update-project.url"]);
type Schema = Readonly<Record<string, unknown>>;

/** Closed directly, or through a `oneOf` whose every branch is closed (jira.draft's two forms). */
function closed(schema: Schema): boolean {
  if (schema.additionalProperties === false) return true;
  const branches = schema.oneOf;
  return (
    Array.isArray(branches) &&
    branches.length > 0 &&
    branches.every((branch) => closed(branch as Schema))
  );
}
function rootProperties(schema: Schema): readonly string[] {
  const own = schema.properties;
  const direct =
    typeof own === "object" && own !== null && !Array.isArray(own) ? Object.keys(own) : [];
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  return [...direct, ...branches.flatMap((branch) => rootProperties(branch as Schema))];
}

describe("model arguments cannot supply a request, credentials or authority", () => {
  const contracts = jiraOperationContracts();

  it("covers every operation of the registry", () => {
    expect(contracts.length).toBeGreaterThan(300);
  });

  it("closes the argument schema of every operation to undeclared properties", () => {
    const open = contracts
      .filter((contract) => !closed(contract.declaration.descriptor.inputSchema))
      .map((contract) => contract.definition.tool);
    expect(open).toEqual([]);
  });

  it("declares no root argument that names a URL, method, header, credential or authority", () => {
    const offending = contracts
      .flatMap((contract) =>
        rootProperties(contract.declaration.descriptor.inputSchema)
          .filter((name) => FORBIDDEN_ROOT_PROPERTIES.has(name))
          .map((name) => `${contract.definition.tool}.${name}`),
      )
      .filter((entry) => !PROJECT_URL_DATA.has(entry));
    expect(offending).toEqual([]);
  });

  it.each(["jira.projects", "jira.issue", "jira.comment", "jira.assign", "jira.draft"])(
    "refuses %s with any transport or authority field added to otherwise valid arguments",
    (tool) => {
      const contract = contracts.find((entry) => entry.definition.tool === tool);
      if (contract === undefined) throw new TypeError(`Missing contract ${tool}`);
      const schema = contract.declaration.descriptor.inputSchema;
      const valid = validArguments(tool);
      expect(describeCatalogSchemaMismatch(schema, valid), "control").toBeUndefined();
      for (const [name, value] of Object.entries(TRANSPORT_FIELDS)) {
        const refused = describeCatalogSchemaMismatch(schema, { ...valid, [name]: value });
        expect(refused, name).toBeDefined();
        expect(JSON.stringify(refused), name).not.toContain("attacker");
      }
    },
  );
});

function validArguments(tool: string): Record<string, unknown> {
  switch (tool) {
    case "jira.projects":
      return {};
    case "jira.issue":
      return { issueKey: "SYN-1" };
    case "jira.comment":
      return { issueKey: "SYN-1", body: "A synthetic comment." };
    case "jira.draft":
      return { draftId: "123e4567-e89b-42d3-a456-426614174000", draftDigest: "a".repeat(64) };
    default:
      return { issueKey: "SYN-1", clearAssignee: true };
  }
}
