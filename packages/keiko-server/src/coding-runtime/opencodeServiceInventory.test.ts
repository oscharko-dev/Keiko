import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts";

import { createFixedOpenCodeV2Config } from "./opencodeLaunchProfile.js";
import { openCodeNativeMcpAdmission } from "./opencodeNativeMcp.js";
import {
  OPENCODE_CLI_DISPOSITIONS,
  OPENCODE_CONFIGURATION_DISPOSITIONS,
  OPENCODE_SERVICE_DISPOSITIONS,
  OPENCODE_SERVICE_REFUSAL_REASONS,
  diffOpenCodeConfigurationPaths,
  diffOpenCodeServiceOperations,
  extractOpenCodeConfigurationPaths,
  extractOpenCodeServiceOperations,
  openCodeConfigurationDisposition,
  openCodeServiceDisposition,
  parseOpenCodeCliSubcommands,
  parseOpenCodeServiceInventory,
  type OpenCodeConfigurationDisposition,
  type OpenCodeServiceDisposition,
  type OpenCodeServiceDispositionEntry,
  type OpenCodeServiceOperation,
} from "./opencodeServiceInventory.js";
import {
  OPENCODE_V2_APPROVED_ENDPOINTS,
  projectOpenCodeV2ProtocolSurface,
} from "./opencodeProtocolSurface.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";

/** Set to `1` to rewrite the generated inventory block of the parity document, then run prettier. */
const WRITE_DOCUMENT = process.env.KEIKO_WRITE_OPENCODE_SERVICE_INVENTORY_DOC === "1";
const SOURCE_ROOT = new URL("../", import.meta.url);
const DOCUMENT_URL = new URL("../../../../docs/qa/opencode-capability-parity.md", import.meta.url);
const BEGIN = "<!-- service-inventory:begin -->";
const END = "<!-- service-inventory:end -->";
const CONFIGURATION_BEGIN = "<!-- configuration-inventory:begin -->";
const CONFIGURATION_END = "<!-- configuration-inventory:end -->";
/** The epic #3897 child issues that can own an original surface. */
const OWNER_ISSUES: ReadonlySet<number> = new Set([
  3898, 3899, 3900, 3901, 3902, 3903, 3904, 3905, 3906, 3907, 3908,
]);

