import { describe, expect, it } from "vitest";

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

describe("OpenCode v1.17.17 protocol-surface projection", () => {
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
