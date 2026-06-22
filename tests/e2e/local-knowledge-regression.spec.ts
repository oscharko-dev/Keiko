/* eslint-disable max-lines-per-function */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const CORPUS_ROOT =
  process.env.KEIKO_LK_E2E_CORPUS ?? "/Users/oscharko-dev/Keiko-Test-Data/Local-Knowledge-E2E";
const CORPUS_DATA_ROOT = join(CORPUS_ROOT, "fixtures");
const STATE_DIR = process.env.KEIKO_LK_E2E_STATE_DIR ?? join(CORPUS_ROOT, "state");
const DB_PATH = join(STATE_DIR, "ui", "local-knowledge", "default", "capsules.db");
const RUN_LEDGER = join(CORPUS_ROOT, "runs", "local-knowledge-regression.jsonl");
const PASS_COUNT = Number(process.env.KEIKO_LK_REGRESSION_PASSES ?? "5");
const INCLUDE_LARGE_PDF = process.env.KEIKO_LK_INCLUDE_LARGE_PDF !== "0";
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

interface CapsuleListEntry {
  readonly id: string;
  readonly displayName: string;
  readonly lifecycleState: string;
  readonly sourceCount: number;
}

interface CapsuleDetail {
  readonly capsule: CapsuleListEntry;
  readonly health: {
    readonly documentCount: number;
    readonly chunkCount: number;
    readonly vectorCount: number;
    readonly failedDocuments: number;
    readonly skippedDocuments: number;
    readonly unsupportedDocuments: number;
  };
  readonly indexingJobs: readonly {
    readonly status: string;
    readonly totalDocuments: number;
    readonly processedDocuments: number;
    readonly failedDocuments: number;
    readonly skippedDocuments: number;
  }[];
  // Issue #1286: present once a document took the bounded progressive path.
  readonly largeDocumentHealth?: {
    readonly resourcePolicy: { readonly largeFileThresholdBytes: number };
    readonly progress: readonly {
      readonly documentId: string;
      readonly safeDisplayName: string;
      readonly phase: string;
      readonly processedPages: number;
      readonly chunkCount: number;
      readonly embeddedChunkCount: number;
      readonly coverage: string;
      readonly resumable: boolean;
    }[];
    readonly resumableDocuments: readonly string[];
    readonly partialCoverageDocuments: number;
    readonly qualityWarnings: readonly string[];
  };
}

interface CorpusPaths {
  readonly smallFiles: string;
  readonly officeFiles: string;
  readonly pdfSmall: string;
  readonly pdfLarge: string;
  readonly mixedFolder: string;
  readonly refreshCycle: string;
  readonly failureCycle: string;
  readonly oversizePicker: string;
}

function collectPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return () => {
    expect(errors).toEqual([]);
  };
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function copyIfExists(from: string, to: string): boolean {
  if (!existsSync(from)) return false;
  ensureDir(join(to, ".."));
  if (!existsSync(to)) copyFileSync(from, to);
  return true;
}

function writeSmallXlsx(path: string): void {
  if (existsSync(path)) return;
  const script = `
import zipfile
path = ${JSON.stringify(path)}
files = {
  "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>""",
  "_rels/.rels": """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>""",
  "xl/workbook.xml": """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Ledger" sheetId="1" r:id="rId1"/></sheets>
</workbook>""",
  "xl/_rels/workbook.xml.rels": """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>""",
  "xl/worksheets/sheet1.xml": """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Keiko Local Knowledge E2E</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Persistent spreadsheet fixture</t></is></c></row>
  </sheetData>
</worksheet>""",
}
with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as z:
    for name, payload in files.items():
        z.writestr(name, payload)
`;
  execFileSync("python3", ["-c", script], { stdio: "pipe" });
}