function readLocal(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

function inventory(version: string): ReturnType<typeof parseOpenCodeServiceInventory> {
  return parseOpenCodeServiceInventory(
    readLocal(`./opencodeServiceInventory.opencode-${version}.fixture.json`),
  );
}

const CURRENT = inventory(OPENCODE_PINNED_VERSION);
const CLI_COMMANDS = CURRENT.cliCommands ?? [];
const CONFIGURATION_PATHS = CURRENT.configurationPaths ?? [];
const OPERATION_IDS: ReadonlySet<string> = new Set(CURRENT.operations.map((o) => o.operationId));

function endpoint(operation: OpenCodeServiceOperation): string {
  return `${operation.method} ${operation.path}`;
}

function dispositionOf(operation: OpenCodeServiceOperation): OpenCodeServiceDisposition {
  const disposition = openCodeServiceDisposition(operation);
  if (disposition === undefined) throw new TypeError(`no disposition: ${operation.operationId}`);
  return disposition;
}

function duplicates(values: readonly string[]): readonly string[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

function matrixRows(document: string): ReadonlySet<string> {
  return new Set([...document.matchAll(/^\| ([TSC]\d{2}) \|/gmu)].map((match) => match[1] ?? ""));
}

describe("OpenCode 2.1.4 producer inventory fixture", () => {
  // Producer facts of the pinned version: an upgrade changes them together with the fixture.
  it("is the inventory of the pinned version and has not been truncated", () => {
    expect(CURRENT.version).toBe(OPENCODE_PINNED_VERSION);
    expect(CURRENT.operations).toHaveLength(149);
    expect(CLI_COMMANDS).toHaveLength(41);
  });

  it("lists every operation once, ordered by operationId", () => {
    const ids = CURRENT.operations.map((operation) => operation.operationId);
    expect(duplicates(ids)).toEqual([]);
    expect(duplicates(CURRENT.operations.map(endpoint))).toEqual([]);
    expect(ids).toEqual([...ids].sort());
    expect(CLI_COMMANDS).toEqual([...CLI_COMMANDS].sort());
  });
});

describe("OpenCode 2.1.4 service dispositions fail closed", () => {
  it("give every operation of the producer a disposition", () => {
    const undisposed = CURRENT.operations.filter(
      (operation) => openCodeServiceDisposition(operation) === undefined,
    );
    expect(undisposed.map((operation) => operation.operationId)).toEqual([]);
  });

  it("name no operation the producer does not serve", () => {
    const stale = OPENCODE_SERVICE_DISPOSITIONS.filter((entry) => !OPERATION_IDS.has(entry.name));
    expect(stale.map((entry) => entry.name)).toEqual([]);
  });

  it("name every operation at most once and never list an admitted operation", () => {
    expect(duplicates(OPENCODE_SERVICE_DISPOSITIONS.map((entry) => entry.name))).toEqual([]);
    const explicit: ReadonlySet<string> = new Set(OPENCODE_SERVICE_DISPOSITIONS.map((e) => e.name));
    const listedAdmitted = CURRENT.operations.filter(
      (operation) =>
        explicit.has(operation.operationId) && dispositionOf(operation).kind === "admitted",
    );
    expect(listedAdmitted.map((operation) => operation.operationId)).toEqual([]);
  });

  it("admit exactly the digest-pinned protocol surface", () => {
    const admitted = CURRENT.operations
      .filter((operation) => dispositionOf(operation).kind === "admitted")
      .map(endpoint)
      .sort();
    expect(admitted).toEqual([...OPENCODE_V2_APPROVED_ENDPOINTS].sort());
    // The structural projection of the captured surface document names the same operations.
    const surface: unknown = JSON.parse(
      readLocal(`./opencodeProtocolSurface.opencode-${OPENCODE_PINNED_VERSION}.fixture.json`),
    );
    const { paths } = projectOpenCodeV2ProtocolSurface(surface).projection as {
      readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    };
    const projected = Object.entries(paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(projected.sort()).toEqual(admitted);
  });

  it("covers an operation only by an admitted one", () => {
    const admittedIds: ReadonlySet<string> = new Set(
      CURRENT.operations
        .filter((operation) => dispositionOf(operation).kind === "admitted")
        .map((operation) => operation.operationId),
    );
    const covers = OPENCODE_SERVICE_DISPOSITIONS.flatMap((entry) =>
      entry.disposition.kind === "covered" ? [entry.disposition.by] : [],
    );
    expect(covers.length).toBeGreaterThan(0);
    expect(covers.filter((by) => !admittedIds.has(by))).toEqual([]);
  });

  it("point every Keiko operation at a source file that exists", () => {
    const sources = [...OPENCODE_SERVICE_DISPOSITIONS, ...OPENCODE_CLI_DISPOSITIONS].flatMap(
      (entry) => (entry.disposition.kind === "keiko-operation" ? [entry.disposition.source] : []),
    );
    expect(sources.length).toBeGreaterThan(0);
    expect(
      sources.filter((source) => !existsSync(fileURLToPath(new URL(source, SOURCE_ROOT)))),
    ).toEqual([]);
  });

  it("give every refusal a closed reason, an epic owner and an experimental path when it says so", () => {
    const paths = new Map(CURRENT.operations.map((o) => [o.operationId, o.path]));
    for (const { name, disposition } of OPENCODE_SERVICE_DISPOSITIONS) {
      if (disposition.kind !== "refused") continue;
      expect(OPENCODE_SERVICE_REFUSAL_REASONS).toContain(disposition.reason);
      expect(OWNER_ISSUES.has(disposition.owner), name).toBe(true);
      if (disposition.reason === "experimental-unadmitted") {
        expect(paths.get(name), name).toContain("/experimental/");
      }
    }
    const used = [...OPENCODE_SERVICE_DISPOSITIONS, ...OPENCODE_CLI_DISPOSITIONS].flatMap(
      (entry) => (entry.disposition.kind === "refused" ? [entry.disposition.reason] : []),
    );
    expect(OPENCODE_SERVICE_REFUSAL_REASONS.filter((reason) => !used.includes(reason))).toEqual([]);
  });

  it("tie every refused and Keiko-operation entry to existing capability-matrix rows", () => {
    const rows = matrixRows(readFileSync(DOCUMENT_URL, "utf8"));
    expect(rows.size).toBeGreaterThan(0);
    const entries = [...OPENCODE_SERVICE_DISPOSITIONS, ...OPENCODE_CLI_DISPOSITIONS];
    expect(entries.flatMap((e) => e.rows).filter((row) => !rows.has(row))).toEqual([]);
    // An unimplemented surface must name the matrix row that tracks its status.
    expect(
      entries
        .filter(
          (e) => e.disposition.kind === "refused" && e.disposition.reason === "not-yet-implemented",
        )
        .filter((e) => e.rows.length === 0)
        .map((e) => e.name),
    ).toEqual([]);
  });
});

describe("OpenCode 2.1.4 CLI dispositions fail closed", () => {
  it("give every leaf command a disposition and name no other", () => {
    const names = OPENCODE_CLI_DISPOSITIONS.map((entry) => entry.name);
    expect(duplicates(names)).toEqual([]);
    expect([...names].sort()).toEqual([...CLI_COMMANDS]);
  });

  it("start only `serve`, never cover a command and give every refused command an epic owner", () => {
    for (const { name, disposition } of OPENCODE_CLI_DISPOSITIONS) {
      expect(disposition.kind, name).not.toBe("covered");
      if (disposition.kind === "refused")
        expect(OWNER_ISSUES.has(disposition.owner), name).toBe(true);
    }
    const launched = OPENCODE_CLI_DISPOSITIONS.find((entry) => entry.name === "serve");
    expect(launched?.disposition.kind).toBe("keiko-operation");
  });
});

const ROOT_HELP = `DESCRIPTION
  OpenCode command line interface

USAGE
  opencode <subcommand> [flags] [<directory>]

FLAGS
  --standalone            Run with a private server instead of the background service

SUBCOMMANDS
  upgrade, update    Upgrade OpenCode to the latest or a specific version
  uninstall          Uninstall OpenCode, keeping session data, configuration, and state
                     wrapped description of the line above
  serve              Start the v2 API and web server

TRAILER
  not-a-command    ignored
`;

describe("OpenCode producer extraction and parsing", () => {
  it("extracts only operations, upper-cases the method and orders by operationId", () => {
    const document = {
      openapi: "3.1.0",
      paths: {
        "/b": { parameters: [], summary: "not an operation", post: { operationId: "b.post" } },
        "/a/{id}": { get: { operationId: "a.get" }, delete: { operationId: "a.delete" } },
      },
    };
    expect(extractOpenCodeServiceOperations(document)).toEqual([
      { operationId: "a.delete", method: "DELETE", path: "/a/{id}" },
      { operationId: "a.get", method: "GET", path: "/a/{id}" },
      { operationId: "b.post", method: "POST", path: "/b" },
    ]);
  });

  it("refuses a document that could hide an operation", () => {
    expect(() => extractOpenCodeServiceOperations({ openapi: "3.1.0" })).toThrow(
      "opencode-openapi-paths-missing",
    );
    expect(() => extractOpenCodeServiceOperations({ paths: { "/a": { get: {} } } })).toThrow(
      "opencode-openapi-operation-id-missing",
    );
    const repeated = {
      paths: { "/a": { get: { operationId: "x" } }, "/b": { get: { operationId: "x" } } },
    };
    expect(() => extractOpenCodeServiceOperations(repeated)).toThrow(
      "opencode-service-operation-id-duplicate",
    );
  });

  it("refuses a malformed committed inventory", () => {
    const refusal = "opencode-service-inventory-malformed";
    expect(() => parseOpenCodeServiceInventory("{}")).toThrow(refusal);
    expect(() =>
      parseOpenCodeServiceInventory('{"version":"1","operations":[{"operationId":"a"}]}'),
    ).toThrow(refusal);
    expect(() =>
      parseOpenCodeServiceInventory('{"version":"1","operations":[],"cliCommands":[1]}'),
    ).toThrow(refusal);
    expect(parseOpenCodeServiceInventory('{"version":"1","operations":[]}')).toEqual({
      version: "1",
      operations: [],
    });
  });

  it("reads the subcommands of a help text, first spelling only, and stops at the next section", () => {
    expect(parseOpenCodeCliSubcommands(ROOT_HELP)).toEqual(["upgrade", "uninstall", "serve"]);
    expect(parseOpenCodeCliSubcommands("DESCRIPTION\n  nothing here\n")).toEqual([]);
  });
});

describe("OpenCode upgrade compatibility diff", () => {
  // The first captured upgrade, kept as a permanent record: both fixtures are named explicitly.
  const PREVIOUS = inventory("2.0.10");
  const NEXT = inventory("2.1.4");

  const ADDED_BY_2_1_4 = [
    "credential.create",
    "credential.list",
    "debug.heapDump",
    "experimental.mcp.client",
    "experimental.mcp.client.token",
    "experimental.voice.instructions",
    "experimental.voice.models",
    "experimental.voice.session",
    "integration.connect.external",
    "permission.saved.update",
    "server.connect",
    "server.pair",
    "vcs.init",
  ];

  it("names what 2.1.4 added to 2.0.10 and that nothing was removed or moved", () => {
    const diff = diffOpenCodeServiceOperations(PREVIOUS.operations, NEXT.operations);
    expect(diff.added).toEqual(ADDED_BY_2_1_4);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.breaking).toBe(false);
    expect(NEXT.operations.length - PREVIOUS.operations.length).toBe(diff.added.length);
  });

  it("reports the reverse direction as breaking", () => {
    const diff = diffOpenCodeServiceOperations(NEXT.operations, PREVIOUS.operations);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(ADDED_BY_2_1_4);
    expect(diff.breaking).toBe(true);
  });

  it("reports a moved operation as changed and breaking", () => {
    const before = [{ operationId: "a.get", method: "GET", path: "/a" }];
    const after = [{ operationId: "a.get", method: "POST", path: "/a" }];
    expect(diffOpenCodeServiceOperations(before, after)).toEqual({
      added: [],
      removed: [],
      changed: [{ operationId: "a.get", previous: "GET /a", next: "POST /a" }],
      breaking: true,
    });
    expect(diffOpenCodeServiceOperations(before, before).breaking).toBe(false);
  });

  it("refuses an inventory that names an operationId twice", () => {
    const twice = [...NEXT.operations, ...NEXT.operations.slice(0, 1)];
    expect(() => diffOpenCodeServiceOperations(PREVIOUS.operations, twice)).toThrow(
      "opencode-service-operation-id-duplicate",
    );
  });

  it("requires a disposition for every operation an upgrade adds", () => {
    const diff = diffOpenCodeServiceOperations(PREVIOUS.operations, NEXT.operations);
    const added: ReadonlySet<string> = new Set(diff.added);
    const missing = NEXT.operations
      .filter((operation) => added.has(operation.operationId))
      .filter((operation) => openCodeServiceDisposition(operation) === undefined);
    expect(missing).toEqual([]);
  });
});

function label(entry: OpenCodeServiceDisposition): string[] {
  switch (entry.kind) {
    case "admitted":
      return ["`admitted`", "digest-pinned protocol surface", "-"];
    case "covered":
      return ["`covered`", `through \`${entry.by}\``, "-"];
    case "keiko-operation":
      return ["`keiko-operation`", `${entry.operation} (\`${entry.source}\`)`, "-"];
    case "refused":
      return ["`refused`", `\`${entry.reason}\``, `#${String(entry.owner)}`];
  }
}

function rowsCell(entry: { readonly rows: readonly string[] } | undefined): string {
  return entry === undefined || entry.rows.length === 0 ? "-" : entry.rows.join(", ");
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const line = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)];
}

