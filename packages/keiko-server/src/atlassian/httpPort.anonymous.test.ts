import { describe, expect, it, vi } from "vitest";
import type { AtlassianResolvedCredential } from "@oscharko-dev/keiko-connectors";
import { createGatewayAtlassianHttpBodyPort, createGatewayAtlassianHttpPort } from "./httpPort.js";

describe("authenticated Atlassian reads", () => {
  it.each([
    ["GET", 200, "test-actor", 200],
    ["GET", 200, undefined, 200],
    ["GET", 503, "anonymous", 503],
    ["POST", 201, "anonymous", 201],
    ["PUT", 200, "anonymous", 200],
  ] as const)(
    "preserves observed %s/%s acknowledgement with header %s",
    async (method, status, actor, expected) => {
      const onResponse = vi.fn(() => true);
      const port = createGatewayAtlassianHttpBodyPort({
        baseUrl: "https://jira.example",
        authRef: "atlassian-cred:synthetic-reference",
        credentials: {
          resolveForExecution: (): AtlassianResolvedCredential => ({
            scheme: "bearer-pat",
            apiToken: "synthetic-token",
          }),
        },
        fetchImpl: () =>
          Promise.resolve(
            new Response("[]", {
              status,
              headers: actor === undefined ? {} : { "X-AUSERNAME": actor },
            }),
          ),
        onResponse,
      });
      const request = {
        method,
        url: "https://jira.example/rest/api/2/project",
        timeoutMs: 1000,
        maxBodyBytes: 1024,
      };
      expect(await port(request)).toMatchObject({
        kind: "response",
        status: expected,
        bodyText: "[]",
      });
      expect(onResponse).toHaveBeenCalledWith(request, expected);
    },
  );
  it.each([false, true])(
    "refuses an anonymous 200 instead of reporting an empty project list (body=%s)",
    async (body) => {
      const onResponse = vi.fn(() => true);
      const options = {
        baseUrl: "https://jira.example",
        authRef: "atlassian-cred:synthetic-reference",
        credentials: {
          resolveForExecution: (): AtlassianResolvedCredential => ({
            scheme: "bearer-pat" as const,
            apiToken: "synthetic-token",
          }),
        },
        fetchImpl: vi.fn(() =>
          Promise.resolve(
            new Response("[]", {
              status: 200,
              headers: { "X-AUSERNAME": "anonymous" },
            }),
          ),
        ),
        onResponse,
      };
      const request = {
        method: "GET" as const,
        url: "https://jira.example/rest/api/2/project",
        timeoutMs: 1000,
        maxBodyBytes: 1024,
      };
      const result = body
        ? await createGatewayAtlassianHttpBodyPort(options)(request)
        : await createGatewayAtlassianHttpPort(options)(request);
      expect(result).toMatchObject({ kind: "response", status: 401 });
      expect(onResponse).toHaveBeenCalledWith(request, 401);
      expect(result).not.toHaveProperty("headers");
      if (body) expect(result).toMatchObject({ bodyText: "", bodyBytes: 0, truncated: false });
    },
  );
});