function ensureCorpus(): CorpusPaths {
  const paths: CorpusPaths = {
    smallFiles: join(CORPUS_DATA_ROOT, "small-files"),
    officeFiles: join(CORPUS_DATA_ROOT, "office-files"),
    pdfSmall: join(CORPUS_DATA_ROOT, "pdf-small"),
    pdfLarge: join(CORPUS_DATA_ROOT, "pdf-large"),
    mixedFolder: join(CORPUS_DATA_ROOT, "mixed-folder"),
    refreshCycle: join(CORPUS_DATA_ROOT, "refresh-cycle"),
    failureCycle: join(CORPUS_DATA_ROOT, "failure-cycle"),
    oversizePicker: join(CORPUS_DATA_ROOT, "oversize-picker"),
  };
  ensureDir(CORPUS_DATA_ROOT);
  Object.values(paths).forEach(ensureDir);
  ensureDir(join(CORPUS_ROOT, "runs"));
  ensureDir(join(paths.mixedFolder, "nested"));
  for (const entry of readdirSync(paths.refreshCycle)) {
    if (entry.startsWith("added-pass-")) {
      rmSync(join(paths.refreshCycle, entry), { force: true });
    }
  }

  writeFileSync(
    join(paths.smallFiles, "readme.md"),
    "# Local Knowledge E2E\n\nSmall markdown fixture.\n",
    "utf8",
  );
  writeFileSync(join(paths.smallFiles, "notes.txt"), "plain text fixture for indexing\n", "utf8");
  writeFileSync(
    join(paths.smallFiles, "data.json"),
    JSON.stringify({ fixture: true, count: 3 }, null, 2),
    "utf8",
  );
  writeFileSync(join(paths.smallFiles, "records.csv"), "id,name\n1,alpha\n2,beta\n", "utf8");
  writeFileSync(
    join(paths.smallFiles, "page.html"),
    "<h1>HTML fixture</h1><p>Knowledge text.</p>\n",
    "utf8",
  );

  writeFileSync(
    join(paths.mixedFolder, "nested", "nested.md"),
    "# Nested\n\nNested supported fixture.\n",
    "utf8",
  );
  writeFileSync(
    join(paths.mixedFolder, "unsupported.bin"),
    "not a supported document format\n",
    "utf8",
  );
  writeFileSync(
    join(paths.refreshCycle, "source.md"),
    "# Refresh cycle\n\nInitial content.\n",
    "utf8",
  );
  writeFileSync(
    join(paths.refreshCycle, "deleted-before-refresh.md"),
    "This file is deleted during refresh tests.\n",
    "utf8",
  );
  writeFileSync(
    join(paths.failureCycle, "broken.pdf"),
    "%PDF-1.7\nbroken local knowledge fixture\n",
    "utf8",
  );
  writeFileSync(
    join(paths.oversizePicker, "tiny.md"),
    "# Tiny\n\nPicker control fixture.\n",
    "utf8",
  );

  copyIfExists(
    "/Users/oscharko-dev/Keiko-Test-Data/BlogArticle/NeuroAI.docx",
    join(paths.officeFiles, "neuroai.docx"),
  );
  writeSmallXlsx(join(paths.officeFiles, "ledger.xlsx"));
  copyIfExists(
    "/Users/oscharko-dev/Keiko-Test-Data/AI-Foundry/test-data/Ratgeber_Krankenversicherung.pdf",
    join(paths.pdfSmall, "small-text-layer.pdf"),
  );
  copyIfExists(
    "/Users/oscharko-dev/Keiko-Test-Data/AI-Foundry/img/Was ist Foundry Agent Service.png",
    join(paths.mixedFolder, "foundry-agent-service.png"),
  );
  copyIfExists(
    "/Users/oscharko-dev/Keiko-Test-Data/AI-Foundry/azure-landing-zone-architecture-diagram-hub-spoke.svg",
    join(paths.mixedFolder, "architecture.svg"),
  );
  copyIfExists(
    "/Users/oscharko-dev/Keiko-Test-Data/AI-Foundry/links/Microsoft Foundry.webloc",
    join(paths.mixedFolder, "microsoft-foundry.webloc"),
  );
  copyIfExists(
    "/Users/oscharko-dev/Keiko-Test-Data/AI-Foundry/microsoft-foundry.pdf",
    join(paths.pdfLarge, "microsoft-foundry.pdf"),
  );

  const oversizeFile = join(paths.oversizePicker, "too-large.pdf");
  if (!existsSync(oversizeFile) || statSync(oversizeFile).size <= MAX_FILE_BYTES) {
    writeFileSync(oversizeFile, "%PDF-1.7\nsparse picker limit fixture\n", "utf8");
    truncateSync(oversizeFile, MAX_FILE_BYTES + 1);
  }

  return paths;
}