function countRows(): string[][] {
  const kinds = ["admitted", "covered", "keiko-operation", "refused"] as const;
  const http = CURRENT.operations.map((operation) => dispositionOf(operation));
  const cli = OPENCODE_CLI_DISPOSITIONS.map((entry) => entry.disposition);
  const count = (list: readonly OpenCodeServiceDisposition[], kind: string): string =>
    String(list.filter((item) => item.kind === kind).length);
  const reasons = OPENCODE_SERVICE_REFUSAL_REASONS.map((reason) => {
    const refusedFor = (list: readonly OpenCodeServiceDisposition[]): string =>
      String(list.filter((i) => i.kind === "refused" && i.reason === reason).length);
    return [`refused: \`${reason}\``, refusedFor(http), refusedFor(cli)];
  });
  return [
    ...kinds.map((kind) => [`\`${kind}\``, count(http, kind), count(cli, kind)]),
    ...reasons,
    ["Total", String(http.length), String(cli.length)],
  ];
}

function renderBlock(): string {
  const entries: ReadonlyMap<string, OpenCodeServiceDispositionEntry> = new Map(
    OPENCODE_SERVICE_DISPOSITIONS.map((entry) => [entry.name, entry]),
  );
  const operations = CURRENT.operations.map((operation) => [
    `\`${operation.operationId}\``,
    `\`${endpoint(operation)}\``,
    ...label(dispositionOf(operation)),
    rowsCell(entries.get(operation.operationId)),
  ]);
  const commands = OPENCODE_CLI_DISPOSITIONS.map((entry) => [
    `\`${entry.name}\``,
    ...label(entry.disposition),
    rowsCell(entry),
  ]);
  return [
    BEGIN,
    "",
    ...table(["Disposition", "HTTP operations", "CLI commands"], countRows()),
    "",
    `#### HTTP operations (${String(operations.length)})`,
    "",
    ...table(["operationId", "Endpoint", "Disposition", "Detail", "Owner", "Rows"], operations),
    "",
    `#### CLI commands (${String(commands.length)})`,
    "",
    ...table(["Command", "Disposition", "Detail", "Owner", "Rows"], commands),
    "",
    END,
  ].join("\n");
}

