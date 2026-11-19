import { act, cleanup, renderHook, type RenderHookResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JiraTemplateOptions } from "@oscharko-dev/keiko-contracts/bff-wire";
import { ApiError } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { fetchJiraTemplateOptions } from "@/lib/jira-templates-api";
import {
  JIRA_TEMPLATE_OPTIONS_SETTLE_MS,
  useJiraTemplateOptions,
  type JiraOptionsRead,
} from "./useJiraTemplateOptions";

vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
vi.mock("@/lib/jira-templates-api", () => ({ fetchJiraTemplateOptions: vi.fn() }));

const TYPES: JiraTemplateOptions = {
  kind: "types",
  instanceId: "synthetic-instance",
  issueTypes: [{ id: "1", name: "Task" }],
};

interface Props {
  readonly podId: string | undefined;
  readonly projectKey?: string;
  readonly issueTypeId?: string;
}

interface OptionsView extends RenderHookResult<JiraOptionsRead, Props> {
  readonly state: () => JiraOptionsRead["state"];
}

function renderOptions(initialProps: Props): OptionsView {
  const rendered = renderHook(
    ({ podId, projectKey, issueTypeId }: Props) =>
      useJiraTemplateOptions(podId, projectKey, issueTypeId),
    { initialProps },
  );
  return { ...rendered, state: () => rendered.result.current.state };
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(JIRA_TEMPLATE_OPTIONS_SETTLE_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(fetchJiraTemplateOptions).mockReset();
  vi.mocked(reportClientDiagnostic).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useJiraTemplateOptions", () => {
  it("asks nothing without a Pod and reads the project list at once", async () => {
    vi.mocked(fetchJiraTemplateOptions).mockResolvedValue({ kind: "projects", projects: [] });
    const view = renderOptions({ podId: undefined });
    expect(view.state()).toBe("idle");
    expect(fetchJiraTemplateOptions).not.toHaveBeenCalled();

    view.rerender({ podId: "pod-one" });
    expect(fetchJiraTemplateOptions).toHaveBeenCalledOnce();
    expect(fetchJiraTemplateOptions).toHaveBeenCalledWith({ podId: "pod-one" }, expect.any(String));
    await act(async () => {});
    expect(view.state()).toBe("ready");
  });

  it("asks Jira about a project key only once the typed key has settled", async () => {
    vi.mocked(fetchJiraTemplateOptions).mockResolvedValue(TYPES);
    const view = renderOptions({ podId: "pod-one", projectKey: "L" });
    view.rerender({ podId: "pod-one", projectKey: "LA" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JIRA_TEMPLATE_OPTIONS_SETTLE_MS - 1);
    });
    view.rerender({ podId: "pod-one", projectKey: "LAB" });
    expect(fetchJiraTemplateOptions).not.toHaveBeenCalled();
    expect(view.state()).toBe("loading");

    await settle();
    expect(fetchJiraTemplateOptions).toHaveBeenCalledOnce();
    expect(fetchJiraTemplateOptions).toHaveBeenCalledWith(
      { podId: "pod-one", projectKey: "LAB" },
      expect.any(String),
    );
    expect(view.state()).toBe("ready");
  });

  it("treats a project Jira does not know as an answer, without a failure diagnostic", async () => {
    vi.mocked(fetchJiraTemplateOptions).mockRejectedValue(
      new ApiError("JIRA_PROJECT_NOT_FOUND", "Not found", 404),
    );
    const view = renderOptions({ podId: "pod-one", projectKey: "GONE" });
    await settle();
    expect(view.state()).toBe("missing");
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
  });

  it("reports a failed read once and reads again on retry", async () => {
    vi.mocked(fetchJiraTemplateOptions).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(fetchJiraTemplateOptions).mockResolvedValue(TYPES);
    const view = renderOptions({ podId: "pod-one", projectKey: "LAB" });
    await settle();
    expect(view.state()).toBe("failed");
    expect(reportClientDiagnostic).toHaveBeenCalledOnce();
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "Jira template options could not be loaded.",
      expect.objectContaining({ correlationId: expect.any(String) }),
    );

    act(() => view.result.current.retry());
    expect(view.state()).toBe("loading");
    await settle();
    expect(fetchJiraTemplateOptions).toHaveBeenCalledTimes(2);
    expect(view.state()).toBe("ready");
  });

  it("never shows a late answer for an issue type the person has left", async () => {
    let answerFirst: (value: JiraTemplateOptions) => void = () => undefined;
    vi.mocked(fetchJiraTemplateOptions).mockImplementation((selection) =>
      selection.issueTypeId === "1"
        ? new Promise((resolve) => {
            answerFirst = resolve;
          })
        : Promise.resolve({ kind: "details", fields: [], statuses: [{ id: "2", name: "Done" }] }),
    );
    const view = renderOptions({ podId: "pod-one", projectKey: "LAB", issueTypeId: "1" });
    await settle();
    view.rerender({ podId: "pod-one", projectKey: "LAB", issueTypeId: "2" });
    await settle();
    await act(async () => {
      answerFirst({ kind: "details", fields: [], statuses: [{ id: "9", name: "Stale" }] });
    });
    expect(view.result.current).toMatchObject({
      state: "ready",
      options: { kind: "details", statuses: [{ id: "2", name: "Done" }] },
    });
  });

  it("drops a pending read when the selection is cleared before it settles", async () => {
    vi.mocked(fetchJiraTemplateOptions).mockResolvedValue(TYPES);
    const view = renderOptions({ podId: "pod-one", projectKey: "LAB" });
    view.rerender({ podId: undefined, projectKey: "LAB" });
    await settle();
    expect(fetchJiraTemplateOptions).not.toHaveBeenCalled();
    expect(view.state()).toBe("idle");
  });
});