function resetMutableCorpus(paths: CorpusPaths): void {
  for (const entry of readdirSync(paths.refreshCycle)) {
    if (entry.startsWith("added-pass-")) {
      rmSync(join(paths.refreshCycle, entry), { force: true });
    }
  }
  writeFileSync(
    join(paths.refreshCycle, "source.md"),
    "# Refresh cycle\n\nInitial content.\n",
    "utf8",
  );
  writeFileSync(
    join(paths.refreshCycle, "deleted-before-refresh.md"),
    "This file is deleted during refresh tests.\n",
    "utf8",
  );
  writeFileSync(
    join(paths.failureCycle, "broken.pdf"),
    "%PDF-1.7\nbroken local knowledge fixture\n",
    "utf8",
  );
}

function resetLocalKnowledgeDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_PATH}${suffix}`, { force: true });
  }
}

function sqlScalar(sql: string): number {
  const output = execFileSync("sqlite3", [DB_PATH, sql], { encoding: "utf8" }).trim();
  return Number(output);
}

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function countRows(table: string, capsuleId?: string): number {
  const where = capsuleId === undefined ? "" : ` WHERE capsule_id = ${sqlQuote(capsuleId)}`;
  return sqlScalar(`SELECT COUNT(*) FROM ${table}${where};`);
}

function markFirstLargeDocumentCheckpointResumable(capsuleId: string): void {
  const now = Date.now();
  const diagnostics = JSON.stringify([
    {
      code: "E2E_INTERRUPTED",
      message: "E2E checkpoint interruption for Resume control coverage",
    },
  ]);
  execFileSync("sqlite3", [
    DB_PATH,
    `UPDATE extraction_checkpoints
       SET phase = 'cancelled',
           updated_at = ${now.toString()},
           terminal_diagnostics_json = ${sqlQuote(diagnostics)}
       WHERE capsule_id = ${sqlQuote(capsuleId)}
         AND document_id = (
           SELECT document_id
             FROM extraction_checkpoints
            WHERE capsule_id = ${sqlQuote(capsuleId)}
            ORDER BY document_id
            LIMIT 1
         );`,
  ]);
  expect(
    sqlScalar(
      `SELECT COUNT(*) FROM extraction_checkpoints WHERE capsule_id = ${sqlQuote(
        capsuleId,
      )} AND phase = 'cancelled';`,
    ),
  ).toBeGreaterThan(0);
}

function assertNoRowsForCapsule(capsuleId: string): void {
  for (const table of [
    "capsule_sources",
    "documents",
    "document_texts",
    "document_text_windows",
    "extraction_checkpoints",
    "chunks",
    "vectors",
    "parser_diagnostics",
    "indexing_jobs",
    "capsule_set_members",
  ]) {
    expect(countRows(table, capsuleId), `${table} should be empty after delete`).toBe(0);
  }
}

function appendLedger(entry: Record<string, unknown>): void {
  appendFileSync(
    RUN_LEDGER,
    `${JSON.stringify({ ...entry, recordedAt: new Date().toISOString() })}\n`,
    "utf8",
  );
}

async function apiJson<T>(
  request: APIRequestContext,
  method: "get" | "post" | "patch" | "delete",
  path: string,
  data?: unknown,
  expectedStatus?: number,
): Promise<T> {
  const options = {
    data,
    timeout: 30 * 60_000,
    ...(method === "get" ? {} : { headers: MUTATION_HEADERS }),
  };
  const response = await request[method](path, options);
  if (expectedStatus !== undefined) {
    expect(response.status(), await response.text()).toBe(expectedStatus);
  } else {
    expect(response.ok(), await response.text()).toBe(true);
  }
  if (response.status() === 204) return undefined as T;
  return (await response.json()) as T;
}

async function ensureProject(request: APIRequestContext): Promise<void> {
  await apiJson(request, "post", "/api/projects", {
    path: CORPUS_DATA_ROOT,
    name: "Local Knowledge E2E",
  });
}

async function createCapsule(request: APIRequestContext, displayName: string): Promise<string> {
  const body = await apiJson<{ capsule: { id: string } }>(
    request,
    "post",
    "/api/local-knowledge/capsules",
    { displayName },
    201,
  );
  return body.capsule.id;
}

async function connectFolder(
  request: APIRequestContext,
  capsuleId: string,
  rootPath: string,
): Promise<void> {
  await apiJson(
    request,
    "post",
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/connection`,
    { scope: { kind: "folder", rootPath, recursive: true }, displayName: basename(rootPath) },
    201,
  );
}

