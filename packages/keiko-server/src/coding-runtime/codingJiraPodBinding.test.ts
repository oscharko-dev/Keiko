import { describe, expect, it } from "vitest";

import {
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  mcpToolAction,
  type McpServerDefinition,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  ACTIVITY_LOG_OPERATION_REGISTRY,
  type ActivityLogOperationRegistration,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  CODING_JIRA_SERVER_NAME,
  CODING_JIRA_TOOL_RISKS,
  codingJiraServerDefinition,
  codingRunMcpServers,
  sameCodingJiraPodBinding,
  withCodingJiraServer,
} from "./codingJiraPodBinding.js";

/** A backlog draft is approved as one reviewed tree in Chat; Coding runs never offer it (#4178). */
const CODING_MUTATIONS = JIRA_MUTATION_OPERATIONS.filter((operation) => operation !== "jira.draft");

const BINDING = {
  podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d018",
  authenticationGeneration: 3,
  verificationRevision: 1,
} as const;

describe("the run's Jira server definition", () => {
  it("declares every managed Jira tool with its read or write risk and nothing else", () => {
    expect(
      Object.entries(CODING_JIRA_TOOL_RISKS)
        .filter(([, risk]) => risk === "read")
        .map(([n]) => n),
    ).toEqual([...JIRA_MANAGED_READ_TOOLS]);
    expect(
      Object.entries(CODING_JIRA_TOOL_RISKS)
        .filter(([, risk]) => risk === "write")
        .map(([n]) => n),
    ).toEqual(CODING_MUTATIONS);
    expect(CODING_JIRA_TOOL_RISKS).not.toHaveProperty(["jira.draft"]);
  });

  it("reaches the policy as jira_<tool> without any two tools sharing an action", () => {
    const definition = codingJiraServerDefinition(BINDING);
    const actions = Object.keys(definition.tools).map((tool) =>
      mcpToolAction(definition.name, tool),
    );
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toContain("jira_jira_comment");
    expect(actions).toContain("jira_jira_issue");
  });

  it("names the Pod and its credential generation, so a changed credential is another definition", () => {
    const base = JSON.stringify(codingJiraServerDefinition(BINDING));
    expect(base).toContain(BINDING.podId);
    for (const changed of [
      { authenticationGeneration: 4 },
      { verificationRevision: 2 },
      { podId: "0d6c5d3e-7a41-4f0e-9a52-3c1f8e4b7a10" },
    ])
      expect(JSON.stringify(codingJiraServerDefinition({ ...BINDING, ...changed }))).not.toBe(base);
  });

  it("is a remote placeholder that carries no credential, header or OAuth", () => {
    const { transport } = codingJiraServerDefinition(BINDING);
    expect(transport.kind).toBe("remote");
    expect(transport).not.toHaveProperty("headers");
    expect(transport).not.toHaveProperty("oauth");
  });

  it("compares bindings by Pod, credential generation and verification revision", () => {
    expect(sameCodingJiraPodBinding(BINDING, { ...BINDING })).toBe(true);
    expect(sameCodingJiraPodBinding(BINDING, { ...BINDING, authenticationGeneration: 9 })).toBe(
      false,
    );
    expect(sameCodingJiraPodBinding(BINDING, { ...BINDING, verificationRevision: 9 })).toBe(false);
    expect(sameCodingJiraPodBinding(BINDING, { ...BINDING, podId: "other" })).toBe(false);
  });
});

describe("the servers a bound run admits", () => {
  const registry: McpServerDefinition = {
    name: "wiki",
    description: undefined,
    enabled: true,
    transport: { kind: "remote", url: "https://wiki.example.test/mcp" },
    tools: { find: "read" },
  };

  it("adds the Pod's server to the operator's registry servers", () => {
    expect(withCodingJiraServer([registry], BINDING).map((server) => server.name)).toEqual([
      "wiki",
      CODING_JIRA_SERVER_NAME,
    ]);
  });

  it("leaves a run without a Pod exactly as it was", () => {
    const servers = [registry];
    expect(withCodingJiraServer(servers, undefined)).toBe(servers);
  });

  it("replaces a registry server of the same name, so it can never share the Pod's grant", () => {
    const shadow: McpServerDefinition = {
      ...registry,
      name: CODING_JIRA_SERVER_NAME,
      tools: { "jira.issue": "read", "jira.comment": "read" },
    };
    const servers = withCodingJiraServer([shadow, registry], BINDING);
    expect(servers.filter((server) => server.name === CODING_JIRA_SERVER_NAME)).toHaveLength(1);
    expect(servers.find((server) => server.name === CODING_JIRA_SERVER_NAME)?.tools).toEqual(
      CODING_JIRA_TOOL_RISKS,
    );
  });
});

describe("a run's MCP servers", () => {
  const operator: McpServerDefinition = {
    name: "docs",
    description: undefined,
    enabled: true,
    transport: { kind: "remote", url: "https://docs.example.test/mcp" },
    tools: { search: "read" },
  };

  it("keeps the operator's registry untouched and grants nothing for a run without a Pod", () => {
    const registry = (): readonly McpServerDefinition[] => [operator];
    expect(codingRunMcpServers(registry, undefined)).toEqual({ mcpServers: registry });
    expect(codingRunMcpServers(undefined, undefined)).toEqual({});
  });

  it("adds the bound Pod beside the registry and grants only its reads", () => {
    const servers = codingRunMcpServers(() => [operator], BINDING);
    expect(servers.mcpServers?.("run-1").map((server) => server.name)).toEqual([
      "docs",
      CODING_JIRA_SERVER_NAME,
    ]);
    expect([...(servers.mcpGrantedServers ?? [])]).toEqual([CODING_JIRA_SERVER_NAME]);
  });

  it("never drops a bound Pod when the operator has no registry", () => {
    const servers = codingRunMcpServers(undefined, BINDING);
    expect(servers.mcpServers?.("run-1")).toEqual([codingJiraServerDefinition(BINDING)]);
    expect([...(servers.mcpGrantedServers ?? [])]).toEqual([CODING_JIRA_SERVER_NAME]);
  });
});

describe("the coding-runtime.jira-pod Activity Log operation", () => {
  // The registration must stay one closed literal; this binds its logged tool names to the contract.
  it("logs exactly the contract's Jira tool names", () => {
    const registry: readonly ActivityLogOperationRegistration[] = ACTIVITY_LOG_OPERATION_REGISTRY;
    const registration = registry.find((entry) => entry.op === "coding-runtime.jira-pod");
    expect(registration?.fields.tool?.values).toEqual([
      ...JIRA_MANAGED_READ_TOOLS,
      ...CODING_MUTATIONS,
    ]);
  });
});