/** Collapses table padding so a prettier-aligned document compares equal to the generated block. */
function normalized(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) =>
      line.startsWith("|")
        ? line
            .split("|")
            .map((cell) => cell.trim().replace(/^-+$/u, "---"))
            .join("|")
        : line,
    );
}

function documentBlock(document: string, begin = BEGIN, end = END): string {
  const start = document.indexOf(begin);
  const stop = document.indexOf(end);
  if (start < 0 || stop < start) throw new TypeError("inventory-markers-missing");
  return document.slice(start, stop + end.length);
}

describe("parity document service inventory section", () => {
  it("lists exactly the dispositions of the TypeScript tables and the committed fixture", () => {
    let document = readFileSync(DOCUMENT_URL, "utf8");
    if (WRITE_DOCUMENT) {
      document = document.replace(documentBlock(document), renderBlock());
      writeFileSync(DOCUMENT_URL, document);
    }
    expect(normalized(documentBlock(document))).toEqual(normalized(renderBlock()));
  });

  it("explains every disposition kind and refusal reason", () => {
    const document = readFileSync(DOCUMENT_URL, "utf8");
    const legend = document.slice(
      document.indexOf("## 7. Service operation inventory"),
      document.indexOf(BEGIN),
    );
    for (const term of [
      "admitted",
      "covered",
      "keiko-operation",
      "refused",
      ...OPENCODE_SERVICE_REFUSAL_REASONS,
    ]) {
      expect(legend, term).toContain(`\`${term}\``);
    }
  });
});

