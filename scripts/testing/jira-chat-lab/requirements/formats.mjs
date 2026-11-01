// S03 of epic #4173 (#4180): every project document format is usable. The specification is put
// into the Knowledge Pod in one format at a time (Word, Excel, PowerPoint, PDF) and the product's
// own `knowledge.requirements` result is compared with the generated ground truth. The structured
// tool result is the evidence; the model's prose is never read.
import { buildCorpus } from "./corpus.mjs";
import { aggregateParts, sequentially } from "./journey-support.mjs";
import { completedToolExchange } from "./tool-exchanges.mjs";

/** The formats of the catalog, each with the obligation it demonstrates and its file extension. */
export const FORMATS = Object.freeze([
  { format: "docx", extension: ".docx", obligation: "format-docx", label: "Word" },
  { format: "xlsx", extension: ".xlsx", obligation: "format-xlsx", label: "Excel" },
  { format: "pptx", extension: ".pptx", obligation: "format-pptx", label: "PowerPoint" },
  { format: "pdf", extension: ".pdf", obligation: "format-pdf", label: "PDF" },
]);

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value) => Array.isArray(value) && value.length > 0;

/** A read that narrows the inventory (ids, query, priorities, documents) is not the full list. */
const isUnfiltered = (args) =>
  !isRecord(args) ||
  !["ids", "query", "priorities", "documents"].some((name) => {
    const value = args[name];
    return typeof value === "string" ? value !== "" : nonEmpty(value);
  });

/** The completed units pages of the turn that read the whole inventory (no filter, units view). */
function unfilteredPages(exchanges) {
  return (Array.isArray(exchanges) ? exchanges : [])
    .filter((exchange) => completedToolExchange(exchange, "knowledge.requirements"))
    .filter((exchange) => isUnfiltered(exchange.call?.arguments))
    .map((exchange) => exchange.result.data)
    .filter((data) => isRecord(data) && data.outcome === "succeeded" && data.view === "units");
}

const hasName = (item, extension) =>
  typeof item.documentName === "string" && item.documentName.toLowerCase().endsWith(extension);

/**
 * Grades one format from the turn's tool exchanges. `green`: the unfiltered, fully paged result
 * lists every requirement of the truth exactly from a document of that format and invents none.
 * `unverified`: no complete unfiltered read of the inventory, so the product was not shown to have
 * been asked for the whole list (a filtered read or an unfinished paging proves nothing).
 */
export function gradeFormatInventory({ exchanges, truth, extension }) {
  const pages = unfilteredPages(exchanges);
  if (pages.length === 0) {
    return { status: "unverified", detail: "no completed unfiltered knowledge.requirements read" };
  }
  if (pages.every((page) => typeof page.nextCursor === "string")) {
    return {
      status: "unverified",
      detail: "the paging of the inventory was not followed to its end",
    };
  }
  const items = pages
    .flatMap((page) => (Array.isArray(page.items) ? page.items : []))
    .filter((item) => isRecord(item) && hasName(item, extension));
  const explicit = items.filter(
    (item) => item.idOrigin === "explicit" && typeof item.id === "string",
  );
  const found = new Set(explicit.map((item) => item.id));
  const known = new Set(truth.map((item) => item.id));
  const missing = truth.filter((item) => !found.has(item.id)).map((item) => item.id);
  const invented = [...found].filter((id) => !known.has(id));
  const totals = pages.at(-1).totals;
  const notExtracted = isRecord(totals) ? totals.documentsNotExtracted : undefined;
  const titles = truth.filter((item) =>
    explicit.some(
      (entry) =>
        entry.id === item.id &&
        String(entry.title ?? "")
          .toLowerCase()
          .includes(item.title.toLowerCase()),
    ),
  ).length;
  const detail =
    `${found.size - invented.length}/${truth.length} requirements from ${extension} documents` +
    `, ${missing.length} missing, ${invented.length} invented, ${items.length - explicit.length} derived units` +
    `, ${titles} titles verbatim, ${notExtracted ?? "?"} documents not text-extracted`;
  const ok = items.length > 0 && missing.length === 0 && invented.length === 0;
  return { status: ok ? "green" : "red", detail };
}

const FORMAT_PROMPT = (label) =>
  `Das Lastenheft liegt im Wissens-Pod als ${label}-Dokument vor. Lies mit dem Anforderungswerkzeug ALLE Anforderungen vollständig aus (blättere bis zur letzten Seite, ohne Filter) und liste je Zeile ID, Titel und Priorität auf.`;

/** One format: the Pod holds the specification in that format only, a fresh Chat reads it. */
async function formatTurn(ctx, entry, truth) {
  await ctx.useSpecificationFormat(entry.format);
  const chat = await ctx.freshChat("autonomous-delivery");
  const turn = await ctx.turn(chat, FORMAT_PROMPT(entry.label));
  const grade = gradeFormatInventory({
    exchanges: turn.toolExchanges,
    truth,
    extension: entry.extension,
  });
  return { turn, part: { ...grade, label: entry.label, covers: [entry.obligation] } };
}

/** S03 journey: the Pod is restored to the Markdown specification whatever the formats did. */
export async function everyFormatUsable(ctx) {
  const truth = buildCorpus(1).truth;
  const runs = await sequentially(FORMATS, (entry) => formatTurn(ctx, entry, truth)).finally(() =>
    ctx.replaceSpecification(1),
  );
  return aggregateParts(
    runs.map((run) => run.part),
    runs.map((run) => run.turn),
  );
}
