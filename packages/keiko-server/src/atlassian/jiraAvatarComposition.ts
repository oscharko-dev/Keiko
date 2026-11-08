import type { JiraManagedConnection } from "@oscharko-dev/keiko-connectors";
import { currentRedactionSecrets } from "../redaction-secrets.js";
import { admitJiraAvatarImage } from "./jiraAttachmentContentPolicy.js";
import { jiraChatAttachmentSource, jiraChatAvatarPreviewSource, previewJiraAvatarImage,
  type JiraChatAttachmentDeps, type JiraChatAttachmentReview } from "./jiraChatAttachment.js";

type AvatarAdmission = NonNullable<JiraManagedConnection["avatars"]>;
/** Inspection alone does not grant a file source to Coding, or grant a native Jira session. */
export function jiraAvatarInspection(deps: Parameters<typeof currentRedactionSecrets>[0], signal: AbortSignal): Pick<AvatarAdmission, "inspectImage"> {
  return { inspectImage: async (bytes) => {
    const admitted = await admitJiraAvatarImage({ bytes, name: "avatar-image", secrets: currentRedactionSecrets(deps), signal });
    if (admitted.ok) return { ok: true, value: { mimeType: admitted.mimeType } };
    return { ok: false, reason: admitted.refusal === "contains-credential" ? "permission-denied" : "field-validation",
      detail: { messages: ["The avatar image did not pass the existing PNG/JPEG content and credential admission. No image bytes were uploaded."] } };
  } };
}

/** Uses only this Chat's existing connected-file authority. Required review and byte integrity
 * stay separate: preview never grants send, and allowed mode receives no new approval prompt. */
export function jiraChatAvatarComposition(deps: JiraChatAttachmentDeps, options: {
  readonly chatId: string;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly review: () => JiraChatAttachmentReview;
}): Pick<AvatarAdmission, "inspectImage" | "sourceFor"> {
  return {
    ...jiraAvatarInspection(deps, options.signal),
    sourceFor: (check) => {
      if (check) return jiraChatAvatarPreviewSource(deps, options);
      return async (request) => {
        if (request.purpose !== "jira-avatar-image") return { ok: false, reason: "field-validation" };
        const review = options.review();
        const snapshot = review.required ? undefined : await previewJiraAvatarImage(
          deps, options.chatId, request.path, options.correlationId, options.signal,
        );
        return jiraChatAttachmentSource(deps, { ...options,
          ...(snapshot === undefined ? {} : { avatarSnapshot: snapshot }),
        })(request);
      };
    },
  };
}
