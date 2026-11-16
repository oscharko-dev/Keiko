import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { resolveCorrelationId } from "./correlation.js";
it("keeps one generated correlation for every observation of the same HTTP request", () => {
  const request = { headers: {} } as IncomingMessage;
  const correlation = resolveCorrelationId(request);
  expect(resolveCorrelationId(request)).toBe(correlation);
  expect(resolveCorrelationId({ headers: {} } as IncomingMessage)).not.toBe(correlation);
});