async function connectFiles(
  request: APIRequestContext,
  capsuleId: string,
  rootPath: string,
  files: readonly string[],
): Promise<void> {
  await apiJson(
    request,
    "post",
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/connection`,
    { scope: { kind: "files", rootPath, files }, displayName: files.join(", ") },
    201,
  );
}

async function connectRepository(
  request: APIRequestContext,
  capsuleId: string,
  repositoryRoot: string,
): Promise<void> {
  await apiJson(
    request,
    "post",
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/connection`,
    { scope: { kind: "repository", repositoryRoot }, displayName: basename(repositoryRoot) },
    201,
  );
}

async function detail(request: APIRequestContext, capsuleId: string): Promise<CapsuleDetail> {
  return apiJson<CapsuleDetail>(
    request,
    "get",
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}`,
  );
}

async function indexCapsule(
  request: APIRequestContext,
  capsuleId: string,
  expectedStatus = 200,
): Promise<void> {
  await apiJson(
    request,
    "post",
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/index`,
    { confirm: true },
    expectedStatus,
  );
}

async function reindexCapsule(
  request: APIRequestContext,
  capsuleId: string,
  mode: "changed-files" | "repair-failed",
): Promise<void> {
  await apiJson(
    request,
    "post",
    `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}/reindex`,
    { capsuleId, mode },
    200,
  );
}

async function expectIndexed(
  request: APIRequestContext,
  capsuleId: string,
): Promise<CapsuleDetail> {
  const current = await detail(request, capsuleId);
  expect(current.capsule.lifecycleState).toBe("ready");
  expect(current.health.documentCount).toBeGreaterThan(0);
  expect(current.health.chunkCount).toBeGreaterThan(0);
  expect(current.health.vectorCount).toBe(current.health.chunkCount);
  expect(countRows("documents", capsuleId)).toBe(current.health.documentCount);
  expect(countRows("chunks", capsuleId)).toBe(current.health.chunkCount);
  expect(countRows("vectors", capsuleId)).toBe(current.health.vectorCount);
  return current;
}

async function assertSmallPdfLargeDocumentEvidence(
  request: APIRequestContext,
  page: Page,
  smallPdfDetail: CapsuleDetail,
  smallPdfId: string,
): Promise<void> {
  expect(smallPdfDetail.largeDocumentHealth).toBeDefined();
  expect(smallPdfDetail.largeDocumentHealth?.progress.length ?? 0).toBeGreaterThan(0);
  expect(smallPdfDetail.largeDocumentHealth?.resourcePolicy.largeFileThresholdBytes).toBe(1024);
  const pdfProgress = smallPdfDetail.largeDocumentHealth?.progress.find((progress) =>
    progress.safeDisplayName.includes("small-text-layer.pdf"),
  );
  expect(pdfProgress).toBeDefined();
  if (pdfProgress === undefined) throw new Error("Missing large-document progress row");
  expect(pdfProgress.phase).toBe("complete");
  expect(pdfProgress.processedPages).toBeGreaterThan(0);
  expect(pdfProgress.chunkCount).toBeGreaterThan(0);
  expect(pdfProgress.embeddedChunkCount).toBe(pdfProgress.chunkCount);
  expect(pdfProgress.coverage).toBe("partial");
  expect(smallPdfDetail.largeDocumentHealth?.partialCoverageDocuments).toBeGreaterThan(0);
  expect(smallPdfDetail.largeDocumentHealth?.qualityWarnings.join("\n")).toContain(
    "multimodal capability",
  );
  expect(countRows("document_text_windows", smallPdfId)).toBeGreaterThan(0);
  expect(countRows("extraction_checkpoints", smallPdfId)).toBeGreaterThan(0);
  await page.goto(`/local-knowledge/capsule?capsuleId=${encodeURIComponent(smallPdfId)}`);
  const largeDocuments = page.getByRole("region", { name: "Large documents" });
  await expect(largeDocuments.getByRole("heading", { name: "Large documents" })).toBeVisible();
  await expect(largeDocuments.getByRole("status")).toHaveText("Idle");
  await expect(largeDocuments.getByText("small-text-layer.pdf")).toBeVisible();
  await expect(largeDocuments.getByText("Complete")).toBeVisible();
  await expect(largeDocuments.getByText("partial coverage", { exact: true })).toBeVisible();
  await expect(
    largeDocuments.getByText(
      `${pdfProgress.processedPages.toString()} pages · ${pdfProgress.embeddedChunkCount.toString()}/${pdfProgress.chunkCount.toString()} chunks embedded`,
    ),
  ).toBeVisible();
  await expect(
    largeDocuments.getByText(/^1 document indexed with partial coverage/u),
  ).toBeVisible();
  await expect(largeDocuments.getByText(/multimodal capability/u)).toBeVisible();
  await assertLargeDocumentResumeControl(request, page, largeDocuments, smallPdfId);
}

