import { beforeEach, expect, it, vi } from "vitest";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { bffFetchJson } from "./http";
import { validateJiraTemplate } from "./jira-templates-api";

vi.mock("./coding-app-session-client", () => ({ codingAppSessionPairingSettled: vi.fn() }));
vi.mock("./http", () => ({ bffFetchJson: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

it("keeps validation content in the request body and its logical correlation id in transport metadata", async () => {
  vi.mocked(codingAppSessionPairingSettled).mockResolvedValue(true);
  const validation = { valid: false, errors: [] };
  vi.mocked(bffFetchJson).mockResolvedValue(validation);
  expect(await validateJiraTemplate("pod-id", "PRIVATE template body", "validation-run")).toEqual(
    validation,
  );
  expect(codingAppSessionPairingSettled).toHaveBeenCalledOnce();
  expect(bffFetchJson).toHaveBeenCalledExactlyOnceWith(
    "/api/skills/jira-templates/validate",
    {
      signal: expect.any(AbortSignal),
      method: "POST",
      body: JSON.stringify({ podId: "pod-id", markdown: "PRIVATE template body" }),
    },
    { correlationId: "validation-run" },
  );
});
