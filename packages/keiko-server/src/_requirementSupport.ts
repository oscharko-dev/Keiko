// Test-only fixtures for the requirement inventory tool and trace (#4179): real Knowledge Pods in
// a temporary state directory and the deps that open them, as production does. Not production code.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type { ChatLocalKnowledgeScope } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { JiraReport, JiraReportStore } from "@oscharko-dev/keiko-connectors";
import { openKnowledgeStore, resolveKnowledgeStorePath } from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";

import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/db.js";

export interface PodSpec {
  readonly capsuleId: string;
  readonly text: string;
  readonly name?: string;
}

/** A specification of `count` requirements in the Markdown layout of the lab corpus. */
export function specification(
  count: number,
  options: { readonly revise?: readonly number[]; readonly prefix?: string } = {},
): { readonly text: string; readonly ids: readonly string[] } {
  const prefix = options.prefix ?? "LH";
  const lines = ["# Lastenheft", "", "Schadenmeldungen werden heute telefonisch erfasst.", ""];
  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `${prefix}-${String(index).padStart(3, "0")}`;
    ids.push(id);
    const limit = options.revise?.includes(index) === true ? 15 : 10;
    const vague = index % 7 === 0;
    lines.push(
      `### ${id} Thema ${String(index)}`,
      "",
      vague
        ? `Das Portal unterstützt Thema ${String(index)} schnell und benutzerfreundlich.`
        : `Das Portal unterstützt Thema ${String(index)}; die Bearbeitung ist innerhalb von ${String(limit)} Minuten abgeschlossen.`,
    );
    if (index % 9 !== 0)
      lines.push(
        "",
        "Abnahmekriterien:",
        `- Thema ${String(index)} ist verfügbar.`,
        `- Fehler zu Thema ${String(index)} werden gemeldet.`,
      );
    lines.push("", `Priorität: ${index % 3 === 0 ? "Soll" : "Muss"}.`, "");
  }
  return { text: lines.join("\n"), ids };
}

/** The sections a Word or PowerPoint parser records: one per heading, up to the next heading. */
function recordHeadingSections(
  db: ReturnType<typeof openKnowledgeStore>,
  capsuleId: string,
  documentId: string,
  text: string,
): void {
  const headings = [...text.matchAll(/^### (.+)$/gmu)];
  const insert = db._internal.db.prepare(
    "INSERT INTO sections (capsule_id, document_id, section_path_json, character_start, character_end) VALUES (?, ?, ?, ?, ?)",
  );
  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.index ?? text.length;
    const path = JSON.stringify(["Lastenheft", heading[1]]);
    insert.run(
      capsuleId,
      documentId,
      db._internal.contentCipher.sealText(path),
      heading.index,
      end,
    );
  });
}

export interface PodFixture {
  readonly deps: UiHandlerDeps;
  readonly runtimeDir: string;
  readonly chatId: string;
  readonly capsuleIds: readonly KnowledgeCapsuleId[];
  /** Runs `change` against the Knowledge store the deps open (for lifecycle or status edits). */
  readonly withStore: (change: (store: ReturnType<typeof openKnowledgeStore>) => void) => void;
  readonly cleanup: () => void;
}

function podSeedSpec(pod: PodSpec): Parameters<typeof seedCapsuleWithVectors>[1] {
  return {
    capsuleId: pod.capsuleId,
    sourceId: `src-${pod.capsuleId}`,
    documentId: `doc-${pod.capsuleId}`,
    text: pod.text,
    safeDisplayName: pod.name ?? `${pod.capsuleId}.md`,
    contentHash: pod.capsuleId.padEnd(64, "c").slice(0, 64),
    unit: {
      kind: "page" as const,
      pageNumber: 3,
      pageLabel: "3",
      characterStart: 0,
      characterEnd: pod.text.length,
    },
    chunkingOptions: { maxTokens: 120, minTokens: 0, overlapTokens: 0 },
  };
}

async function seedPod(
  seeding: ReturnType<typeof openKnowledgeStore>,
  pod: PodSpec,
): Promise<KnowledgeCapsuleId> {
  const seeded = await seedCapsuleWithVectors(seeding, podSeedSpec(pod));
  recordHeadingSections(seeding, pod.capsuleId, `doc-${pod.capsuleId}`, pod.text);
  seeding._internal.db
    .prepare("UPDATE capsules SET lifecycle_state = 'ready' WHERE id = ?")
    .run(pod.capsuleId);
  return seeded.capsuleId;
}

/** Seeds the pods one after another into one SQLite store, in order. */
async function seedPods(
  dbPath: string,
  pods: readonly PodSpec[],
): Promise<readonly KnowledgeCapsuleId[]> {
  const seeding = openKnowledgeStore({ dbPath });
  try {
    return await pods.reduce<Promise<readonly KnowledgeCapsuleId[]>>(
      (seeded, pod) => seeded.then(async (ids) => [...ids, await seedPod(seeding, pod)]),
      Promise.resolve([]),
    );
  } finally {
    seeding.close();
  }
}

function handlerDeps(
  store: ReturnType<typeof createInMemoryUiStore>,
  uiDbPath: string,
  redactor: UiHandlerDeps["redactor"],
): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): undefined => undefined,
      delete: (): undefined => undefined,
    },
    env: {},
    redactor,
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store,
    uiDbPath,
  };
}

