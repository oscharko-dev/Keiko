import { describe, expect, it } from "vitest";
import { mockRequest, mockResponse } from "./_support.js";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryFeedbackIntakeService } from "./feedback-intake.js";
import {
  handleFeedbackCreateGithubIssue,
  handleFeedbackPreview,
  handleFeedbackReview,
  handleFeedbackSubmit,
} from "./feedback-intake-routes.js";

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: (value: unknown) =>
      typeof value === "string"
        ? value.replaceAll("ghp_0123456789abcdef0123456789abcdef0123", "[REDACTED]")
        : value,
    registry: {
      create: () => {
        throw new Error("not used");
      },
      get: () => undefined,
      list: () => [],
      cancel: () => false,
      subscribe: () => () => undefined,
    },
    modelPortFactory: () => undefined,
    store: {},
    feedbackIntake: createInMemoryFeedbackIntakeService({
      now: () => "2026-07-07T00:00:00.000Z",
      newId: () => "fb_test",
    }),
    ...overrides,
  } as UiHandlerDeps;
}

function ctx(body: unknown, params: Readonly<Record<string, string>> = {}): RouteContext {
  const { res } = mockResponse();
  return {
    req: mockRequest({
      body: JSON.stringify(body),
      method: "POST",
      url: "http://127.0.0.1/api/feedback",
    }),
    res,
    params,
    url: new URL("http://127.0.0.1/api/feedback"),
  };
}

describe("feedback intake routes", () => {
  it("returns a redacted preview with provenance", async () => {
    const result = await handleFeedbackPreview(
      ctx({
        category: "bug",
        severity: "high",
        title: "Token ghp_0123456789abcdef0123456789abcdef0123",
        description: "Do not leak ghp_0123456789abcdef0123456789abcdef0123",
      }),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain("ghp_0123456789abcdef");
    expect(JSON.stringify(result.body)).toContain("keiko-feedback-redaction");
  });

  it("submits only a redacted preview payload", async () => {
    const d = deps();
    const preview = await handleFeedbackPreview(
      ctx({
        category: "bug",
        severity: "medium",
        title: "Preview issue",
        description: "Panel does not render.",
      }),
      d,
    );

    const result = await handleFeedbackSubmit(ctx({ preview: preview.body }), d);

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ receipt: { intakeId: "fb_test" }, status: "new" });
  });

  it("rejects submit when redaction provenance is missing", async () => {
    const result = await handleFeedbackSubmit(
      ctx({
        preview: {
          report: {
            category: "bug",
            severity: "medium",
            title: "Preview issue",
            description: "Panel does not render.",
          },
        },
      }),
      deps(),
    );

    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("FEEDBACK_MISSING_REDACTION_PROVENANCE");
  });

  it("rate-limits intake submissions fail-closed", async () => {
    const d = deps({
      feedbackIntake: createInMemoryFeedbackIntakeService({
        now: () => "2026-07-07T00:00:00.000Z",
        newId: () => "fb_rate_limit",
        rateLimitWindowMs: 60_000,
        rateLimitMaxSubmissions: 1,
      }),
    });
    const preview = await handleFeedbackPreview(
      ctx({
        category: "bug",
        severity: "medium",
        title: "Preview issue",
        description: "Panel does not render.",
      }),
      d,
    );

    expect((await handleFeedbackSubmit(ctx({ preview: preview.body }), d)).status).toBe(201);
    const second = await handleFeedbackSubmit(ctx({ preview: preview.body }), d);

    expect(second.status).toBe(429);
    expect(JSON.stringify(second.body)).toContain("FEEDBACK_RATE_LIMITED");
  });

  it("requires review approval before GitHub issue creation and fails closed when adapter is absent", async () => {
    const d = deps();
    const preview = await handleFeedbackPreview(
      ctx({
        category: "bug",
        severity: "medium",
        title: "Preview issue",
        description: "Panel does not render.",
      }),
      d,
    );
    await handleFeedbackSubmit(ctx({ preview: preview.body }), d);

    const beforeReview = await handleFeedbackCreateGithubIssue(ctx({}, { intakeId: "fb_test" }), d);
    expect(beforeReview.status).toBe(503);

    await handleFeedbackReview(
      ctx({ action: "approve-for-github", actor: "maintainer" }, { intakeId: "fb_test" }),
      d,
    );
    const afterReview = await handleFeedbackCreateGithubIssue(ctx({}, { intakeId: "fb_test" }), d);
    expect(afterReview.status).toBe(503);
    expect(JSON.stringify(afterReview.body)).toContain("FEEDBACK_GITHUB_UNAVAILABLE");
  });

  it("creates a GitHub issue through the injected adapter after approval", async () => {
    const base = createInMemoryFeedbackIntakeService({
      now: () => "2026-07-07T00:00:00.000Z",
      newId: () => "fb_test",
    });
    const d = deps({
      feedbackIntake: base,
      feedbackGithubIssueCreator: {
        createIssue: (draft: { readonly title: string }) =>
          Promise.resolve({
            repository: "oscharko-dev/Keiko",
            number: 99,
            url: `https://github.com/oscharko-dev/Keiko/issues/99?title=${encodeURIComponent(
              draft.title,
            )}`,
            createdAt: "2026-07-07T00:01:00.000Z",
          }),
      },
    });
    const preview = await handleFeedbackPreview(
      ctx({
        category: "bug",
        severity: "medium",
        title: "Preview issue",
        description: "Panel does not render.",
      }),
      d,
    );
    await handleFeedbackSubmit(ctx({ preview: preview.body }), d);
    await handleFeedbackReview(
      ctx({ action: "approve-for-github", actor: "maintainer" }, { intakeId: "fb_test" }),
      d,
    );

    const result = await handleFeedbackCreateGithubIssue(ctx({}, { intakeId: "fb_test" }), d);

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      review: { status: "github-created" },
      githubIssue: { number: 99 },
    });
  });
});
