export const FEEDBACK_EN_MESSAGES = {
  "feedback.security.eyebrow": "Private security reporting",
  "feedback.security.title": "Before you continue",
  "feedback.security.body":
    "Do not use ordinary feedback for suspected vulnerabilities, exposed credentials, or customer data. Use Keiko's private security channel instead.",
  "feedback.security.privateLink": "Report a security issue privately",
  "feedback.security.continue": "Continue with ordinary feedback",
  "feedback.security.detected":
    "This report may describe a security vulnerability. Ordinary submission and public sharing are blocked. Use the private Security Advisory route.",
  "feedback.form.title": "Share feedback",
  "feedback.form.description":
    "Describe an ordinary product issue. Keiko scans the local draft before anything can leave this device.",
  "feedback.form.productVersion": "Product version",
  "feedback.form.browserDescription": "Browser description (optional)",
  "feedback.form.handwrittenEvidence": "Handwritten evidence (optional)",
  "feedback.form.category": "Category",
  "feedback.form.platform": "Platform",
  "feedback.form.featureArea": "Feature area",
  "feedback.form.impact": "User impact",
  "feedback.form.summaryTitle": "Title",
  "feedback.form.summaryDescription": "Description",
  "feedback.form.steps": "Steps to reproduce",
  "feedback.form.expected": "Expected result",
  "feedback.form.actual": "Actual result",
  "feedback.form.scan": "Scan and preview",
  "feedback.form.scanning": "Scanning feedback...",
  "feedback.form.scanError":
    "Keiko could not prepare a sanitized preview. Review the draft and retry.",
  "feedback.form.rewriteRequired":
    "Rewrite the required field, then scan again. Nothing has left this device.",
  "feedback.form.rawLogRejected":
    "Raw logs cannot be submitted. Replace them with a handwritten sanitized evidence summary, then scan again.",
  "feedback.form.attachmentRejected":
    "The selected attachment is not supported as safe text. Remove it or choose a supported text file, then scan again.",
  "feedback.form.sizeRejected":
    "Feedback exceeds a size limit. Shorten the affected content or remove attachments, then scan again.",
  "feedback.form.unsafeTextRejected":
    "The affected text contains unsupported control or formatting characters. Remove them, then scan again.",
  "feedback.form.removed.browserDescription":
    "Browser description removed from the local draft. Scan again to refresh the preview.",
  "feedback.form.removed.handwrittenEvidence":
    "Handwritten evidence removed from the local draft. Scan again to refresh the preview.",
  "feedback.preview.region": "Sanitized preview",
  "feedback.preview.title": "Sanitized preview",
  "feedback.preview.residualRisk":
    "Deterministic scanning can miss proprietary or customer data. Review the complete outbound text before submitting or opening GitHub.",
  "feedback.preview.summary": "Summary",
  "feedback.preview.browserDescription": "Browser description",
  "feedback.preview.handwrittenEvidence": "Handwritten evidence",
  "feedback.preview.steps": "Steps to reproduce",
  "feedback.preview.expected": "Expected result",
  "feedback.preview.actual": "Actual result",
  "feedback.preview.attachment": "Attachment {ordinal}",
  "feedback.preview.editAndRescan": "Edit and rescan",
  "feedback.preview.publicLink": "Open public GitHub form",
  "feedback.preview.publicNotice":
    "GitHub is public. Prefilled values can appear in the URL and browser history.",
  "feedback.preview.copyFallback":
    "The report is too large for a prefilled URL. The complete sanitized copy is shown below.",
  "feedback.preview.copyAvailable":
    "GitHub may not prefill dropdowns. The complete sanitized copy is available below.",
  "feedback.public.region": "Public GitHub handoff",
  "feedback.public.completeCopy": "Complete sanitized report",
  "feedback.public.copy": "Copy sanitized report",
  "feedback.public.copying": "Copying sanitized report...",
  "feedback.public.copySuccess": "Sanitized report copied.",
  "feedback.public.copyError":
    "Keiko could not copy the sanitized report. Select the full text and copy it manually.",
  "feedback.public.revalidationRejected":
    "The prepared report no longer passes the current local policy. Edit it and scan again.",
  "feedback.public.revalidationError":
    "Keiko could not confirm the current local policy. No public payload was opened or copied. Retry the check or edit and scan again.",
  "feedback.public.popupBlocked":
    "Your browser blocked the GitHub window. Allow pop-ups for Keiko and try again, or use Copy sanitized report.",
  "feedback.public.reservationTitle": "Opening public GitHub form",
  "feedback.public.reservationStatus": "Opening public GitHub form…",
  "feedback.submission.exact.title": "Exact payload for submission",
  "feedback.submission.exact.description":
    "Review the immutable canonical JSON and matching digest that Keiko will submit.",
  "feedback.submission.exact.digest": "SHA-256 digest",
  "feedback.submission.review.title": "Submission review",
  "feedback.submission.review.label":
    "I reviewed the exact sanitized payload and confirm it is ready for submission.",
  "feedback.submission.continue": "Continue to submission",
  "feedback.submission.confirm.title": "Confirm feedback submission",
  "feedback.submission.confirm.description":
    "Submit this exact sanitized payload to Keiko's maintainer review queue.",
  "feedback.submission.submit": "Submit feedback",
  "feedback.submission.submitting": "Submitting feedback...",
  "feedback.submission.accepted": "Feedback was submitted for maintainer review.",
  "feedback.submission.receipt.instructions":
    "Copy this one-time receipt now. Keiko keeps it only in this open feedback window; the secret is included in the copied text.",
  "feedback.submission.receipt.id": "Receipt ID",
  "feedback.submission.receipt.expires": "Receipt expires",
  "feedback.submission.receipt.copy": "Copy one-time receipt",
  "feedback.submission.receipt.copying": "Copying receipt...",
  "feedback.submission.receipt.copied":
    "Receipt copied. Keiko cleared it from this feedback window.",
  "feedback.submission.receipt.copyError":
    "Keiko could not copy the receipt. It remains available in this feedback window.",
  "feedback.submission.unavailable.title": "Feedback intake unavailable",
  "feedback.submission.unavailable.message":
    "Keiko intake is currently unavailable. Try again or use the public GitHub form.",
  "feedback.submission.rejected.title": "Feedback submission rejected",
  "feedback.submission.rejected.message":
    "Keiko did not accept this feedback for maintainer review.",
  "feedback.submission.rejected.editAndRescan": "Edit and rescan feedback",
  "feedback.submission.rateLimited.title": "Feedback submission paused",
  "feedback.submission.rateLimited.label": "Warning",
  "feedback.submission.rateLimited.message":
    "Keiko cannot accept another submission right now. Try again later or use the public GitHub form.",
  "feedback.submission.rateLimited.editAndRescan": "Edit feedback",
  "feedback.submission.error.title": "Feedback submission could not be confirmed",
  "feedback.submission.error.message":
    "Keiko could not confirm the submission outcome. Retry only to make another attempt.",
  "feedback.submission.retry": "Retry submission",
  "feedback.disposition.region": "Privacy changes",
  "feedback.disposition.description":
    "Keiko changed only the units listed below. Removed text is not shown.",
  "feedback.disposition.field.browserDescription": "Browser description",
  "feedback.disposition.field.handwrittenEvidence": "Handwritten evidence",
  "feedback.disposition.field.attachment": "Attachment {ordinal}",
  "feedback.disposition.action.redacted": "Redacted",
  "feedback.disposition.action.quarantined": "Quarantined",
  "feedback.disposition.action.omitted": "Omitted",
  "feedback.disposition.unit.quotedSegment": "Quoted segment",
  "feedback.disposition.unit.structuredValue": "Structured value",
  "feedback.disposition.unit.lineRemainder": "Line remainder",
  "feedback.disposition.unit.optionalField": "Optional field",
  "feedback.disposition.unit.attachment": "Attachment",
  "feedback.disposition.message.redacted": "{field}: sensitive content was redacted.",
  "feedback.disposition.message.quarantined":
    "{field}: ambiguous credential-like content was quarantined.",
  "feedback.disposition.message.omitted":
    "{field}: no safe optional content remained, so it was omitted.",
  "feedback.disposition.edit": "Edit {field}",
  "feedback.disposition.edit.browserDescription": "Edit browser description",
  "feedback.disposition.edit.handwrittenEvidence": "Edit handwritten evidence",
  "feedback.disposition.remove.browserDescription": "Remove browser description",
  "feedback.disposition.remove.handwrittenEvidence": "Remove handwritten evidence",
  "feedback.disposition.reviewAttachment": "Review attachment {ordinal}",
  "feedback.attachment.title": "Text attachments (optional)",
  "feedback.attachment.help":
    "Add up to 3 text files, 64 KiB each and 128 KiB total. File names are never included.",
  "feedback.attachment.add": "Add text attachment",
  "feedback.attachment.selected": "Selected text attachments",
  "feedback.attachment.item": "Attachment {ordinal}",
  "feedback.attachment.remove": "Remove attachment {ordinal}",
  "feedback.attachment.removed": "Attachment {ordinal} removed. Scan again to refresh the preview.",
  "feedback.attachment.error.count": "You can add up to 3 attachments.",
  "feedback.attachment.error.item": "Each attachment must be 64 KiB or smaller.",
  "feedback.attachment.error.aggregate": "Attachments must total 128 KiB or less.",
  "feedback.attachment.error.read": "Keiko could not read the selected text attachment.",
  "feedback.option.category.defect": "Defect",
  "feedback.option.category.performance": "Performance",
  "feedback.option.category.usability": "Usability",
  "feedback.option.category.compatibility": "Compatibility",
  "feedback.option.category.other": "Other",
  "feedback.option.platform.macOS": "macOS",
  "feedback.option.platform.windows": "Windows",
  "feedback.option.platform.linux": "Linux",
  "feedback.option.platform.other": "Other",
  "feedback.option.feature.installation": "Installation",
  "feedback.option.feature.modelConfiguration": "Model configuration",
  "feedback.option.feature.conversation": "Conversation",
  "feedback.option.feature.files": "Files",
  "feedback.option.feature.editor": "Editor",
  "feedback.option.feature.terminal": "Terminal",
  "feedback.option.feature.browser": "Browser",
  "feedback.option.feature.localKnowledge": "Local Knowledge",
  "feedback.option.feature.memory": "Memory",
  "feedback.option.feature.gitDelivery": "Git delivery",
  "feedback.option.feature.updates": "Updates",
  "feedback.option.feature.voice": "Voice",
  "feedback.option.feature.other": "Other",
  "feedback.option.impact.installation": "Blocks installation or startup",
  "feedback.option.impact.modelSetup": "Blocks model or credential setup",
  "feedback.option.impact.coreBlock": "Blocks core workflow",
  "feedback.option.impact.coreDegrade": "Degrades core workflow",
  "feedback.option.impact.usability": "Visual or usability issue",
  "feedback.option.impact.unknown": "Unknown",
} as const;

export type FeedbackMessageKey = keyof typeof FEEDBACK_EN_MESSAGES;
export type FeedbackMessageCatalog = Readonly<Record<FeedbackMessageKey, string>>;
