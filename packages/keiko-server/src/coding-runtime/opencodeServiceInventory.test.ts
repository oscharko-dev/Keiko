import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  OPENCODE_CLI_DISPOSITIONS,
  OPENCODE_SERVICE_DISPOSITIONS,
  OPENCODE_SERVICE_REFUSAL_REASONS,
  diffOpenCodeServiceOperations,
  extractOpenCodeServiceOperations,
  openCodeServiceDisposition,
  parseOpenCodeCliSubcommands,
  parseOpenCodeServiceInventory,
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

function rowsCell(entry: OpenCodeServiceDispositionEntry | undefined): string {
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

function documentBlock(document: string): string {
  const start = document.indexOf(BEGIN);
  const end = document.indexOf(END);
  if (start < 0 || end < start) throw new TypeError("service-inventory-markers-missing");
  return document.slice(start, end + END.length);
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
