import { describe, expect, it } from "vitest";

import { runFeedbackFlow, runFeedbackNegativeCase } from "./feedback-flow-2077-support.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? it.skip : it;

describe("governed feedback flow", () => {
  integration(
    "moves one exact prepared report from local preview to one public issue",
    async () => {
      const result = await runFeedbackFlow(databaseUrl ?? "");

      expect(result).toEqual({
        createdIssues: 1,
        exactBytesPreserved: true,
        publicIssueNumber: 2077,
        publicIssueUrl: "https://github.com/keiko-feedback/public-findings/issues/2077",
      });
    },
    30_000,
  );

  if (databaseUrl === undefined) {
    it.skip("requires DATABASE_URL for negative flow scenarios", () => undefined);
  } else {
    it.each(["unsafe", "unavailable", "rate-limited", "github-permission"] as const)(
      "%s fails closed without an unintended public issue",
      async (scenario) => {
        expect(await runFeedbackNegativeCase(databaseUrl, scenario)).toEqual({
          createdIssues: 0,
          persistedPayloads:
            scenario === "rate-limited" || scenario === "github-permission" ? 1 : 0,
          rejectedAttemptDidNotPersist: true,
          safeTerminalState: true,
        });
      },
      30_000,
    );
  }
});