// ---- Configuration settings (#3903 AC5, #3908 AC2) ----

const LOCAL_SERVER: McpServerDefinition = {
  name: "docs",
  description: undefined,
  enabled: true,
  transport: { kind: "local", command: ["/opt/mcp/docs"], environment: { DOCS_MODE: "offline" } },
  tools: { search: "read" },
};
const REMOTE_SERVER: McpServerDefinition = {
  name: "tracker",
  description: undefined,
  enabled: true,
  transport: { kind: "remote", url: "https://mcp.example.test/v1" },
  tools: { issues: "read" },
};

/**
 * The schema path of every setting a composed configuration writes: a key the schema names keeps
 * its name, any other key is the configuration's own (`*`), and an array declares its items' keys
 * at its own path. A key the schema does not declare at all is returned as `undeclared:<path>`.
 */
function declaredSettings(value: unknown, declared: ReadonlySet<string>, prefix = ""): string[] {
  if (Array.isArray(value))
    return value.flatMap((item) => declaredSettings(item, declared, prefix));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const named = prefix === "" ? key : `${prefix}.${key}`;
    const dynamic = prefix === "" ? "*" : `${prefix}.*`;
    const path = declared.has(named) ? named : dynamic;
    if (!declared.has(path)) return [`undeclared:${named}`];
    return [path, ...declaredSettings(child, declared, path)];
  });
}

