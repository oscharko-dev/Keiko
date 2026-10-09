// Customer prompts for the actual connected-chat lab; these are questions, never model outputs.
import { INCIDENT_FEATURE_PATH, INCIDENT_RETRIEVAL_CASES } from "../../check-retrieval-quality.mjs";

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
});
