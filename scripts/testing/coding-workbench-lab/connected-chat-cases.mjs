// Customer prompts for the actual connected-chat lab; these are questions, never model outputs.
import { INCIDENT_FEATURE_PATH, INCIDENT_RETRIEVAL_CASES } from "../../check-retrieval-quality.mjs";
import { importBuilt, UsageError } from "./lab-common.mjs";

export const CONNECTED_CHAT_CAMPAIGNS = Object.freeze({
  customer: [
    {
      id: "customer-trace-de",
      question: INCIDENT_RETRIEVAL_CASES.find(
        (row) => row.id === "vitest-stack-trace-node-modules-de",
      ).query,
      target: INCIDENT_FEATURE_PATH,
    },
    {
      id: "customer-follow-up-de",
      question: "Siehst du die Datei jetzt?",
      target: INCIDENT_FEATURE_PATH,
    },
    {
      id: "customer-explicit-de",
      question: `Welche Felder sind in ${INCIDENT_FEATURE_PATH} erforderlich?`,
      target: INCIDENT_FEATURE_PATH,
    },
    {
      id: "customer-basename-de",
      question: "Welche Felder sind in validation.ts der feature conditions erforderlich?",
      target: INCIDENT_FEATURE_PATH,
    },
    {
      id: "customer-orientation-en",
      question:
        "Can you see the repository around this file? Explain the related validation modules briefly with citations.",
      target: INCIDENT_FEATURE_PATH,
    },
  ],
  knowledge: [
    {
      id: "keiko-source-pipeline",
      question:
        "Trace a connected-folder question from POST /api/chats/messages/grounded through scope admission, recursive candidate discovery and prompt fitting. Cite implementation files and lines. Keep the answer under 200 words.",
    },
    {
      id: "keiko-source-budget",
      question:
        "Explain packages/keiko-server/src/grounded-orchestrator.ts and how it preserves the original read, token and elapsed budgets. Cite implementation lines. Keep the answer under 200 words.",
      target: "packages/keiko-server/src/grounded-orchestrator.ts",
    },
    {
      id: "general-decision-en",
      question:
        "How should a team compare two reasonable alternatives when evidence is incomplete? Suggest a short decision process, including uncertainty and reversible decisions. Keep it under 150 words.",
    },
    {
      id: "general-collaboration-de",
      question:
        "Wie kann ein Team sachlich entscheiden, wenn Fachleute unterschiedliche Einschätzungen haben? Erkläre einen kurzen allgemeinen Entscheidungsprozess mit Unsicherheit und überprüfbaren nächsten Schritten.",
    },
    {
      id: "keiko-mixed-authority",
      question:
        "Explain how packages/keiko-server/src/grounded-answer-assessment.ts separates learned knowledge from source-backed claims, with implementation citations. Then recommend how a team should communicate uncertainty to readers. Keep it under 200 words.",
      target: "packages/keiko-server/src/grounded-answer-assessment.ts",
    },
    {
      id: "keiko-source-return",
      question:
        "Return to the connected-folder implementation: where does packages/keiko-server/src/grounded-qa-multi-source.ts normalize assessment authority before validating source evidence? Cite the actual function and lines, under 150 words.",
      target: "packages/keiko-server/src/grounded-qa-multi-source.ts",
    },
    {
      id: "general-freshness-limit",
      question:
        "Without live verification, how should a team distinguish established general principles from claims that depend on today's regulations or prices? Explain the limits and a useful decision process, under 150 words.",
    },
    {
      id: "keiko-operational-evidence-gap",
      question:
        "Does this checkout establish the outcome of the most recent production recovery drill? Report only recorded evidence; if none, explain what evidence is missing. Do not infer a deployed outcome from tests. Keep it under 150 words.",
    },
  ],
  compaction: [
    {
      id: "compaction-source-before",
      question:
        "Explain how packages/keiko-server/src/grounded-answer-assessment.ts separates learned knowledge from source evidence. Cite implementation lines, under 100 words.",
      target: "packages/keiko-server/src/grounded-answer-assessment.ts",
    },
    {
      id: "compaction-general-after",
      seedHistoryBefore: true,
      question:
        "How should a team compare alternatives with uncertain evidence? Suggest a short general process, under 100 words.",
    },
    {
      id: "compaction-source-return",
      question:
        "Return to packages/keiko-server/src/grounded-answer-assessment.ts. Which function applies the operator's policy before source validation? Cite the current implementation lines, under 100 words.",
      target: "packages/keiko-server/src/grounded-answer-assessment.ts",
    },
  ],
  manual: [
    {
      id: "manual-original-content-only-first",
      targetKey: "late",
      question:
        "What temperature trips the Vesper dosing interlock? Cite the authoritative manual. Keep the answer under 100 words.",
    },
    {
      id: "manual-original-content-only-repeated",
      targetKey: "late",
      question:
        "What temperature trips the Vesper dosing interlock? Cite the authoritative manual. Keep the answer under 100 words.",
    },
    {
      id: "manual-original-entity-target",
      targetKey: "generated",
      question:
        "What operating limit does Überhitzungsschutz specify? Cite the authoritative manual. Keep the answer under 100 words.",
    },
    {
      id: "manual-depth72-exact",
      targetKey: "deep72",
      question:
        "What restart delay is specified in `{target}`? Cite the manual. Keep the answer under 100 words.",
    },
    {
      id: "manual-same-chat-follow-up",
      targetKey: "deep72",
      question:
        "Siehst du die Datei jetzt? Welche Wartezeit vor dem Neustart steht dort? Antworte kurz mit Quellenangabe.",
    },
    {
      id: "manual-general-knowledge",
      question:
        "How should a team communicate uncertainty when choosing between reasonable alternatives? Explain a short general process, under 100 words.",
    },
    {
      id: "manual-mixed-authority",
      targetKey: "deep72",
      question:
        "State the restart delay in `{target}` with a source citation. Then separately explain a general process for deciding safely when operational evidence is incomplete. Keep the answer under 150 words.",
    },
    {
      id: "manual-source-return",
      targetKey: "deep72",
      question:
        "Return to `{target}`. What restart delay does the actual manual specify? Cite it, under 100 words.",
    },
  ],
});

/** Bind reproduction inputs to the existing witness; never retain its file bodies or root path. */
export async function materializeManualCases(corpus) {
  if (corpus.fileCount !== 100_000 || corpus.noGit !== true)
    throw new UsageError("invalid-manual-witness");
  const { isValidScopePath } = await importBuilt("keiko-contracts", "connected-context.js");
  return CONNECTED_CHAT_CAMPAIGNS.manual.map((row) => {
    if (row.targetKey === undefined) return { id: row.id, question: row.question };
    const target = corpus.targets?.[row.targetKey]?.path;
    if (!isValidScopePath(target, { mustBeRelative: true }))
      throw new UsageError("invalid-manual-target");
    return {
      id: row.id,
      question: row.question.replaceAll("{target}", target),
      target,
      expectedFact: manualNumericFact(corpus.targets[row.targetKey], row.targetKey),
    };
  });
}

function manualNumericFact(target, key) {
  const number =
    key === "deep72"
      ? String(target.expectedDelaySeconds)
      : target.body?.match(/\d+(?:[.,]\d+)?/u)?.[0];
  return typeof number === "string" && /^\d+(?:[.,]\d+)?$/u.test(number)
    ? { number: number.replace(",", "."), unit: key === "deep72" ? "seconds" : "temperature" }
    : undefined;
}