async function assertLargeDocumentResumeControl(
  request: APIRequestContext,
  page: Page,
  largeDocuments: ReturnType<Page["getByRole"]>,
  smallPdfId: string,
): Promise<void> {
  markFirstLargeDocumentCheckpointResumable(smallPdfId);
  const interruptedDetail = await detail(request, smallPdfId);
  const interruptedProgress = interruptedDetail.largeDocumentHealth?.progress.find((progress) =>
    progress.safeDisplayName.includes("small-text-layer.pdf"),
  );
  expect(interruptedProgress).toBeDefined();
  expect(interruptedProgress?.phase).toBe("cancelled");
  expect(interruptedProgress?.resumable).toBe(true);
  expect(interruptedDetail.largeDocumentHealth?.resumableDocuments.length ?? 0).toBeGreaterThan(0);
  await page.goto(`/local-knowledge/capsule?capsuleId=${encodeURIComponent(smallPdfId)}`);
  await expect(largeDocuments.getByText("Cancelled")).toBeVisible();
  await expect(largeDocuments.getByText(/resumable/u)).toBeVisible();
  await expect(
    largeDocuments.getByRole("button", {
      name: "Resume interrupted large-document indexing",
    }),
  ).toBeVisible();
}

async function openLocalKnowledge(page: Page): Promise<void> {
  await page.goto("/");
  if ((await page.getByRole("heading", { name: "Local Knowledge Connector" }).count()) === 0) {
    await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "Local Knowledge Connector" })).toBeVisible();
}

async function resetWorkspaceState(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.removeItem("keiko.workspace.v4");
    window.localStorage.removeItem("keiko.conns.v1");
  });
}

async function uiCreateCapsule(page: Page, displayName: string): Promise<void> {
  await page.getByRole("button", { name: "Create a new knowledge capsule" }).click();
  await page.getByRole("button", { name: "Create capsule", exact: true }).click();
  await expect(page.getByText("Capsule display name is required.")).toBeVisible();
  await page.getByLabel("Capsule display name").fill(displayName);
  await page.getByRole("button", { name: "Create capsule", exact: true }).click();
  await expect(page.getByRole("article", { name: `Capsule: ${displayName}` })).toBeVisible();
}

async function uiRenameCapsule(page: Page, fromName: string, toName: string): Promise<void> {
  await page.getByRole("button", { name: `Open details for capsule ${fromName}` }).click();
  await expect(page.getByRole("heading", { name: fromName })).toBeVisible();
  await page.getByRole("button", { name: `Rename capsule ${fromName}` }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: fromName })).toBeVisible();
  await page.getByRole("button", { name: `Rename capsule ${fromName}` }).click();
  const input = page.getByLabel("Capsule display name");
  await input.fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Display name is required.")).toBeVisible();
  await input.fill(toName);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: toName })).toBeVisible();
  await page.getByRole("button", { name: "Back to capsules" }).click();
  await expect(page.getByRole("article", { name: `Capsule: ${toName}` })).toBeVisible();
}

