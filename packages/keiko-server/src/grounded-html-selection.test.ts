import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  type ExplorationBudget,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { retrieveConnectedContextPack, type OrchestratorInput } from "./grounded-orchestrator.js";

const ROOT = "/html-manuals-proof";
const PREFIX = "manuals/customer-site/operator/reference/volumes/chapters/edition/current";
const TRIP = `${PREFIX}/group-0079/part-0099/vesper-dosing-interlock.html`;
const DEEP = `${Array.from({ length: 63 }, (_, i) => `section-${String(i).padStart(2, "0")}`).join("/")}/vesper-recovery-sequence.html`;
const EARLY = `${PREFIX}/data-sheets/nord-drive-calibration.html`;
const MIDDLE = `${PREFIX}/group-0040/part-0000/meridian-pump-reset.html`;
const GENERATED = "generated/handbücher/ueberhitzungsschutz.html";
const QUESTION =
  "What temperature trips the Vesper dosing interlock? Cite the authoritative manual. Keep the answer under 100 words.";

function html(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><nav>Contents &raquo; Operator reference &raquo; Maintenance &amp; inspection</nav><main><h1>${title}</h1>${body}<footer>Operator manual edition 2026.09 &copy; · Prüfhinweis</footer></main></body></html>\n`;
}

function manuals(): Readonly<Record<string, string>> {
  const generic = "<p>Consult the equipment-specific reference for model-dependent settings.</p>";
  return {
    [TRIP]: html(
      "Vesper dosing interlock",
      `<p>The Vesper dosing interlock trips at 73.5 degrees Celsius. The approved recovery sequence is documented in the deep recovery manual.</p><a href="${"../".repeat(10)}${DEEP}">Approved Vesper recovery sequence</a>`,
    ),
    [DEEP]: html(
      "Vesper recovery sequence",
      `<p>After the Vesper dosing interlock trip, wait 27 seconds before restarting. The trip temperature is specified in the Vesper dosing interlock manual.</p><a href="${"../".repeat(63)}${TRIP}">Vesper interlock temperature</a>`,
    ),
    [EARLY]: html(
      "Nord drive calibration",
      `<p>The Nord drive calibration threshold is 62 degrees Celsius.</p>${generic}`,
    ).repeat(110),
    [MIDDLE]: html(
      "Meridian pump reset",
      `<p>The Meridian pump reset delay is 18 seconds.</p>${generic}`,
    ).repeat(110),
    [GENERATED]: html(
      "&#220;berhitzungsschutz",
      "<p>The operating limit is 61.2 degrees Celsius.</p>",
    ).repeat(110),
  };
}

function workspace(): WorkspaceInfo {
  return {
    root: ROOT,
    selectedRoot: ROOT,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function request(text: string, budget?: ExplorationBudget): OrchestratorInput {
  return {
    workspaceRoot: ROOT,
    scope: {
      schemaVersion: "1",
      scopeId: "html-manuals-proof",
      workspaceRoot: ROOT,
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
      explicitConnection: true,
    },
    query: {
      kind: "natural-language",
      text,
      maxResults: 116_000,
      caseSensitive: false,
      emittedAtMs: 0,
    },
    budget: budget ?? {
      ...DEFAULT_EXPLORATION_BUDGET,
      modelInputTokensMax: 118_784,
      modelOutputTokensMax: 8_192,
      filesReadMax: null,
      elapsedMsMax: null,
    },
  };
}

async function retrieve(
  text: string,
  files = manuals(),
): Promise<{
  readonly pack: Awaited<ReturnType<typeof retrieveConnectedContextPack>>["pack"];
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
  readonly history: ReturnType<typeof vi.fn<() => Promise<readonly []>>>;
}> {
  const log = createBufferedServerLogSink();
  const history = vi.fn<() => Promise<readonly []>>(() => Promise.resolve([]));
  const output = await retrieveConnectedContextPack(request(text), {
    correlationId: "html-manuals-proof",
    fs: memFs(ROOT, files),
    detectWorkspace: workspace,
    nowMs: (): number => 0,
    activityLog: log,
    gitFileHistoryEvidence: history,
    answerer: { answer: (): Promise<string> => Promise.resolve("") },
  });
  return { pack: output.pack, log, history };
}

describe("ordinary HTML manual selection under the existing excerpt cap", () => {
  it("retains the trip manual for the full fact question when navigation-heavy manuals overflow known-fit context", async () => {
    const files = manuals();
    expect(
      Object.values(files).reduce((sum, value) => sum + Buffer.byteLength(value), 0),
    ).toBeGreaterThan(DEFAULT_EXPLORATION_BUDGET.excerptBytesMax);
    const { pack } = await retrieve(QUESTION, files);
    expect(pack.files.map((file) => file.scopePath)).toContain(TRIP);
    expect(pack.files.find((file) => file.scopePath === TRIP)?.excerpts[0]?.content).toContain(
      "73.5",
    );
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(pack.budget.excerptBytesMax);
  });

  it("focuses the named manual without reading generic navigation neighbours or probing Git", async () => {
    const { pack, history } = await retrieve(
      `Explain the trip temperature in ${TRIP}. Cite the manual and keep the answer under 100 words.`,
    );
    expect(pack.files.map((file) => file.scopePath)).toEqual([TRIP]);
    expect(pack.usage.filesRead).toBe(1);
    expect(history).not.toHaveBeenCalled();
  });

  it.each(["generated", "build", "dist"])(
    "preserves explicitly addressed manuals in an ordinary folder's %s directory",
    async (directory) => {
      const path = `${directory}/manuals/operating-limit.html`;
      const { pack, log } = await retrieve(`Explain ${path}`, {
        [path]: html("Operating limit", "<p>The operating limit is 61.2 degrees Celsius.</p>"),
      });
      expect(pack.files.map((file) => file.scopePath)).toEqual([path]);
      expect(
        log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
      ).toMatchObject({ explicitPathAdmittedCount: 1, explicitPathRejectedCount: 0 });
    },
  );
});
