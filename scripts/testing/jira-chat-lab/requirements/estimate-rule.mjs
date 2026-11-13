// The S10 estimate oracle derives its expectation from NATIVE data by the product's rule (#4369,
// #4356), never from a fixed field name in the truth file. The rule: the board's configured estimation
// field is the figure when at least one issue in scope holds a value in it. When none does and the
// other estimate field (native Original Estimate, or in the reverse case the unique numeric Story
// Points field) holds values, that field is the figure, labelled a fallback, and the configured field
// is reported as unused. When both hold values the configured field is the figure and one line names
// the other field's issue count and sum. When neither holds a value the figure is zero of N.
import { cellsOf, decimalCell, integerCell } from "./answer-cells.mjs";

export const TIME_FIELD = "timeoriginalestimate";
const SECONDS_PER_HOUR = 3600;
const STORY_POINTS_SCHEMA = "com.atlassian.jira.plugin.system.customfieldtypes:float";
export const ESTIMATE_CASES = Object.freeze(["configured", "fallback", "both", "neither"]);

const labelOf = (fieldId) => (fieldId === TIME_FIELD ? "Original Estimate" : "Story Points");
const unitOf = (fieldId) => (fieldId === TIME_FIELD ? "seconds" : "points");
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const holders = (issues, fieldId) =>
  fieldId === undefined ? [] : issues.filter((issue) => Number.isFinite(issue.fields?.[fieldId]));
/** A sum in the unit the report states: hours for seconds, points otherwise. */
const reported = (fieldId, sum) =>
  round6(unitOf(fieldId) === "seconds" ? sum / SECONDS_PER_HOUR : sum);
const sumOf = (rows, fieldId) => rows.reduce((total, issue) => total + issue.fields[fieldId], 0);

/** The unique numeric Story Points field of the instance, by schema; `undefined` when ambiguous. */
export function storyPointsFieldId(fields) {
  const found = (Array.isArray(fields) ? fields : []).filter(
    (field) => field.schema?.custom === STORY_POINTS_SCHEMA && field.name === "Story Points",
  );
  return found.length === 1 ? found[0].id : undefined;
}

