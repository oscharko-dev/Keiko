import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import type {
  ChatToolBatchProgress,
  ChatToolExchange,
  ChatTurnState,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { JiraChatTools } from "./JiraChatTools";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";

type Locale = "en" | "de";

function settled(data: Record<string, unknown>): NonNullable<ChatToolExchange["result"]> {
  return {
    schemaVersion: 1,
    invocationId: "invocation-1",
    toolRef: null,
    projectionDigest: null,
    effectStarted: false,
    metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
    status: "completed",
    reason: "none",
    page: { truncated: false, reason: "none", cursor: null },
    data,
  } as NonNullable<ChatToolExchange["result"]>;
}

function batch(progress: ChatToolBatchProgress, data?: Record<string, unknown>): ChatToolExchange {
  return {
    call: { id: "batch-1", name: "jira_draft_batch", arguments: {} },
    batchProgress: progress,
    ...(data === undefined ? {} : { result: settled(data) }),
  };
}

const PROGRESS: ChatToolBatchProgress = {
  phase: "drafting",
  draftedCount: 24,
  plannedCount: 40,
  coveredRequirementCount: 87,
  requirementCount: 131,
  failedCount: 0,
};

async function renderTools(
  locale: Locale,
  exchanges: readonly ChatToolExchange[],
  turnState: ChatTurnState,
): Promise<ReturnType<typeof render>> {
  await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
  localStorage.setItem(I18N_STORAGE_KEY, locale);
  try {
    return render(
      <I18nProvider>
        <JiraChatTools transcript={{ schemaVersion: 1, exchanges }} turnState={turnState} />
      </I18nProvider>,
    );
  } finally {
    localStorage.removeItem(I18N_STORAGE_KEY);
  }
}

const BATCH_COPY = {
  en: {
    title: "Draft Jira issues from requirements",
    drafting: "Drafted 24 of 40 issues",
    outlining: "Grouping requirements …",
    complete: "Drafted 40 of 40 issues · 131 of 131 requirements covered",
    failed: "Requirements that could not be drafted: 3",
    stopped: "You stopped it after 24 of 40 issues",
    couldNotFinish: "Could not finish: 24 of 40 issues drafted",
    stoppedOutlining: "You stopped it while grouping requirements",
    none: "No issues drafted",
    uncovered: "Requirements not covered: 4",
    unfinished: "Issues not finished: 2",
    step: "Create draft · 24/40",
  },
  de: {
    title: "Jira-Vorgänge aus Anforderungen entwerfen",
    drafting: "24 von 40 Vorgängen entworfen",
    outlining: "Anforderungen werden gruppiert …",
    complete: "40 von 40 Vorgängen entworfen · 131 von 131 Anforderungen abgedeckt",
    failed: "Anforderungen, die nicht entworfen werden konnten: 3",
    stopped: "Von dir abgebrochen nach 24 von 40 Vorgängen",
    couldNotFinish: "Nicht abgeschlossen: 24 von 40 Vorgängen entworfen",
    stoppedOutlining: "Von dir abgebrochen beim Gruppieren der Anforderungen",
    none: "Keine Vorgänge entworfen",
    uncovered: "Nicht abgedeckte Anforderungen: 4",
    unfinished: "Nicht fertiggestellte Vorgänge: 2",
    step: "Entwurf erstellen · 24/40",
  },
} as const;

describe.each(["en", "de"] as const)("draft batch progress card in %s", (locale) => {
  const copy = BATCH_COPY[locale];

  it("counts drafted issues and covered requirements in blue while it runs", async () => {
    const { container } = await renderTools(locale, [batch(PROGRESS)], "pending");
    const bar = screen.getByRole("progressbar", { name: copy.drafting });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "40");
    expect(bar).toHaveAttribute("aria-valuenow", "24");
    expect(screen.getByText(copy.title)).toBeVisible();
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "info");
    expect(
      screen.getAllByText(new RegExp(copy.step.replace("/", "\\/"), "u")).length,
    ).toBeGreaterThan(0);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("states the phase without a value while it outlines", async () => {
    const { container } = await renderTools(
      locale,
      [batch({ ...PROGRESS, phase: "outlining", draftedCount: 0, plannedCount: 0 })],
      "pending",
    );
    const bar = screen.getByRole("progressbar", { name: copy.outlining });
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).not.toHaveAttribute("aria-valuemax");
    expect(bar).not.toHaveAttribute("aria-label");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("turns green when complete without failures", async () => {
    const done = { ...PROGRESS, phase: "complete", draftedCount: 40, coveredRequirementCount: 131 };
    const { container } = await renderTools(
      locale,
      [batch(done as ChatToolBatchProgress, { ...done, outcome: "succeeded" })],
      "completed",
    );
    expect(screen.getByRole("progressbar", { name: copy.complete })).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "success");
    expect(screen.queryByText(copy.failed)).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("warns, with one sentence, only when a part could not be drafted", async () => {
    const done = {
      ...PROGRESS,
      phase: "complete",
      draftedCount: 37,
      plannedCount: 40,
      failedCount: 3,
      coveredRequirementCount: 128,
    } as ChatToolBatchProgress;
    const { container } = await renderTools(
      locale,
      [
        batch(done, {
          ...done,
          outcome: "succeeded",
          failedRequirementRefs: ["R-1", "R-2", "R-3"],
        }),
      ],
      "completed",
    );
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText(copy.failed)).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("freezes in warning and says the person stopped it when the turn was cancelled", async () => {
    const { container } = await renderTools(locale, [batch(PROGRESS)], "cancelled");
    expect(screen.getByRole("progressbar", { name: copy.stopped })).toHaveAttribute(
      "aria-valuenow",
      "24",
    );
    const root = container.querySelector("[data-tone]");
    expect(root).toHaveAttribute("data-tone", "warning");
    expect(root).toHaveAttribute("data-stopped", "true");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says it could not finish, not that it was stopped, when the turn failed", async () => {
    const { container } = await renderTools(locale, [batch(PROGRESS)], "failed");
    expect(screen.getByRole("progressbar", { name: copy.couldNotFinish })).toHaveAttribute(
      "aria-valuenow",
      "24",
    );
    expect(screen.queryByText(copy.stopped)).toBeNull();
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "warning");
    expect(container.querySelector("[data-stopped]")).toHaveAttribute("data-stopped", "true");
  });

  it("announces its phase in a status region and marks grouping as working", async () => {
    const { container } = await renderTools(
      locale,
      [batch({ ...PROGRESS, phase: "outlining", draftedCount: 0, plannedCount: 0 })],
      "pending",
    );
    const region = screen
      .getAllByRole("status")
      .find((node) => node.contains(screen.getByRole("progressbar")));
    expect(region).toBeDefined();
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-indeterminate", "true");
  });

  it("does not mark a counted bar as working", async () => {
    const { container } = await renderTools(locale, [batch(PROGRESS)], "pending");
    expect(container.querySelector("[data-tone]")).not.toHaveAttribute("data-indeterminate");
  });

  it("names a stop while grouping without a count", async () => {
    await renderTools(
      locale,
      [batch({ ...PROGRESS, phase: "outlining", draftedCount: 0, plannedCount: 0 })],
      "cancelled",
    );
    const bar = screen.getByRole("progressbar", { name: copy.stoppedOutlining });
    expect(bar).not.toHaveAttribute("aria-valuenow");
  });

  it("warns and counts what a complete batch left uncovered or unfinished", async () => {
    const done = {
      ...PROGRESS,
      phase: "complete",
      draftedCount: 38,
      coveredRequirementCount: 127,
      requirementCount: 131,
    } as ChatToolBatchProgress;
    const { container } = await renderTools(locale, [batch(done, { ...done })], "completed");
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText(copy.uncovered)).toBeVisible();
    expect(screen.getByText(copy.unfinished)).toBeVisible();
  });

  it("is neutral, not green, when a complete batch drafted no issue", async () => {
    const done = {
      ...PROGRESS,
      phase: "complete",
      draftedCount: 0,
      plannedCount: 0,
      coveredRequirementCount: 0,
      requirementCount: 0,
    } as ChatToolBatchProgress;
    const { container } = await renderTools(locale, [batch(done, { ...done })], "completed");
    expect(screen.getByRole("progressbar", { name: copy.none })).not.toHaveAttribute(
      "aria-valuenow",
    );
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "warning");
  });

  it("falls back to the settled result counts after a reload", async () => {
    const data = {
      outcome: "succeeded",
      draftedCount: 40,
      plannedCount: 40,
      failedCount: 0,
      coveredRequirementCount: 131,
      requirementCount: 131,
    };
    const exchange: ChatToolExchange = {
      call: { id: "batch-1", name: "jira_draft_batch", arguments: {} },
      result: settled(data),
    };
    await renderTools(locale, [exchange], "completed");
    expect(screen.getByRole("progressbar", { name: copy.complete })).toBeVisible();
  });
});

function requirementsPage(
  id: string,
  references: readonly string[],
  totals: Record<string, unknown>,
  nextCursor?: string,
): ChatToolExchange {
  return {
    call: { id, name: "knowledge_requirements", arguments: { view: "units" } },
    result: settled({
      outcome: "succeeded",
      view: "units",
      totals: { detectedCount: 131, matchedCount: 131, cutReasons: [], ...totals },
      items: references.map((reference) => ({ reference })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }),
  };
}
const refs = (from: number, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `REQ-${String(from + index)}`);

const READ_COPY = {
  en: {
    label: "Requirements",
    thirty: "Requirements read: 30 of 131",
    all: "Requirements read: 131 of 131",
    cut: "Documents that could not be read: 2",
  },
  de: {
    label: "Anforderungen",
    thirty: "Anforderungen gelesen: 30 von 131",
    all: "Anforderungen gelesen: 131 von 131",
    cut: "Dokumente, die nicht gelesen werden konnten: 2",
  },
} as const;

describe.each(["en", "de"] as const)("consolidated requirements read card in %s", (locale) => {
  const copy = READ_COPY[locale];

  it("shows one card counting two pages of 15 as 30 of 131", async () => {
    const { container } = await renderTools(
      locale,
      [
        requirementsPage("p1", refs(1, 15), {}, "c2"),
        requirementsPage("p2", refs(16, 15), {}, "c3"),
      ],
      "pending",
    );
    expect(screen.getAllByRole("region", { name: copy.label })).toHaveLength(1);
    const bar = screen.getByRole("progressbar", { name: copy.thirty });
    expect(bar).toHaveAttribute("aria-valuenow", "30");
    expect(bar).toHaveAttribute("aria-valuemax", "131");
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "info");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("counts a repeated unit once and turns green when everything was returned", async () => {
    const { container } = await renderTools(
      locale,
      [requirementsPage("p1", refs(1, 70), {}, "c2"), requirementsPage("p2", refs(60, 72), {})],
      "completed",
    );
    expect(screen.getByRole("progressbar", { name: copy.all })).toHaveAttribute(
      "aria-valuenow",
      "131",
    );
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "success");
  });

  it("warns, naming what was left out, only for a real cut", async () => {
    const { container } = await renderTools(
      locale,
      [requirementsPage("p1", refs(1, 15), { documentsNotExtracted: 2 })],
      "completed",
    );
    expect(screen.getByText(copy.cut)).toBeVisible();
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "warning");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("keeps different filters apart", async () => {
    const other = requirementsPage("p2", refs(1, 5), { matchedCount: 20 }, "c2");
    const filtered: ChatToolExchange = {
      ...other,
      call: { ...other.call, arguments: { view: "units", priorities: ["must"] } },
    };
    await renderTools(
      locale,
      [requirementsPage("p1", refs(1, 15), {}, "c2"), filtered],
      "completed",
    );
    expect(screen.getAllByRole("region", { name: copy.label })).toHaveLength(2);
    const card = screen.getAllByRole("region", { name: copy.label })[1];
    expect(card && within(card).getByRole("progressbar")).toHaveAttribute("aria-valuemax", "20");
  });
});
