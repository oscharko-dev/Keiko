import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { codingAppSessionAcknowledgement } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { workspaceApiFixture } from "../../../../test-utils/workspace-api-fixture";
import { WindowFrame } from "./WindowFrame";
import { registerWindowRender, WIN_TYPES } from "./WindowsRegistry";
import type { AppWindow } from "./types";

interface FixtureResponse {
  status: number;
  body?: string;
}
interface FixtureRoute {
  request(): { method(): string; postDataJSON(): unknown };
  fulfill(response: FixtureResponse): Promise<void>;
}
interface CaptureHarness {
  windows: AppWindow[];
  models: ModelCapability[];
  fulfillApiRoute(route: FixtureRoute, url: URL, unexpected: Set<string>): Promise<void>;
}

function captureHarness(): CaptureHarness {
  const source = readFileSync(
    resolve(process.cwd(), "../../docs/design-system/evidence/1300/browser/capture.mjs"),
    "utf8",
  );
  // Evaluate the actual fixtures/router only; never run its build, server or screenshot entrypoint.
  const fixtures = source.slice(
    source.indexOf("const DEMO_ROOT ="),
    source.indexOf("const browser = await chromium.launch();"),
  );
  return runInNewContext(
    `${fixtures}\n({windows: WORKSPACE_WINDOWS, models: DEMO_MODELS, fulfillApiRoute});`,
    {
      createHash,
      URL,
      URLSearchParams,
      codingAppSessionAcknowledgement,
      deriveContextProfileFromCapability,
    },
  ) as CaptureHarness;
}

async function requestFixture(
  method: string,
  pathname: string,
): Promise<{
  response: FixtureResponse;
  unexpected: Set<string>;
}> {
  let response: FixtureResponse | undefined;
  const unexpected = new Set<string>();
  await captureHarness().fulfillApiRoute(
    {
      request: () => ({ method: (): string => method, postDataJSON: (): unknown => ({}) }),
      fulfill: (value): Promise<void> => {
        response = value;
        return Promise.resolve();
      },
    },
    new URL(pathname, "http://127.0.0.1"),
    unexpected,
  );
  if (response === undefined) throw new Error("Fixture did not fulfill the request");
  return { response, unexpected };
}

const apiCases = [
  ["POST", "/api/diagnostics/client", 204],
  ["POST", "/api/coding-workbench/app-session/local-session", 200],
  ["POST", "/api/git-delivery/commit/preview", 200],
  ["GET", "/api/chats/context", 200],
] as const;

describe("running-app capture API fixtures", () => {
  it.each(apiCases)("admits the actual %s %s contract", async (method, pathname, status) => {
    const result = await requestFixture(method, pathname);
    expect(result.response.status).toBe(status);
    expect(result.unexpected.size).toBe(0);
    if (status === 204) expect(result.response.body).toBeUndefined();
  });

  it("confirms local-session without creating or exposing authority", async () => {
    const { response } = await requestFixture(
      "POST",
      "/api/coding-workbench/app-session/local-session",
    );
    expect(JSON.parse(response.body ?? "null")).toEqual(codingAppSessionAcknowledgement());
  });

  it("derives empty-chat context geometry from the configured model", async () => {
    const model = captureHarness().models[0];
    if (model === undefined) throw new Error("Missing capture model");
    const profile = deriveContextProfileFromCapability(model);
    const { response } = await requestFixture("GET", "/api/chats/context");
    expect(JSON.parse(response.body ?? "null")).toEqual({
      modelId: model.id,
      contextWindowTokens: profile.maxInputTokens,
      inputBudgetTokens: profile.effectiveInputBudget,
      reservedOutputTokens: profile.reservedOutputTokens,
      safetyMarginTokens: profile.safetyMarginTokens,
      estimatedInputTokens: 0,
      canCompact: false,
    });
  });

  it.each(apiCases)("rejects the opposite method for %s %s", async (method, pathname) => {
    const result = await requestFixture(method === "GET" ? "POST" : "GET", pathname);
    expect(result.response.status).toBe(501);
    expect(JSON.parse(result.response.body ?? "null")).toEqual({
      error: { code: "STATIC_EVIDENCE_UNEXPECTED_API" },
    });
    expect([...result.unexpected]).toEqual([
      expect.stringMatching(/^request_sha256=[a-f0-9]{64}$/u),
    ]);
  });

  it.each(["GET", "POST"])("rejects unknown %s routes", async (method) => {
    const result = await requestFixture(method, "/api/not-a-capture-fixture");
    expect(result.response.status).toBe(501);
    expect(result.unexpected.size).toBe(1);
  });
});

const originalGitRender = WIN_TYPES.governedGit.render;
afterEach(() => registerWindowRender("governedGit", originalGitRender));

it("seeds the narrowest constrained Git frame that renders its full body", () => {
  const win = captureHarness().windows.find((entry) => entry.id === "issue-1574-git-constrained");
  if (win === undefined) throw new Error("Missing constrained Git window");
  registerWindowRender("governedGit", () => <div data-testid="capture-git-shell" />);
  const props = {
    top: true,
    connState: null,
    linkRevision: 0,
    api: workspaceApiFixture(),
    wsRef: createRef<HTMLElement>(),
  };
  const view = render(<WindowFrame win={win} {...props} />);
  expect(screen.getByTestId("capture-git-shell").closest(".win-body")).toHaveAttribute(
    "data-mode",
    "full",
  );
  expect(win.w).toBeLessThan(WIN_TYPES.governedGit.min.w);
  view.rerender(<WindowFrame win={{ ...win, w: win.w - 1 }} {...props} />);
  expect(screen.queryByTestId("capture-git-shell")).not.toBeInTheDocument();
  expect(view.container.querySelector(".win-body")).toHaveAttribute("data-mode", "tiny");
});
