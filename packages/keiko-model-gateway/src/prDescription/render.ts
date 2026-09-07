import { isIP } from "node:net";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { GitChangeSnapshot } from "@oscharko-dev/keiko-contracts";
import {
  PR_DESCRIPTION_RENDERING_VERSION,
  PR_DESCRIPTION_SCHEMA_VERSION,
  PR_DESCRIPTION_SECTION_KEYS,
  PR_DESCRIPTION_SECTION_MAX_ITEMS,
  prDescriptionBinding,
  prDescriptionArtifactDigestFields,
  freezePrDescriptionArtifact,
  type PrDescriptionArtifact,
  type PrDescriptionCandidate,
  type PrDescriptionCoverage,
  type PrDescriptionLanguage,
  type PrDescriptionOutcome,
  type PrDescriptionReason,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description";
import {
  PR_DESCRIPTION_ATTRIBUTION,
  framePrDescriptionRegion,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-region";
import type { PrDescriptionBranding } from "./types.js";

export function emptyPrDescriptionCandidate(): PrDescriptionCandidate {
  return { summary: [], keyChanges: [], risks: [], reviewerFocus: [] };
}

export function mergePrDescriptionCandidates(
  candidates: readonly PrDescriptionCandidate[],
): PrDescriptionCandidate {
  const merged = { summary: [], keyChanges: [], risks: [], reviewerFocus: [] } as {
    -readonly [Key in keyof PrDescriptionCandidate]: PrDescriptionCandidate[Key][number][];
  };
  for (const key of PR_DESCRIPTION_SECTION_KEYS) {
    const seen = new Set<string>();
    for (const statement of candidates.flatMap((candidate) => candidate[key])) {
      const identity = canonicalise(statement);
      if (seen.has(identity) || merged[key].length >= PR_DESCRIPTION_SECTION_MAX_ITEMS) continue;
      seen.add(identity);
      merged[key].push(statement);
    }
  }
  return merged;
}

export function validatedPrDescriptionLogoUrl(
  branding: PrDescriptionBranding | undefined,
): string | undefined {
  const raw = branding?.immutableLogoUrl;
  if (branding?.availability !== "public" || raw === undefined || raw.length > 2_048)
    return undefined;
  try {
    const url = new URL(raw);
    return isPublicImmutableLogo(url) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isPublicImmutableLogo(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.port === "" &&
    publicLogoHost(url.hostname) &&
    /\/[a-f0-9]{40,64}\//u.test(url.pathname) &&
    url.pathname.endsWith(".svg")
  );
}

function publicLogoHost(hostname: string): boolean {
  return (
    isIP(hostname) === 0 &&
    hostname.includes(".") &&
    !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(hostname)
  );
}

function footer(branding: PrDescriptionBranding | undefined): string {
  const url = validatedPrDescriptionLogoUrl(branding);
  return url === undefined
    ? PR_DESCRIPTION_ATTRIBUTION
    : `![Keiko](${url}) ${PR_DESCRIPTION_ATTRIBUTION}`;
}

const LABELS = {
  en: {
    summary: "Summary",
    keyChanges: "Key changes",
    validation: "Validation evidence",
    risks: "Risks",
    reviewerFocus: "Reviewer focus",
    noTests: "The Git snapshot contains no executed test results. Test outcomes are not asserted.",
    risk: "Risk assessment is limited to the captured change evidence.",
    review: "Review the complete pull request and any changes omitted from this description.",
    fallback:
      "A deterministic factual summary is shown because a validated model narrative is unavailable.",
    failed:
      "Description generation did not complete. Refresh or retry before applying a description.",
  },
  de: {
    summary: "Zusammenfassung",
    keyChanges: "Wesentliche Änderungen",
    validation: "Validierungsnachweise",
    risks: "Risiken",
    reviewerFocus: "Prüfschwerpunkte",
    noTests:
      "Der Git-Snapshot enthält keine Ergebnisse ausgeführter Tests. Es werden keine Testergebnisse behauptet.",
    risk: "Die Risikobewertung beschränkt sich auf die erfassten Änderungsnachweise.",
    review: "Prüfen Sie den vollständigen Pull Request und ausgelassene Änderungen.",
    fallback:
      "Eine deterministische sachliche Zusammenfassung wird angezeigt, da keine validierte Modellbeschreibung vorliegt.",
    failed:
      "Die Beschreibung wurde nicht fertiggestellt. Vor dem Anwenden aktualisieren oder erneut versuchen.",
  },
} as const;

function bullets(
  candidate: PrDescriptionCandidate,
  key: keyof PrDescriptionCandidate,
  otherwise: string,
): string {
  if (candidate[key].length === 0) return otherwise;
  return candidate[key].map(({ text }) => `- ${escapeMarkdownText(text)}`).join("\n");
}

function escapeMarkdownText(text: string): string {
  return text
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("*", String.raw`\*`)
    .replaceAll("_", String.raw`\_`);
}

function countSummary(snapshot: GitChangeSnapshot, language: PrDescriptionLanguage): string {
  const additions = String(snapshot.entries.reduce((sum, entry) => sum + entry.additions, 0));
  const deletions = String(snapshot.entries.reduce((sum, entry) => sum + entry.deletions, 0));
  const files = String(snapshot.completeness.totalFiles);
  return language === "en"
    ? `${files} changed files; ${additions} added and ${deletions} removed lines in the retained entries.`
    : `${files} geänderte Dateien; ${additions} hinzugefügte und ${deletions} entfernte Zeilen in den erfassten Einträgen.`;
}

function omissionSummary(coverage: PrDescriptionCoverage, language: PrDescriptionLanguage): string {
  const snapshot = coverage.snapshot;
  const counts = [
    snapshot.omittedFiles,
    snapshot.omittedHunks,
    snapshot.truncatedFiles,
    coverage.omittedEvidenceCount,
  ].join("/");
  const reasons = snapshot.omissions
    .map((item) => `${item.reason}: ${String(item.files)}/${String(item.hunks)}`)
    .join(", ");
  const omissions = omissionReasons(reasons, language);
  return language === "en"
    ? `Coverage — omitted files / omitted hunks / truncated files / unnarrated entries: ${counts}.${omissions}`
    : `Abdeckung — ausgelassene Dateien / Hunks / gekürzte Dateien / unbeschriebene Einträge: ${counts}.${omissions}`;
}

function omissionReasons(reasons: string, language: PrDescriptionLanguage): string {
  if (reasons === "") return "";
  return language === "en"
    ? ` Snapshot omissions (files/hunks): ${reasons}.`
    : ` Snapshot-Auslassungen (Dateien/Hunks): ${reasons}.`;
}

export interface PrDescriptionRenderInput {
  readonly snapshot: GitChangeSnapshot;
  readonly candidate: PrDescriptionCandidate;
  readonly language: PrDescriptionLanguage;
  readonly outcome: PrDescriptionOutcome;
  readonly reason: PrDescriptionReason;
  readonly coverage: PrDescriptionCoverage;
  readonly branding?: PrDescriptionBranding;
}

function narrativeMarkdown(input: PrDescriptionRenderInput): string {
  const labels = LABELS[input.language];
  const summary = countSummary(input.snapshot, input.language);
  const intro = input.outcome === "failed" ? labels.failed : labels.fallback;
  const prefix = input.outcome === "fallback" || input.outcome === "failed" ? `${intro}\n\n` : "";
  return framePrDescriptionRegion(
    [
      `## ${labels.summary}\n\n${prefix}${bullets(input.candidate, "summary", summary)}`,
      `## ${labels.keyChanges}\n\n${bullets(input.candidate, "keyChanges", summary)}`,
      `## ${labels.validation}\n\n${labels.noTests}`,
      `## ${labels.risks}\n\n${bullets(input.candidate, "risks", labels.risk)}\n\n${omissionSummary(input.coverage, input.language)}`,
      `## ${labels.reviewerFocus}\n\n${bullets(input.candidate, "reviewerFocus", labels.review)}`,
      footer(input.branding),
    ].join("\n\n"),
  );
}

export function buildPrDescriptionArtifact(input: PrDescriptionRenderInput): PrDescriptionArtifact {
  const fields = {
    schemaVersion: PR_DESCRIPTION_SCHEMA_VERSION,
    renderingVersion: PR_DESCRIPTION_RENDERING_VERSION,
    binding: prDescriptionBinding(input.snapshot),
    language: input.language,
    outcome: input.outcome,
    reason: input.reason,
    coverage: input.coverage,
    candidate: input.candidate,
    markdown: narrativeMarkdown(input),
  };
  return freezePrDescriptionArtifact({
    ...fields,
    artifactDigest: sha256Hex(canonicalise(prDescriptionArtifactDigestFields(fields))),
  });
}
