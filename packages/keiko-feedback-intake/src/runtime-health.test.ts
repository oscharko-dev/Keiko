import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createManagementHandler, type RuntimeHealthState } from "./runtime.js";

interface HealthResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

function request(health: RuntimeHealthState, enabled: boolean, path: string): HealthResponse {
  let statusCode = 0;
  let bytes = Buffer.alloc(0);
  const response = {
    writeHead: (status: number): void => {
      statusCode = status;
    },
    end: (body: Uint8Array): void => {
      bytes = Buffer.from(body);
    },
  } as unknown as ServerResponse;
  createManagementHandler(health, enabled)(
    { method: "GET", url: path } as IncomingMessage,
    response,
  );
  return { statusCode, body: JSON.parse(bytes.toString("utf8")) as unknown };
}

describe("publication management health", () => {
  it("reports disabled without configuration detail", () => {
    const health = { running: true, dependenciesHealthy: true, publicationHealthy: false };
    expect(request(health, false, "/ready/publication")).toEqual({
      statusCode: 200,
      body: { status: "disabled" },
    });
    health.running = false;
    expect(request(health, false, "/ready/publication")).toEqual({
      statusCode: 503,
      body: { status: "unavailable" },
    });
  });

  it("keeps intake ready through publication degradation, recovery, and stopping", () => {
    const health = { running: true, dependenciesHealthy: true, publicationHealthy: true };
    expect(request(health, true, "/ready/publication")).toEqual({
      statusCode: 200,
      body: { status: "ok" },
    });
    for (let failure = 1; failure <= 3; failure += 1) {
      if (failure === 3) health.publicationHealthy = false;
    }
    expect(request(health, true, "/ready")).toEqual({
      statusCode: 200,
      body: { status: "ok" },
    });
    expect(request(health, true, "/ready/publication")).toEqual({
      statusCode: 503,
      body: { status: "unavailable" },
    });
    health.publicationHealthy = true;
    expect(request(health, true, "/ready/publication").statusCode).toBe(200);
    health.running = false;
    expect(request(health, true, "/ready/publication")).toEqual({
      statusCode: 503,
      body: { status: "unavailable" },
    });
  });
});