/** Every setting the native profile composes, at its widest: images, Full access and both MCP kinds. */
function composedNativeSettings(): readonly string[] {
  const mcp = openCodeNativeMcpAdmission({
    servers: [LOCAL_SERVER, REMOTE_SERVER],
    mode: "autonomous-delivery",
    home: "/state/home",
  }).config;
  const geometry = {
    contextWindowTokens: 32_768,
    maxInputTokens: 24_000,
    maxOutputTokens: 4_096,
    imageInput: true,
  };
  const config = createFixedOpenCodeV2Config(
    geometry,
    undefined,
    "native",
    "/state",
    "enabled",
    mcp,
  );
  return [...new Set(declaredSettings(config, new Set(CONFIGURATION_PATHS)))].sort();
}

function configurationNames(kind: OpenCodeConfigurationDisposition["kind"]): readonly string[] {
  return OPENCODE_CONFIGURATION_DISPOSITIONS.filter((entry) => entry.disposition.kind === kind)
    .map((entry) => entry.name)
    .sort();
}

describe("OpenCode 2.1.4 configuration dispositions fail closed", () => {
  it("hold the complete, ordered setting inventory of the pinned version", () => {
    expect(CONFIGURATION_PATHS).toHaveLength(232);
    expect(duplicates(CONFIGURATION_PATHS)).toEqual([]);
    expect(CONFIGURATION_PATHS).toEqual([...CONFIGURATION_PATHS].sort());
  });

  it("give every setting path exactly one disposition and name no other", () => {
    const names = OPENCODE_CONFIGURATION_DISPOSITIONS.map((entry) => entry.name);
    expect(duplicates(names)).toEqual([]);
    expect([...names].sort()).toEqual([...CONFIGURATION_PATHS]);
    const undisposed = CONFIGURATION_PATHS.filter(
      (path) => openCodeConfigurationDisposition(path) === undefined,
    );
    expect(undisposed).toEqual([]);
  });

  // Derived from the production composition, so the table cannot claim a setting the runtime is not
  // given, and a setting Keiko starts to write cannot stay listed as unavailable.
  it("mark as keiko-set exactly the settings the native profile composes", () => {
    const composed = composedNativeSettings();
    expect(composed.filter((path) => path.startsWith("undeclared:"))).toEqual([]);
    expect(configurationNames("keiko-set")).toEqual(composed);
  });

  it("give every refusal a closed reason and an epic owner, and every Keiko owner a real source", () => {
    for (const { name, disposition } of OPENCODE_CONFIGURATION_DISPOSITIONS) {
      if (disposition.kind === "refused") {
        expect(OPENCODE_SERVICE_REFUSAL_REASONS, name).toContain(disposition.reason);
        expect(OWNER_ISSUES.has(disposition.owner), name).toBe(true);
        if (disposition.reason === "experimental-unadmitted")
          expect(name, name).toMatch(/^experimental\./u);
      }
      if (disposition.kind === "keiko-operation") {
        const source = fileURLToPath(new URL(disposition.source, SOURCE_ROOT));
        expect(existsSync(source), name).toBe(true);
      }
    }
  });

  it("tie every setting to existing capability-matrix rows", () => {
    const rows = matrixRows(readFileSync(DOCUMENT_URL, "utf8"));
    const unrowed = OPENCODE_CONFIGURATION_DISPOSITIONS.filter((entry) => entry.rows.length === 0);
    expect(unrowed.map((entry) => entry.name)).toEqual([]);
    const unknown = OPENCODE_CONFIGURATION_DISPOSITIONS.flatMap((entry) => entry.rows).filter(
      (row) => !rows.has(row),
    );
    expect(unknown).toEqual([]);
  });
});

