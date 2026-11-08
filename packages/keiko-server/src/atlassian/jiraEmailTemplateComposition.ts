import type { JiraManagedConnection } from "@oscharko-dev/keiko-connectors";
import { currentRedactionSecrets } from "../redaction-secrets.js";
import {
  jiraChatAttachmentSource,
  jiraChatEmailTemplatePreviewSource,
  previewJiraEmailTemplatePack,
  type JiraChatAttachmentDeps,
  type JiraChatAttachmentReview,
} from "./jiraChatAttachment.js";
import { inspectJiraEmailTemplateArchive } from "./jiraEmailTemplateArchive.js";

/** Archive inspection is available without granting a file source to Coding. */
export function jiraEmailTemplateInspection(
  deps: Parameters<typeof currentRedactionSecrets>[0],
  signal: AbortSignal,
): NonNullable<JiraManagedConnection["emailTemplates"]> {
  return {
    inspect: (bytes) =>
      inspectJiraEmailTemplateArchive(bytes, {
        secrets: currentRedactionSecrets(deps),
        signal,
      }),
  };
}

/** Check reads precede the approval card. Actual sends keep the existing review decision. */
export function jiraChatEmailTemplateComposition(
  deps: JiraChatAttachmentDeps,
  options: {
    readonly chatId: string;
    readonly correlationId: string;
    readonly signal: AbortSignal;
    readonly review: () => JiraChatAttachmentReview;
  },
): NonNullable<JiraManagedConnection["emailTemplates"]> {
  return {
    ...jiraEmailTemplateInspection(deps, options.signal),
    sourceFor: (check) => {
      if (check) return jiraChatEmailTemplatePreviewSource(deps, options);
      return async (request) => {
        const review = options.review();
        const snapshot = review.required
          ? undefined
          : await previewJiraEmailTemplatePack(
              deps,
              options.chatId,
              request.path,
              options.correlationId,
              options.signal,
            );
        // Re-read through the send owner. Changed policy/bytes cannot reuse the earlier snapshot.
        return jiraChatAttachmentSource(deps, {
          ...options,
          ...(snapshot === undefined ? {} : { emailTemplateSnapshot: snapshot }),
        })(request);
      };
    },
  };
}