async function uiExercisePicker(page: Page, capsuleName: string): Promise<void> {
  await page.getByRole("button", { name: `Open details for capsule ${capsuleName}` }).click();
  await page.getByRole("combobox", { name: "Connect source" }).selectOption("files");
  await page.getByRole("button", { name: "Browse" }).click();
  const picker = page.getByRole("dialog", { name: "Choose local source" });
  await expect(picker).toBeVisible();
  await expect(picker.getByText("Maximum single file size: 1.0 GB")).toBeVisible();
  await page.getByRole("button", { name: "Local Knowledge E2E" }).click();
  await page.getByRole("button", { name: "oversize-picker" }).click();
  await expect(page.getByText("too-large.pdf")).toBeVisible();
  await expect(page.getByLabel(/too-large\.pdf/u)).toBeDisabled();
  await page.getByRole("button", { name: "Up" }).click();
  await page.getByRole("button", { name: "small-files" }).click();
  await page.getByLabel("readme.md").check();
  await page.getByLabel("notes.txt").check();
  await page.getByRole("button", { name: "Use selection" }).click();
  await expect(page.getByRole("combobox", { name: "Connect source" })).toHaveValue("files");
  await expect(page.getByLabel("Absolute root path for the selected files")).toHaveValue(
    CORPUS_DATA_ROOT,
  );
  await expect(page.getByLabel("Relative files to connect")).toHaveValue(
    /small-files\/readme\.md/u,
  );
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Index this capsule now" })).toBeVisible();
  await page.getByRole("button", { name: "Back to capsules" }).click();
}

async function uiDeleteCapsule(page: Page, displayName: string): Promise<void> {
  await page.getByRole("button", { name: `Open details for capsule ${displayName}` }).click();
  await page.getByRole("button", { name: `Delete capsule ${displayName}` }).click();
  await expect(page.getByRole("dialog", { name: "Delete capsule" })).toBeVisible();
  await page.getByLabel("Type the capsule name to confirm").fill("wrong name");
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await page.getByLabel("Type the capsule name to confirm").fill(displayName);
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: displayName })).toBeVisible();
  await page.getByRole("button", { name: `Delete capsule ${displayName}` }).click();
  await page.getByLabel("Type the capsule name to confirm").fill(displayName);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Local Knowledge Connector" })).toBeVisible();
  await expect(page.getByRole("article", { name: `Capsule: ${displayName}` })).toHaveCount(0);
}

async function uiCombineCapsules(
  page: Page,
  setName: string,
  firstCapsuleName: string,
  secondCapsuleName: string,
): Promise<void> {
  await expect(page.getByRole("article", { name: `Capsule: ${firstCapsuleName}` })).toBeVisible();
  await expect(page.getByRole("article", { name: `Capsule: ${secondCapsuleName}` })).toBeVisible();
  const combineButton = page.getByRole("button", { name: "Combine capsules into a set" });
  await expect(combineButton).toHaveAttribute("aria-disabled", "false");
  await combineButton.click();
  const dialog = page.getByRole("dialog", { name: "Combine capsules into a set" });
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "Combine", exact: true }).click();
  await expect(page.getByText("Set name is required.")).toBeVisible();
  await page.getByLabel("Set name").fill(setName);
  await page.getByRole("button", { name: "Combine", exact: true }).click();
  await expect(page.getByText("Select at least one capsule to combine.")).toBeVisible();
  await dialog
    .getByRole("checkbox", { name: new RegExp(`^${escapeRegex(firstCapsuleName)}\\b`, "u") })
    .check();
  await dialog
    .getByRole("checkbox", { name: new RegExp(`^${escapeRegex(secondCapsuleName)}\\b`, "u") })
    .check();
  await page.getByRole("button", { name: "Combine", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Combine capsules into a set" })).toHaveCount(0);
}

async function uiAddAndDragPayload(page: Page, capsuleName: string): Promise<void> {
  await page.getByRole("button", { name: `Add capsule ${capsuleName} to workspace` }).click();
  await page.waitForTimeout(250);
  const payload = await page
    .getByRole("button", { name: `Drag capsule ${capsuleName} to workspace` })
    .evaluate((node) => {
      const event = new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      });
      node.dispatchEvent(event);
      return event.dataTransfer?.getData("application/x-keiko-local-knowledge-connector") ?? "";
    });
  expect(payload).toContain(capsuleName);
}

