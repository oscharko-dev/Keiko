import { describe, expect, it } from "vitest";
import { JIRA_TOOL_GUIDANCE } from "./jiraToolGuidance.js";
import { jiraOperationContracts } from "./jiraManagedProvider.js";
import type { JiraOperationContract } from "./jiraOperationRegistry.js";

type Schema = Readonly<Record<string, unknown>>;
/** Root property names of an input schema, including the branches of a root `oneOf`. */
function rootProperties(schema: Schema): readonly string[] {
  const own = schema.properties;
  const direct =
    typeof own === "object" && own !== null && !Array.isArray(own) ? Object.keys(own) : [];
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  return [...direct, ...branches.flatMap((branch) => rootProperties(branch as Schema))];
}
const declaring = (matches: (name: string) => boolean): readonly JiraOperationContract[] =>
  jiraOperationContracts().filter((contract) =>
    rootProperties(contract.declaration.descriptor.inputSchema).some(matches),
  );

describe("shared Jira tool guidance", () => {
  // #4357: a deployment model told the person that no delete operation exists although
  // jira.delete-issue is selectable through discovery, and models answered "who am I" and "project
  // statuses" with a different visible tool instead of searching. A base catalog cannot list every
  // operation, so the one shared instruction says WHEN to search: whenever no offered tool does what
  // was asked, before saying it cannot be done, and never to substitute another tool's result.
  it("says when to search, forbids claiming an operation absent unseen, and forbids substituting a result", () => {
    expect(JIRA_TOOL_GUIDANCE).toMatch(
      /If no offered tool does what was asked, search with jira\.discover before saying it cannot be done/u,
    );
    expect(JIRA_TOOL_GUIDANCE).toMatch(/never present another tool's result as the answer/u);
    // Discovery is no longer framed as the route for a few named operations only.
    expect(JIRA_TOOL_GUIDANCE).not.toMatch(/\(delete, move, administer\)/u);
  });

  // 2026-11-13 lane: nine calls named a tool the model had not selected (`invalid-identity`).
  it("says a tool must be selected with jira.describe before it can be called", () => {
    expect(JIRA_TOOL_GUIDANCE).toMatch(/select a tool with jira\.describe before calling it/u);
  });

  // The sentence about actor keys and reviewed prior state may only claim what the registry holds
  // for every operation it covers; it is derived from the operation contracts, not written by hand.
  it("states about actor keys and reviewed prior state only what the registry holds", () => {
    const actorOperations = declaring((name) => name === "expectedActorKey");
    expect(actorOperations.length).toBeGreaterThan(20);
    // The instruction says "where a write takes it". The only operations outside that are the
    // read-class POST validations, which neither the sentence claims nor excludes.
    const notWrites = actorOperations
      .filter((contract) => contract.declaration.risk !== "write")
      .map((contract) => contract.definition.tool);
    expect(notWrites.filter((tool) => !tool.startsWith("jira.validate-"))).toEqual([]);
    const reviewed = declaring(
      (name) => name === "expectAbsent" || /^expected(?!ActorKey)/u.test(name),
    );
    expect(reviewed.length).toBeGreaterThan(10);
    expect(
      reviewed
        .filter((contract) => contract.declaration.risk !== "write")
        .map((contract) => contract.definition.tool),
    ).toEqual([]);
    // "the key jira.myself returns": the myself projection carries the user `key`.
    const myself = jiraOperationContracts().find(
      (entry) => entry.definition.tool === "jira.myself",
    );
    expect(JSON.stringify(myself?.declaration.descriptor.resultSchema)).toContain('"key":{');
    expect(JIRA_TOOL_GUIDANCE).toMatch(
      /Where a write takes expectedActorKey it is the key jira\.myself returns/u,
    );
    expect(JIRA_TOOL_GUIDANCE).toMatch(/a write that asks for reviewed prior state/u);
  });

  // The Jira catalog is sent every turn. The owner's 8,192-token overflow pins in
  // grounded-jira-mixed.public-handler.test.ts guard the whole prompt; this instruction is part of it,
  // so its growth is capped on its own. Measured on 2026-11-13: 1,212 bytes before #4357, 1,661 after, 1,677 with the when-to-search sentence.
  it("stays within its byte budget; new text replaces text instead of adding to it", () => {
    expect(Buffer.byteLength(JIRA_TOOL_GUIDANCE)).toBeLessThanOrEqual(1700);
  });

  // The Jira 400 for a localized issue type name ("Der Wert 'Aufgabe' existiert nicht") is the
  // normal case on a German Jira; the id is language independent.
  it("tells a model to name an issue type in JQL by its id", () => {
    expect(JIRA_TOOL_GUIDANCE).toMatch(/issue type by id \(jira\.issue-types\)/u);
  });
});