describe("OpenCode configuration schema extraction", () => {
  const SCHEMA = (schemas: Record<string, unknown>): unknown => ({ components: { schemas } });

  it("walks named, union, array-item and named-key settings, each reference once per path", () => {
    const document = SCHEMA({
      "Config.InfoEncoded": {
        type: "object",
        properties: {
          model: { anyOf: [{ type: "string" }, { $ref: "#/components/schemas/Model" }] },
          rules: { type: "array", items: { $ref: "#/components/schemas/Rule" } },
          agents: { type: "object", additionalProperties: { $ref: "#/components/schemas/Agent" } },
          open: { type: "object", additionalProperties: true },
        },
      },
      Model: { type: "object", properties: { id: { type: "string" } } },
      Rule: { type: "object", properties: { action: { type: "string" } } },
      Agent: {
        type: "object",
        properties: { child: { $ref: "#/components/schemas/Agent" }, name: { type: "string" } },
      },
    });
    expect(extractOpenCodeConfigurationPaths(document)).toEqual([
      "agents",
      "agents.*",
      "agents.*.child",
      "agents.*.name",
      "model",
      "model.id",
      "open",
      "rules",
      "rules.action",
    ]);
  });

  it("refuses a document without the configuration schema or with an unresolved reference", () => {
    expect(() => extractOpenCodeConfigurationPaths({ components: { schemas: {} } })).toThrow(
      "opencode-configuration-schema-missing",
    );
    const dangling = SCHEMA({
      "Config.InfoEncoded": { properties: { a: { $ref: "#/components/schemas/Missing" } } },
    });
    expect(() => extractOpenCodeConfigurationPaths(dangling)).toThrow(
      "opencode-configuration-reference-unresolved",
    );
  });

  it("refuses a committed configuration inventory that is not a list of paths", () => {
    expect(() =>
      parseOpenCodeServiceInventory('{"version":"1","operations":[],"configurationPaths":[1]}'),
    ).toThrow("opencode-service-inventory-malformed");
  });
});

