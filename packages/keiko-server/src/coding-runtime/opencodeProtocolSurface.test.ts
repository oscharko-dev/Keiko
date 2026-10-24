import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  OPEN_CODE_V2_PINNED_PROTOCOL_SURFACE_SHA256,
  projectOpenCodeV2ProtocolSurface,
} from "./opencodeProtocolSurface.js";
import { OPENCODE_RUNTIME_VERSION_PINS } from "./opencodeRuntimeVersions.js";

const PINNED_DIGEST = "e1db492f2ac661f2b44da6ef3d7e58ed34856621a2c58de4610640e1291266f6";

interface ProtocolSurfaceModule {
  readonly OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256: string;
  projectOpenCodeProtocolSurface(document: unknown): {
    readonly digest: string;
    readonly projection: unknown;
  };
}

async function protocolSurfaceModule(): Promise<ProtocolSurfaceModule> {
  const moduleName = "./opencodeProtocolSurface.js";
  return (await import(moduleName)) as ProtocolSurfaceModule;
}

function document(): Record<string, unknown> {
  const operation = {
    security: [{ basicAuth: [] }],
    responses: { "200": { $ref: "#/components/responses/Health" } },
  };
  return {
    openapi: "3.1.0",
    info: { title: "OpenCode", description: "documentation drift" },
    paths: {
      "/global/health": {
        get: {
          description: "drift",
          security: [{ basicAuth: [] }],
          responses: { "200": { $ref: "#/components/responses/Health" } },
        },
      },
      "/global/event": {
        get: {
          security: [{ basicAuth: [] }],
          responses: { "200": { $ref: "#/components/responses/EventStream" } },
        },
      },
      "/session": {
        post: {
          security: [{ basicAuth: [] }],
          responses: { "200": { $ref: "#/components/responses/Session" } },
        },
        get: {
          security: [{ basicAuth: [] }],
          responses: { "200": { $ref: "#/components/responses/Sessions" } },
        },
      },
      "/session/status": { get: operation },
      "/session/{sessionID}/prompt_async": { post: operation },
      "/session/{sessionID}/abort": { post: operation },
      "/permission": { get: operation },
      "/permission/{requestID}/reply": { post: operation },
      "/question": { get: operation },
      "/question/{requestID}/reply": { post: operation },
      "/question/{requestID}/reject": { post: operation },
      "/sync/history": {
        post: {
          security: [{ basicAuth: [] }],
          responses: { "200": { $ref: "#/components/responses/History" } },
        },
      },
    },
    components: {
      securitySchemes: { basicAuth: { type: "http", scheme: "basic" } },
      responses: {
        Health: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } },
        },
        EventStream: { content: { "text/event-stream": { schema: { type: "string" } } } },
        Session: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Session" } } },
        },
        Sessions: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Sessions" } } },
        },
        History: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/History" } } },
        },
      },
      schemas: {
        Health: {
          type: "object",
          properties: { healthy: { type: "boolean" }, version: { type: "string" } },
        },
        Session: { type: "object", properties: { id: { type: "string" } } },
        Sessions: { type: "array", items: { $ref: "#/components/schemas/Session" } },
        History: { type: "array", items: { $ref: "#/components/schemas/Event" } },
        Event: {
          type: "object",
          properties: {
            id: { type: "string" },
            aggregate_id: { type: "string" },
            seq: { type: "integer" },
            type: { type: "string" },
            data: { type: "object" },
          },
        },
      },
    },
    "x-codeSamples": [{ lang: "shell", source: "curl" }],
  };
}

describe("OpenCode v1.18.30 protocol-surface projection", () => {
  it("projects only settled methods and transitive references into the pinned canonical digest", async () => {
    const surface = await protocolSurfaceModule();
    const baseline = surface.projectOpenCodeProtocolSurface(document());
    expect(surface.OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256).toBe(PINNED_DIGEST);
    expect(baseline.digest).not.toBe(PINNED_DIGEST);
    expect(JSON.stringify(baseline.projection)).not.toMatch(/description|x-codeSamples/u);

    const documentationDrift = document();
    documentationDrift["x-codeSamples"] = [{ lang: "shell", source: "changed" }];
    expect(surface.projectOpenCodeProtocolSurface(documentationDrift).digest).toBe(baseline.digest);

    const structuralDrift = document();
    const paths = structuralDrift.paths as Record<string, Record<string, unknown>>;
    (paths["/sync/history"]?.post as Record<string, unknown>).security = [];
    expect(surface.projectOpenCodeProtocolSurface(structuralDrift).digest).not.toBe(
      baseline.digest,
    );
  });
});

/** The value at a path of object keys, or `undefined` as soon as the path leaves the document. */
function dig(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Readonly<Record<string, unknown>>)[key];
  }
  return current;
}