/** The estimation field the project's board is configured with, from Jira's own board configuration. */
export async function configuredEstimateField(read, project) {
  const boards = await read(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}`);
  for (const board of boards?.values ?? []) {
    const configuration = await read(`/rest/agile/1.0/board/${board.id}/configuration`);
    const id = configuration?.estimation?.field?.fieldId;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/**
 * The expected figure and statements of a project: which case applies and what is summed. `issues`
 * must carry the configured field and the other estimate field (null when unestimated).
 */
export function deriveEstimate({ issues, configured, storyPoints }) {
  const other = configured === TIME_FIELD ? storyPoints : TIME_FIELD;
  const own = holders(issues, configured);
  const alternative = holders(issues, other);
  if (own.length > 0) {
    return {
      case: alternative.length > 0 ? "both" : "configured",
      figureField: configured,
      configured,
      configuredUnused: false,
      other:
        alternative.length > 0
          ? {
              fieldId: other,
              label: labelOf(other),
              count: alternative.length,
              sum: reported(other, sumOf(alternative, other)),
            }
          : undefined,
    };
  }
  const fallback = alternative.length > 0;
  return {
    case: fallback ? "fallback" : "neither",
    figureField: fallback ? other : configured,
    configured,
    configuredUnused: fallback,
    other: undefined,
  };
}

/** What the figure's field and unit are, for the prompt and the number grader (`progressTruth`). */
export function estimateDescriptor(derived) {
  const fieldId = derived.figureField;
  return { fieldId, writeFieldId: fieldId, unit: unitOf(fieldId), label: labelOf(fieldId) };
}

/** The extra lines the S10 prompt asks for so the rule's statements can be graded. */
export const ESTIMATE_RULE_PROMPT = [
  "QUELLE;<Name des Schätzfeldes>;<KONFIGURIERT|ERSATZ> - genau eine Zeile: aus welchem Feld die Schätzung stammt und ob es das am Board konfigurierte Feld oder ein Ersatz ist.",
  "UNGENUTZT;<Name des konfigurierten Feldes> - nur wenn das am Board konfigurierte Schätzfeld in diesem Projekt von keinem Vorgang genutzt wird; sonst keine solche Zeile.",
  "WEITERES;<Feldname>;<Anzahl Vorgänge>;<Summe> - nur wenn außer dem konfigurierten Feld ein weiteres Schätzfeld Werte trägt; sonst keine solche Zeile. Die Summe ist eine reine Zahl ohne Einheit: in Stunden beim Zeitfeld Originalschätzung, sonst in Punkten.",
];

const normal = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase();
const rowsOf = (answer, token) =>
  String(answer ?? "")
    .split(/\r?\n/u)
    .map((line) => cellsOf(line))
    .filter((cells) => cells !== undefined && normal(cells[0]) === token);

const names = (fieldId) => new Set([normal(labelOf(fieldId)), normal(fieldId)]);

function gradeSource(answer, derived) {
  const rows = rowsOf(answer, "quelle");
  const expected = derived.case === "fallback" ? "ersatz" : "konfiguriert";
  const [row] = rows;
  const ok =
    rows.length === 1 &&
    row.length === 3 &&
    names(derived.figureField).has(normal(row[1])) &&
    normal(row[2]) === expected;
  return {
    ok,
    detail: ok
      ? `source ${labelOf(derived.figureField)} labelled ${expected}`
      : `source line missing or wrong (expected ${labelOf(derived.figureField)}, ${expected})`,
  };
}

function gradeUnused(answer, derived) {
  const rows = rowsOf(answer, "ungenutzt");
  // Where no issue holds any estimate a product may truthfully say the configured field is unused.
  if (derived.case === "neither") {
    const ok =
      rows.length === 0 || (rows.length === 1 && names(derived.configured).has(normal(rows[0][1])));
    return {
      ok,
      detail: ok
        ? "no estimate anywhere; an unused-field statement, if any, names the configured field"
        : "an unused-field statement that does not name the configured field",
    };
  }
  if (!derived.configuredUnused)
    return {
      ok: rows.length === 0,
      detail:
        rows.length === 0
          ? "no unused-field claim, none expected"
          : "claims the configured field is unused, but it holds values",
    };
  const ok = rows.length === 1 && names(derived.configured).has(normal(rows[0][1]));
  return {
    ok,
    detail: ok
      ? "states the configured field is unused"
      : "does not state that the configured field is unused",
  };
}

/** Whether the one WEITERES row names the second field with its exact count and sum. */
function otherRowMatches(row, other) {
  const count = integerCell(row[2] ?? "");
  const sum = decimalCell(row[3] ?? "");
  return (
    names(other.fieldId).has(normal(row[1])) &&
    count === other.count &&
    sum !== undefined &&
    Math.abs(sum - other.sum) < 1e-6
  );
}

function gradeOther(answer, derived) {
  const rows = rowsOf(answer, "weiteres");
  if (derived.other === undefined)
    return {
      ok: rows.length === 0,
      detail:
        rows.length === 0
          ? "no second field claimed, none expected"
          : "claims a second estimate field that holds no values",
    };
  const ok = rows.length === 1 && otherRowMatches(rows[0], derived.other);
  return {
    ok,
    detail: ok
      ? `names ${derived.other.label}: ${derived.other.count} issues`
      : "the second field's count or sum is missing or wrong",
  };
}

/** Grades the three statements of the rule against the derived expectation. */
export function gradeEstimateRule(answer, derived) {
  return {
    source: gradeSource(answer, derived),
    unused: gradeUnused(answer, derived),
    other: gradeOther(answer, derived),
  };
}

/** The obligations the three statements carry in S10. */
export const ESTIMATE_RULE_OBLIGATIONS = Object.freeze({
  source: "estimate-source-labelled",
  unused: "configured-unused-stated",
  other: "other-estimate-field-named",
});
