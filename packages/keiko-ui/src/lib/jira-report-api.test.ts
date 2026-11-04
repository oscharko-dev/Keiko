import { beforeEach, describe, expect, it, vi } from "vitest";

const bffFetchJson = vi.fn();
vi.mock("./http", () => ({
  bffFetchJson: (...args: unknown[]): unknown => bffFetchJson(...args),
}));

import { exportJiraReport } from "./jira-report-api";

const CONTENT = "report\n";
const FILE = {
  format: "csv",
  fileName: "keiko-jira-report-0123456789ab.csv",
  mediaType: "text/csv",
  content: CONTENT,
  byteCount: new TextEncoder().encode(CONTENT).byteLength,
  reportDigest: "a".repeat(64),
};

type Validator = (path: string, value: unknown) => unknown;
async function validatorFor(): Promise<Validator> {
  bffFetchJson.mockResolvedValue(FILE);
  await exportJiraReport("11111111-2222-4333-8444-555555555555", "chat 1", "csv", "correlation-1");
  const options = bffFetchJson.mock.calls[0]?.[2] as {
    validator: Validator;
    correlationId: string;
  };
  expect(options.correlationId).toBe("correlation-1");
  return options.validator;
}

beforeEach(() => {
  bffFetchJson.mockReset();
});

describe("exportJiraReport", () => {
  it("asks the Chat-bound export route for exactly one format", async () => {
    await validatorFor();
    expect(bffFetchJson.mock.calls[0]?.[0]).toBe(
      "/api/atlassian-connectors/jira-reports/11111111-2222-4333-8444-555555555555/export?chatId=chat+1&format=csv",
    );
  });

  it("accepts the file asked for", async () => {
    expect((await validatorFor())("/x", FILE)).toEqual(FILE);
  });

  it.each([
    ["another format", { ...FILE, format: "markdown" }],
    ["another media type", { ...FILE, mediaType: "text/plain" }],
    ["an unexpected file name", { ...FILE, fileName: "../report.csv" }],
    ["a byte count that does not match", { ...FILE, byteCount: 1 }],
    ["a malformed digest", { ...FILE, reportDigest: "zz" }],
    ["no object", "csv"],
  ])("refuses %s as a contract failure", async (_name, value) => {
    const validator = await validatorFor();
    expect(() => validator("/x", value)).toThrow("Invalid Jira report export");
  });
});