export async function podFixture(
  pods: readonly PodSpec[],
  options: { readonly redactor?: (value: unknown) => unknown; readonly bindPods?: boolean } = {},
): Promise<PodFixture> {
  const runtimeDir = mkdtempSync(join(tmpdir(), "keiko-requirements-"));
  const uiDbPath = join(runtimeDir, "ui.db");
  const dbPath = resolveKnowledgeStorePath({ runtimeStateDir: dirname(uiDbPath) });
  mkdirSync(dirname(dbPath), { recursive: true });
  const capsuleIds = await seedPods(dbPath, pods);
  const store = createInMemoryUiStore();
  const project = store.createProject(runtimeDir, "requirements-project");
  const chat = store.createChat(project.path, "Requirements", "chat-model");
  const scopes: ChatLocalKnowledgeScope[] = capsuleIds.map((capsuleId) => ({
    kind: "capsule",
    capsuleId,
    connectedAtMs: 1,
  }));
  if (options.bindPods !== false && scopes.length > 0)
    store.updateChat(chat.id, { localKnowledgeScopes: scopes });
  const redactor = options.redactor ?? buildRedactor({});
  return {
    deps: handlerDeps(store, uiDbPath, redactor),
    runtimeDir,
    chatId: chat.id,
    capsuleIds,
    withStore: (change): void => {
      const opened = openKnowledgeStore({ dbPath });
      try {
        change(opened);
      } finally {
        opened.close();
      }
    },
    cleanup: (): void => {
      store.close();
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

/** A Jira issue as a finished report keeps it: its key and the labels it carries. */
export interface ReportedIssue {
  readonly key: string;
  readonly labels: readonly string[];
}

function rowsOf(issues: readonly ReportedIssue[]): JiraReport["rows"] {
  return issues.map((issue) => ({
    issue: {
      key: issue.key,
      typeName: "Epic",
      subtask: false,
      summary: "",
      statusName: "Open",
      category: "new",
      parentKey: undefined,
      linkedKeys: [],
      assigned: false,
      dueDate: undefined,
      estimate: undefined,
      deviations: [],
      requirementIds: [],
      labels: issue.labels,
    },
    classification: "container",
    containerKeys: [],
    overdue: false,
  }));
}

function progressOf(count: number): JiraReport["progress"] {
  return {
    project: {
      total: count,
      new: count,
      indeterminate: 0,
      done: 0,
      noCategory: 0,
      donePercent: 0,
      estimate: { total: 0, done: 0, remaining: 0, unestimated: count },
    },
    byType: [],
    byStatus: [],
    unassigned: count,
    overdue: 0,
  };
}

export interface ReportOptions {
  /** False when the backlog was only partly read. */
  readonly complete?: boolean;
  readonly generatedAt?: string;
  readonly projectKey?: string;
}

function reportOf(
  issues: readonly ReportedIssue[],
  complete: boolean,
  options: ReportOptions,
): JiraReport {
  return {
    digest: "d".repeat(64),
    generatedAt: options.generatedAt ?? "2026-11-01T12:00:00.000Z",
    scope: {
      projectKey: options.projectKey ?? "REQ",
      jql: "",
      estimateUnit: "seconds",
      asOf: "2026-11-01",
      timeZone: "UTC",
    },
    completeness: {
      complete,
      ...(complete ? {} : { reason: "read-failed" as const }),
      issuesRead: issues.length,
      issuesTotal: complete ? issues.length : issues.length + 5,
      pageCount: 1,
    },
    hierarchy: {
      discovery: "complete",
      fieldCount: 1,
      observedFieldCount: 1,
      rejectedFieldCount: 0,
    },
    progress: progressOf(issues.length),
    epics: [],
    compliance: {
      requiredFieldRules: "not-requested",
      checker: "none",
      issuesChecked: 0,
      issuesWithDeviations: 0,
      deviationCount: 0,
      byRule: [],
      deviations: [],
    },
    coverage: {
      containerRoles: "observed",
      uncoveredEpics: [],
      orphans: [],
      requirements: undefined,
    },
    rows: rowsOf(issues),
  };
}

/** Stores a report of the given issues as the tool leaves it once it has read the whole scope. */
export function storeFinishedReport(
  store: JiraReportStore,
  owner: string,
  issues: readonly ReportedIssue[],
  options: ReportOptions = {},
): string {
  const session = store.start(owner, {
    projectKey: options.projectKey ?? "REQ",
    jql: undefined,
    estimateFieldId: undefined,
    asOf: undefined,
    parentFieldIds: [],
    requirementIds: [],
  });
  session.report = reportOf(issues, options.complete ?? true, options);
  session.phase = "finished";
  return session.id;
}

/** Starts a report for the owner that is still being read: no report yet, so no baseline. */
export function storeReadingReport(store: JiraReportStore, owner: string): string {
  const session = store.start(owner, {
    projectKey: "REQ",
    jql: undefined,
    estimateFieldId: undefined,
    asOf: undefined,
    parentFieldIds: [],
    requirementIds: [],
  });
  session.phase = "reading";
  return session.id;
}
