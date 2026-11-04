// The trend ledger (#4210): one Markdown table row per measured run in docs/qa/memoria-viva-lab.md,
// so progress or a plateau is visible at a glance. Raw results stay outside the repository; the row
// carries date, product head, corpus version, model, configuration and the product-arm figures.
import { readFileSync, writeFileSync } from "node:fs";
import { HARD_COUNTERS } from "./score.mjs";

export const LEDGER_START = "<!-- memory-lab-ledger:start -->";
export const LEDGER_END = "<!-- memory-lab-ledger:end -->";
export const LEDGER_HEADER = [
  "| Date | Product head | Corpus | Model | Configuration | Runs | Precision | Recall | Answer accuracy | Abstention | No memory on unrelated | Hard counters |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

function cell(value) {
  return value === null || value === undefined ? "n/a" : String(value);
}

/** The ledger row of a run directory's summary and manifest for the product arm. */
export function ledgerRow(run, date, model) {
  const row = run.summary.byArm.find((entry) => entry.key === "product");
  if (row === undefined) throw new Error("run has no product arm");
  const hard = HARD_COUNTERS.filter((name) => row.counters[name] > 0)
    .map((name) => `${name}=${String(row.counters[name])}`)
    .join(" ");
  const metadata = run.manifest.metadata;
  const corpus = run.manifest.corpusVersion ?? run.manifest.setDigest.slice(0, 12);
  return `| ${date} | ${metadata.productHead.slice(0, 9)} | ${corpus} | ${model} | ${metadata.memoryMode}/${metadata.ceiling}, ${metadata.mode} | ${String(row.runs)} | ${cell(row.precision)} | ${cell(row.recall)} | ${cell(row.answerAccuracy)} | ${cell(row.abstention)} | ${cell(row.noMemoryOnUnrelated)} | ${hard || "0"} |`;
}

/** Appends rows inside the ledger markers of a document; the markers must exist exactly once. */
export function appendLedgerRows(document, rows) {
  const start = document.indexOf(LEDGER_START);
  const end = document.indexOf(LEDGER_END);
  if (start < 0 || end < start) throw new Error("ledger markers not found");
  const inside = document.slice(start + LEDGER_START.length, end).trimEnd();
  const existing = inside.length === 0 ? LEDGER_HEADER.join("\n") : inside.trimStart();
  const table = [existing, ...rows].join("\n");
  return `${document.slice(0, start + LEDGER_START.length)}\n${table}\n${document.slice(end)}`;
}

/** Appends the rows to the document file in place. */
export function appendLedgerFile(path, rows) {
  const document = readFileSync(path, "utf8");
  writeFileSync(path, appendLedgerRows(document, rows));
}
