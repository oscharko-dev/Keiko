// Keiko's own assessment inside a grounded answer (ADR-0144). The source-backed part of the answer
// cites the retrieved sources; the note below it holds what the sources do not back, such as
// Keiko's recommendation, and says so in a visible label, so a reader never takes it for evidence.
// This module is loaded on demand (ChatWindow `AssessedAnswerBody`), so answers without an
// assessment add nothing to the initial desktop paint.

import type { ReactNode } from "react";
import { splitOwnAssessment } from "@oscharko-dev/keiko-contracts/runtime/grounded-assessment";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import type { CitationPreviewController } from "./hooks/usePdfCitationPreview";
import type {
  OpenRepositoryReference,
  RepositoryReferenceRoot,
  RepositoryReferenceEvidence,
} from "./repositoryReferences";
import { SafeMarkdownBoundary } from "./SafeMarkdown";
import styles from "./OwnAssessment.module.css";

export interface AssessedAnswerBodyProps {
  readonly content: string;
  readonly messageId: string;
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly repositoryEvidence?: RepositoryReferenceEvidence | undefined;
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
  readonly citationPreview: CitationPreviewController | undefined;
}

function OwnAssessmentNote({ children }: { readonly children: ReactNode }): ReactNode {
  const t = useOptionalWidgetTranslate();
  const label = t("grounded.ownAssessment.label");
  return (
    <div className={styles.cmpOwnAssessment} role="note" aria-label={label}>
      <p className={styles.cmpOwnAssessmentLabel}>{label}</p>
      {children}
    </div>
  );
}

/** A grounded answer's cited part, then Keiko's own assessment as a labelled note. */
export function AssessedAnswerBody(props: AssessedAnswerBodyProps): ReactNode {
  const { grounded, assessment } = splitOwnAssessment(props.content);
  const shared = {
    literalUserInput: false,
    repositoryRoots: props.repositoryRoots,
    openRepositoryReference: props.openRepositoryReference,
    streaming: false,
  };
  return (
    <>
      {grounded.length === 0 ? null : (
        <SafeMarkdownBoundary
          {...shared}
          source={grounded}
          repositoryEvidence={props.repositoryEvidence}
          diagnosticCorrelationId={props.messageId}
          citationPreview={props.citationPreview}
        />
      )}
      {assessment === undefined ? null : (
        // Keiko's own assessment is never evidence: no citation preview links its brackets.
        <OwnAssessmentNote>
          <SafeMarkdownBoundary
            {...shared}
            source={assessment}
            repositoryEvidence={
              props.repositoryEvidence === undefined
                ? undefined
                : { citations: [], readPaths: props.repositoryEvidence.readPaths }
            }
            // The message's own correlation keeps its layout evidence joinable (a derived id with
            // a colon is no valid correlation); the part is named in the message identity instead.
            diagnosticCorrelationId={props.messageId}
            diagnosticMessageId={`${props.messageId}:assessment`}
            citationPreview={undefined}
          />
        </OwnAssessmentNote>
      )}
    </>
  );
}