async function runRegressionPass(
  pass: number,
  page: Page,
  request: APIRequestContext,
  corpus: CorpusPaths,
): Promise<void> {
  const passLabel = String(pass);
  resetMutableCorpus(corpus);
  resetLocalKnowledgeDb();
  await ensureProject(request);
  await resetWorkspaceState(page);
  await openLocalKnowledge(page);
  await expect(page.locator(".lk-pipeline")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Combine capsules into a set" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  const uiCapsule = `E2E Pass ${passLabel} UI`;
  const renamedUiCapsule = `E2E Pass ${passLabel} UI Renamed`;
  await uiCreateCapsule(page, uiCapsule);
  await uiRenameCapsule(page, uiCapsule, renamedUiCapsule);
  await uiExercisePicker(page, renamedUiCapsule);

  const listAfterPicker = await apiJson<{ capsules: readonly CapsuleListEntry[] }>(
    request,
    "get",
    "/api/local-knowledge/capsules",
  );
  const pickedCapsule = listAfterPicker.capsules.find(
    (capsule) => capsule.displayName === renamedUiCapsule,
  );
  expect(pickedCapsule).toBeDefined();
  if (pickedCapsule === undefined) throw new Error(`Missing capsule ${renamedUiCapsule}`);
  await indexCapsule(request, pickedCapsule.id);
  await expectIndexed(request, pickedCapsule.id);

  const smallId = await createCapsule(request, `E2E Pass ${passLabel} Small Files`);
  await connectFolder(request, smallId, corpus.smallFiles);
  await indexCapsule(request, smallId);
  await expectIndexed(request, smallId);

  const officeId = await createCapsule(request, `E2E Pass ${passLabel} Office Files`);
  await connectFolder(request, officeId, corpus.officeFiles);
  await indexCapsule(request, officeId);
  await expectIndexed(request, officeId);

  const repositoryId = await createCapsule(request, `E2E Pass ${passLabel} Repository`);
  await connectRepository(request, repositoryId, corpus.smallFiles);
  await indexCapsule(request, repositoryId);
  await expectIndexed(request, repositoryId);

  const mixedId = await createCapsule(request, `E2E Pass ${passLabel} Mixed Folder`);
  await connectFolder(request, mixedId, corpus.mixedFolder);
  await indexCapsule(request, mixedId);
  const mixedDetail = await expectIndexed(request, mixedId);
  expect(
    mixedDetail.health.skippedDocuments + mixedDetail.health.unsupportedDocuments,
  ).toBeGreaterThan(0);

  const smallPdfId = await createCapsule(request, `E2E Pass ${passLabel} Small PDF`);
  await connectFolder(request, smallPdfId, corpus.pdfSmall);
  await indexCapsule(request, smallPdfId);
  const smallPdfDetail = await expectIndexed(request, smallPdfId);
  // Issue #1286: with the lowered threshold the PDF took the bounded progressive path, so the BFF
  // surfaces large-document health with per-document progress, and the detail UI renders the
  // "Large documents" section + a progress row.
  await assertSmallPdfLargeDocumentEvidence(request, page, smallPdfDetail, smallPdfId);

  let largePdfId: string | null = null;
  if (INCLUDE_LARGE_PDF && existsSync(join(corpus.pdfLarge, "microsoft-foundry.pdf"))) {
    largePdfId = await createCapsule(request, `E2E Pass ${passLabel} Large PDF`);
    await connectFiles(request, largePdfId, corpus.pdfLarge, ["microsoft-foundry.pdf"]);
    await indexCapsule(request, largePdfId);
    await expectIndexed(request, largePdfId);
  }

  const refreshId = await createCapsule(request, `E2E Pass ${passLabel} Refresh`);
  await connectFolder(request, refreshId, corpus.refreshCycle);
  await indexCapsule(request, refreshId);
  const beforeRefresh = await expectIndexed(request, refreshId);
  writeFileSync(
    join(corpus.refreshCycle, "source.md"),
    `# Refresh cycle\n\nUpdated during pass ${passLabel}.\n`,
    "utf8",
  );
  writeFileSync(
    join(corpus.refreshCycle, `added-pass-${passLabel}.md`),
    `# Added pass ${passLabel}\n`,
    "utf8",
  );
  rmSync(join(corpus.refreshCycle, "deleted-before-refresh.md"), { force: true });
  await reindexCapsule(request, refreshId, "changed-files");
  const afterRefresh = await expectIndexed(request, refreshId);
  expect(afterRefresh.health.documentCount).toBeGreaterThanOrEqual(
    beforeRefresh.health.documentCount,
  );

  const failureId = await createCapsule(request, `E2E Pass ${passLabel} Repair`);
  await connectFolder(request, failureId, corpus.failureCycle);
  await indexCapsule(request, failureId, 409);
  expect(countRows("indexing_jobs", failureId)).toBeGreaterThan(0);
  copyFileSync(
    join(corpus.pdfSmall, "small-text-layer.pdf"),
    join(corpus.failureCycle, "broken.pdf"),
  );
  await reindexCapsule(request, failureId, "repair-failed");
  await expectIndexed(request, failureId);

  await openLocalKnowledge(page);
  await expect(page.getByRole("article", { name: `Capsule: ${renamedUiCapsule}` })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Local Knowledge Connector" })).toBeVisible();
  await expect(page.getByRole("article", { name: `Capsule: ${renamedUiCapsule}` })).toBeVisible();
  await uiCombineCapsules(
    page,
    `E2E Pass ${passLabel} Set`,
    renamedUiCapsule,
    `E2E Pass ${passLabel} Small Files`,
  );
  const sets = await apiJson<{
    capsuleSets: readonly { capsuleCount: number; displayName: string }[];
  }>(request, "get", "/api/local-knowledge/capsule-sets");
  expect(sets.capsuleSets).toContainEqual(
    expect.objectContaining({ displayName: `E2E Pass ${passLabel} Set`, capsuleCount: 2 }),
  );

  await uiAddAndDragPayload(page, renamedUiCapsule);

  const disconnectId = await createCapsule(request, `E2E Pass ${passLabel} Disconnect`);
  await connectFolder(request, disconnectId, corpus.smallFiles);
  await openLocalKnowledge(page);
  await page
    .getByRole("button", { name: `Disconnect capsule E2E Pass ${passLabel} Disconnect` })
    .click();
  await expect(page.getByRole("dialog", { name: "Disconnect capsule" })).toBeVisible();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect
    .poll(() => countRows("capsule_sources", disconnectId), {
      timeout: 10_000,
    })
    .toBe(0);
  expect(existsSync(join(corpus.smallFiles, "readme.md"))).toBe(true);

  await openLocalKnowledge(page);
  await uiDeleteCapsule(page, renamedUiCapsule);
  assertNoRowsForCapsule(pickedCapsule.id);
  expect(existsSync(join(corpus.smallFiles, "readme.md"))).toBe(true);

  const tableCounts = Object.fromEntries(
    [
      "capsules",
      "capsule_sources",
      "knowledge_sources",
      "documents",
      "document_texts",
      "chunks",
      "vectors",
      "parser_diagnostics",
      "indexing_jobs",
      "capsule_set_members",
    ].map((table) => [table, countRows(table)]),
  );
  appendLedger({
    pass,
    corpusRoot: CORPUS_ROOT,
    corpusDataRoot: CORPUS_DATA_ROOT,
    dbPath: DB_PATH,
    includeLargePdf: INCLUDE_LARGE_PDF,
    largePdfId,
    tableCounts,
  });
}

test.describe.serial("Local Knowledge full regression campaign", () => {
  let corpus: CorpusPaths;

  test.beforeAll(() => {
    corpus = ensureCorpus();
    resetLocalKnowledgeDb();
    appendLedger({
      event: "setup",
      corpusRoot: CORPUS_ROOT,
      corpusDataRoot: CORPUS_DATA_ROOT,
      stateDir: STATE_DIR,
      passCount: PASS_COUNT,
      includeLargePdf: INCLUDE_LARGE_PDF,
      files: readdirSync(CORPUS_ROOT).sort(),
    });
  });

  test("runs the persistent Local Knowledge regression plan", async ({ page, request }) => {
    test.setTimeout(Math.max(90 * 60_000, PASS_COUNT * 25 * 60_000));
    const assertNoPageErrors = collectPageErrors(page);
    const health = await request.get("/api/health");
    expect(health.ok()).toBe(true);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });
    expect(existsSync(join(corpus.pdfSmall, "small-text-layer.pdf"))).toBe(true);
    if (INCLUDE_LARGE_PDF) {
      expect(existsSync(join(corpus.pdfLarge, "microsoft-foundry.pdf"))).toBe(true);
    }

    for (let pass = 1; pass <= PASS_COUNT; pass += 1) {
      await test.step(`full regression pass ${String(pass)}`, async () => {
        await runRegressionPass(pass, page, request, corpus);
      });
    }

    appendLedger({
      event: "complete",
      passes: PASS_COUNT,
      corpusRoot: CORPUS_ROOT,
      corpusDataRoot: CORPUS_DATA_ROOT,
      dbPath: DB_PATH,
    });
    assertNoPageErrors();
  });
});