describe("OpenCode 2.1.4 admitted V2 protocol surface", () => {
  const fixture: unknown = JSON.parse(
    readFileSync(
      new URL("./opencodeProtocolSurface.opencode-2.1.4.fixture.json", import.meta.url),
      "utf8",
    ),
  );

  it("admits the session agent switch with its closed request body", () => {
    const { projection } = projectOpenCodeV2ProtocolSurface(fixture);
    const operation = (
      projection as {
        readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      }
    ).paths["/api/session/{sessionID}/agent"]?.post as
      { readonly requestBody?: { readonly required?: boolean } } | undefined;
    expect(operation).toBeDefined();
    expect(operation?.requestBody?.required).toBe(true);
    expect(JSON.stringify(operation)).toContain('"additionalProperties":false');
  });

  it("admits the turn revert and diff operations, each with its closed shape", () => {
    const { projection } = projectOpenCodeV2ProtocolSurface(fixture);
    const paths = (
      projection as {
        readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      }
    ).paths;
    const stage = paths["/api/session/{sessionID}/revert/stage"]?.post as
      { readonly requestBody?: { readonly required?: boolean } } | undefined;
    expect(stage?.requestBody?.required).toBe(true);
    expect(JSON.stringify(stage)).toContain('"required":["messageID"]');
    expect(JSON.stringify(stage)).toContain('"additionalProperties":false');
    expect(paths["/api/session/{sessionID}/revert/commit"]?.post).toBeDefined();
    expect(paths["/api/session/{sessionID}/revert"]?.delete).toBeDefined();
    const diff = paths["/api/session/{sessionID}/diff"]?.get as
      { readonly parameters?: readonly { readonly name: string }[] } | undefined;
    expect(diff?.parameters?.map(({ name }) => name)).toEqual([
      "sessionID",
      "from",
      "to",
      "context",
    ]);
    // The staged revert and every diff entry carry file diffs, so their component is admitted too.
    expect(JSON.stringify(projection)).toContain('"FileDiff.Info"');
  });

  it("admits no revert operation that Keiko does not use beyond the four it names", () => {
    const { projection } = projectOpenCodeV2ProtocolSurface(fixture);
    const revertPaths = Object.keys((projection as { readonly paths: object }).paths).filter(
      (path) => /revert|diff/u.test(path),
    );
    expect([...revertPaths].sort()).toEqual([
      "/api/session/{sessionID}/diff",
      "/api/session/{sessionID}/revert",
      "/api/session/{sessionID}/revert/commit",
      "/api/session/{sessionID}/revert/stage",
    ]);
  });

  it("admits the command listing and the session command, each with its closed shape", () => {
    const { projection } = projectOpenCodeV2ProtocolSurface(fixture);
    const listing = dig(projection, "paths", "/api/command", "get");
    const run = dig(projection, "paths", "/api/session/{sessionID}/command", "post");
    const body = dig(run, "requestBody", "content", "application/json", "schema");

    const parameters = dig(listing, "parameters") as readonly { readonly name: string }[];
    expect(parameters.map(({ name }) => name)).toEqual(["location"]);
    expect(JSON.stringify(listing)).toContain("#/components/schemas/Command.Info");
    expect(dig(run, "requestBody", "required")).toBe(true);
    expect(dig(body, "required")).toEqual(["name", "text"]);
    expect(dig(body, "additionalProperties")).toBe(false);
    // The producer stores no caller-supplied message id for a command, which is why a command turn
    // cannot reuse the prompt's message-id binding (ADR-0137 D10).
    expect(Object.keys(dig(body, "properties") as object)).toEqual([
      "name",
      "text",
      "files",
      "agents",
      "skills",
      "delivery",
    ]);
    expect(JSON.stringify(run)).toContain("#/components/schemas/CommandNotFoundErrorEncoded");
  });

  it("admits no command operation beyond the listing and the session command", () => {
    const { projection } = projectOpenCodeV2ProtocolSurface(fixture);
    const commandPaths = Object.keys((projection as { readonly paths: object }).paths).filter(
      (path) => path.includes("command"),
    );
    expect([...commandPaths].sort()).toEqual(["/api/command", "/api/session/{sessionID}/command"]);
  });

  it("admits the session fork with its closed body and the fork boundary it reports", () => {
    const { projection } = projectOpenCodeV2ProtocolSurface(fixture);
    const fork = dig(projection, "paths", "/api/session/{sessionID}/fork", "post");
    const body = dig(fork, "requestBody", "content", "application/json", "schema");
    expect(dig(fork, "requestBody", "required")).toBe(true);
    expect(dig(body, "additionalProperties")).toBe(false);
    // The fork point is the message to fork BEFORE, optionally null: nothing else selects it.
    expect(Object.keys(dig(body, "properties") as object)).toEqual(["before"]);
    const schemas = dig(projection, "components", "schemas") as Readonly<Record<string, unknown>>;
    expect(JSON.stringify(schemas["Session.ForkBoundary"])).toContain('"before"');
    expect(JSON.stringify(schemas["Session.ForkBoundary"])).toContain('"through"');
    expect(JSON.stringify(fork)).toContain("#/components/schemas/MessageNotFoundErrorEncoded");
  });

  it("admits the session removal as the only operation on a session itself", () => {
    const { projection } = projectOpenCodeV2ProtocolSurface(fixture);
    const session = dig(projection, "paths", "/api/session/{sessionID}") as
      Readonly<Record<string, unknown>> | undefined;
    // `session.get` and `session.update` stay refused: only the delete is admitted on this path.
    expect(Object.keys(session ?? {})).toEqual(["delete"]);
    expect(JSON.stringify(dig(session, "delete"))).toContain(
      "#/components/schemas/SessionNotFoundErrorEncoded",
    );
  });

  it("pins the current digest to the projection of the captured document", () => {
    const { digest } = projectOpenCodeV2ProtocolSurface(fixture);
    expect(digest).toBe(OPEN_CODE_V2_PINNED_PROTOCOL_SURFACE_SHA256);
    expect(OPENCODE_RUNTIME_VERSION_PINS[0]?.protocolSurfaceSha256).toBe(digest);
  });
});
