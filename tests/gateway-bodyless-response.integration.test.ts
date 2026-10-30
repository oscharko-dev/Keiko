import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { gatewayFetch } from "@oscharko-dev/keiko-model-gateway/internal/http";
import type { ModelGatewayLogTransport } from "../packages/keiko-model-gateway/src/observability.js";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import {
  expectRegisteredActivityLogLine,
  formatActivityLogProofLine,
} from "./support/activity-log-proof.js";

async function nativeResponse(status: number): Promise<{
  events: ModelGatewayLogTransport[];
  response?: Response;
  error?: unknown;
  effects: number;
}> {
  let effects = 0;
  const server = createServer((request, response) => {
    effects++;
    request.resume();
    response.writeHead(status, { connection: "close" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const events: ModelGatewayLogTransport[] = [];
  try {
    const response = await gatewayFetch("http://127.0.0.1:9/synthetic-write", {
      method: "PUT",
      body: "{}",
      timeoutMs: 2_000,
      egress: { httpProxy: `http://127.0.0.1:${String(port)}` },
      log: {
        write: (event): void => {
          events.push(event);
        },
      },
      logContext: { correlationId: "bodyless-write-fixture" },
    });
    return { response, events, effects };
  } catch (error) {
    return { error, events, effects };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}

describe("native bodyless responses", () => {
  it.each([204, 205, 304])(
    "settles HTTP %i once and reconstructs its registered outcome",
    async (status) => {
      const result = await nativeResponse(status);
      expect(result.error).toBeUndefined();
      expect(result.response?.status).toBe(status);
      expect(result.response?.body).toBeNull();
      expect(result.effects).toBe(1);
      const completed = result.events.filter(
        (event) => event.op === "http.gateway.fetch.completed",
      );
      expect(completed).toHaveLength(1);
      const event = completed[0];
      if (!event) throw new TypeError("Missing registered completion event");
      const line = formatActivityLogProofLine(event);
      expect(expectRegisteredActivityLogLine(event.op, line)).toMatchObject({
        status,
        correlationId: "bodyless-write-fixture",
      });
      expect(analyzeLogText(line).timelines).toMatchObject([
        { correlationId: "bodyless-write-fixture", lines: [{ op: event.op, status }] },
      ]);
      expect(line).not.toContain("127.0.0.1");
      expect(line).not.toContain("synthetic-write");
    },
  );

  it("rejects an invalid native response without throwing outside the request or replaying it", async () => {
    const result = await nativeResponse(600);
    expect(result.error).toBeInstanceOf(RangeError);
    expect(result.effects).toBe(1);
    const failures = result.events.filter((event) => event.op === "http.gateway.fetch.failed");
    expect(failures).toHaveLength(1);
    const event = failures[0];
    if (!event) throw new TypeError("Missing native failure event");
    const line = formatActivityLogProofLine(event);
    expect(expectRegisteredActivityLogLine(event.op, line)).toMatchObject({
      correlationId: "bodyless-write-fixture",
    });
    expect(analyzeLogText(line).timelines).toMatchObject([
      { correlationId: "bodyless-write-fixture", lines: [{ op: event.op }] },
    ]);
    expect(line).not.toContain("127.0.0.1");
    expect(line).not.toContain("synthetic-write");
  });
});
