"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { useFeedbackTranslate } from "./feedback-i18n";

export const FEEDBACK_SECURITY_ADVISORY_URL =
  "https://github.com/oscharko-dev/Keiko/security/advisories/new";

export function FeedbackSecurityGate({
  onContinue,
}: {
  readonly onContinue: () => void;
}): ReactNode {
  const t = useFeedbackTranslate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <section className="feedback-security" aria-labelledby="feedback-security-title">
      <p className="feedback-eyebrow">{t("feedback.security.eyebrow")}</p>
      <h2 ref={headingRef} id="feedback-security-title" className="feedback-heading" tabIndex={-1}>
        {t("feedback.security.title")}
      </h2>
      <p className="feedback-body">{t("feedback.security.body")}</p>
      <div className="feedback-actions">
        <a
          className="feedback-secondary-action"
          href={FEEDBACK_SECURITY_ADVISORY_URL}
          target="_blank"
          rel="noreferrer"
        >
          {t("feedback.security.privateLink")}
        </a>
        <button className="feedback-primary-action" type="button" onClick={onContinue}>
          {t("feedback.security.continue")}
        </button>
      </div>
    </section>
  );
}