describe("OpenCode configuration upgrade diff", () => {
  // The first captured upgrade, kept as a permanent record: both fixtures are named explicitly.
  const ADDED_BY_2_1_4 = [
    "experimental.background_compaction",
    "experimental.location_idle_timeout",
    "experimental.todo",
    "policies",
    "policies.action",
    "policies.effect",
    "policies.resource",
    "providers.*.compatibility",
    "providers.*.compatibility.cacheFormat",
    "providers.*.compatibility.maxTokensField",
    "providers.*.compatibility.reasoningField",
    "providers.*.compatibility.requireAssistantAfterTool",
    "providers.*.compatibility.requireFinishReason",
    "providers.*.compatibility.requireReasoning",
    "providers.*.compatibility.streamUsage",
    "providers.*.compatibility.supportsPromptCacheKey",
    "providers.*.models.*.capabilities.reasoning",
    "providers.*.models.*.capabilities.reasoning.budget",
    "providers.*.models.*.capabilities.reasoning.budget.max",
    "providers.*.models.*.capabilities.reasoning.budget.min",
    "providers.*.models.*.capabilities.reasoning.effort",
    "providers.*.models.*.capabilities.reasoning.supported",
    "providers.*.models.*.capabilities.reasoning.toggle",
    "providers.*.models.*.capabilities.temperature",
    "providers.*.models.*.compatibility.cacheFormat",
    "providers.*.models.*.compatibility.streamUsage",
    "providers.*.models.*.compatibility.supportsEffortUpdates",
    "providers.*.models.*.compatibility.supportsThinkingBlockBinding",
    "providers.*.models.*.releaseDate",
    "providers.*.models.*.settings.encoding",
    "providers.*.models.*.variants.settings.encoding",
    "providers.*.settings.encoding",
    "providers.*.settings.headerTimeout",
  ];

  it("names the 33 settings 2.1.4 added to 2.0.10 and that none was removed", () => {
    const previous = inventory("2.0.10").configurationPaths ?? [];
    const diff = diffOpenCodeConfigurationPaths(previous, CONFIGURATION_PATHS);
    expect(previous).toHaveLength(199);
    expect(diff.added).toEqual(ADDED_BY_2_1_4);
    expect(diff.removed).toEqual([]);
    expect(diffOpenCodeConfigurationPaths(CONFIGURATION_PATHS, previous).removed).toEqual(
      ADDED_BY_2_1_4,
    );
  });

  it("requires a disposition for every setting an upgrade adds", () => {
    const missing = ADDED_BY_2_1_4.filter(
      (path) => openCodeConfigurationDisposition(path) === undefined,
    );
    expect(missing).toEqual([]);
  });
});

function configurationLabel(disposition: OpenCodeConfigurationDisposition): string[] {
  return disposition.kind === "keiko-set"
    ? ["`keiko-set`", "native profile (`opencodeLaunchProfile.ts`)", "-"]
    : label(disposition);
}

function configurationCountRows(): string[][] {
  const entries = OPENCODE_CONFIGURATION_DISPOSITIONS;
  const kinds = ["keiko-set", "keiko-operation", "refused"] as const;
  const reasons = OPENCODE_SERVICE_REFUSAL_REASONS.map((reason) => [
    `refused: \`${reason}\``,
    String(
      entries.filter((e) => e.disposition.kind === "refused" && e.disposition.reason === reason)
        .length,
    ),
  ]);
  return [
    ...kinds.map((kind) => [`\`${kind}\``, String(configurationNames(kind).length)]),
    ...reasons,
    ["Total", String(entries.length)],
  ];
}

function renderConfigurationBlock(): string {
  const entries = new Map(OPENCODE_CONFIGURATION_DISPOSITIONS.map((entry) => [entry.name, entry]));
  const settings = CONFIGURATION_PATHS.map((path) => {
    const entry = entries.get(path);
    if (entry === undefined) throw new TypeError(`no disposition: ${path}`);
    return [`\`${path}\``, ...configurationLabel(entry.disposition), rowsCell(entry)];
  });
  return [
    CONFIGURATION_BEGIN,
    "",
    ...table(["Disposition", "Settings"], configurationCountRows()),
    "",
    `#### Settings (${String(settings.length)})`,
    "",
    ...table(["Setting", "Disposition", "Detail", "Owner", "Rows"], settings),
    "",
    CONFIGURATION_END,
  ].join("\n");
}

describe("parity document configuration inventory section", () => {
  it("lists exactly the configuration dispositions and the committed fixture", () => {
    let document = readFileSync(DOCUMENT_URL, "utf8");
    const block = (text: string): string =>
      documentBlock(text, CONFIGURATION_BEGIN, CONFIGURATION_END);
    if (WRITE_DOCUMENT) {
      document = document.replace(block(document), renderConfigurationBlock());
      writeFileSync(DOCUMENT_URL, document);
    }
    expect(normalized(block(document))).toEqual(normalized(renderConfigurationBlock()));
  });

  it("explains the configuration disposition kinds", () => {
    const document = readFileSync(DOCUMENT_URL, "utf8");
    const legend = document.slice(
      document.indexOf("### Configuration setting inventory"),
      document.indexOf(CONFIGURATION_BEGIN),
    );
    for (const term of ["keiko-set", "keiko-operation", "refused"])
      expect(legend, term).toContain(`\`${term}\``);
  });
});
