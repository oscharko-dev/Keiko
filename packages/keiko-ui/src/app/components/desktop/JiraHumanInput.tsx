"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { JiraHumanInputField, JiraHumanInputPurpose, JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ChatToolExchange, ChatTurnState } from "@oscharko-dev/keiko-contracts/bff-wire";
import { getJiraHumanInput, submitJiraHumanInput, cancelJiraHumanInput } from "@/lib/jira-human-input-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { bffRequestErrorKind } from "@/lib/http";
import { useOptionalWidgetTranslate as useTranslate, type WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { TextField } from "./widgets/connectors/TextField";
import { jiraHumanInputReviewFacts, sameJiraHumanInputReview } from "./jira-human-input-presentation";
import styles from "./JiraChatTools.module.css";

const FIELD_KEYS: Readonly<Record<JiraHumanInputField, WidgetMessageKey>> = {
  password: "chat.jira.humanInput.password", currentPassword: "chat.jira.humanInput.currentPassword",
  newPassword: "chat.jira.humanInput.newPassword", oldPassword: "chat.jira.humanInput.oldPassword",
  license: "chat.jira.humanInput.license", ownerShutdownConfirmation: "chat.jira.humanInput.ownerShutdownConfirmation",
};
const PASSWORD_LABELS: Readonly<Partial<Record<JiraHumanInputPurpose, WidgetMessageKey>>> = {
  "update-myself": "chat.jira.humanInput.currentPassword",
  "update-my-password": "chat.jira.humanInput.newPassword",
  "update-user-password": "chat.jira.humanInput.newPassword",
  "validate-create-user-password": "chat.jira.humanInput.newPassword",
};
const TERMINAL_STATES: ReadonlySet<JiraHumanInputView["state"]> = new Set(["consumed", "cancelled", "expired"]);
const STATE_KEYS: Readonly<Record<JiraHumanInputView["state"], WidgetMessageKey>> = {
  "awaiting-input": "chat.jira.humanInput.waiting", ready: "chat.jira.humanInput.ready",
  consumed: "chat.jira.humanInput.consumed", cancelled: "chat.jira.humanInput.cancelled", expired: "chat.jira.humanInput.expired",
};
function reportInputFailure(action: "refresh" | "submit" | "cancel", error: unknown): void {
  reportClientDiagnostic(`jira-human-input-${action}-failed`, {
    kind: "other", failureStage: "jira human input", errorKind: bffRequestErrorKind(error),
  });
}
function forwardInputState(previous: JiraHumanInputView, next: JiraHumanInputView): boolean {
  if (previous.state === next.state) return previous.revision === next.revision;
  if (previous.state === "awaiting-input") return next.state !== "awaiting-input";
  return previous.state === "ready" && previous.revision === next.revision &&
    (next.state === "consumed" || next.state === "cancelled" || next.state === "expired");
}
interface PrivateFieldProps {
  readonly field: JiraHumanInputField;
  readonly view: JiraHumanInputView;
  readonly value: string;
  readonly node: string | undefined;
  readonly change: (field: JiraHumanInputField, value: string) => void;
}
function PrivateField({ field, view, value, node, change }: PrivateFieldProps): ReactNode {
  const t = useTranslate();
  if (field === "ownerShutdownConfirmation") return <div className="acx-field">
    {node === undefined ? <p role="alert">{t("chat.jira.humanInput.ownerUnavailable")}</p> : <label className="acx-label">
      <input type="checkbox" checked={value === "confirmed"}
        onChange={(event) => { change(field, event.target.checked ? "confirmed" : ""); }} />
      {t("chat.jira.humanInput.ownerShutdownConfirmation", { node })}
    </label>}
  </div>;
  if (field === "license") return <div className="acx-field">
    <label className="acx-label" htmlFor={`${view.requestId}-license`}>{t(FIELD_KEYS.license)}</label>
    <textarea id={`${view.requestId}-license`} className="acx-input" rows={4} autoComplete="off" spellCheck={false}
      value={value} onChange={(event) => { change(field, event.target.value); }} />
  </div>;
  return <TextField id={`${view.requestId}-${field}`}
    labelKey={field === "password" ? PASSWORD_LABELS[view.purpose] ?? FIELD_KEYS.password : FIELD_KEYS[field]} type="password"
    value={value} autoComplete="off"
    hintKey={view.optionalFields.includes(field) ? "chat.jira.humanInput.optional" : "chat.jira.humanInput.required"}
    onChange={(next) => { change(field, next); }} />;
}
/** Values exist only while typing and during the single BFF submission, never in saved drafts. */
export function JiraHumanInput({ initial, turnState }: {
  readonly initial: JiraHumanInputView;
  readonly turnState: ChatTurnState | undefined;
  readonly call?: ChatToolExchange["call"];
}): ReactNode {
  const t = useTranslate();
  const attestation = initial.purpose === "unlock-user-anonymization";
  const [view, setView] = useState(initial);
  const reviewFacts = jiraHumanInputReviewFacts(view, t);
  const node = view.review?.targetKind === "anonymization-task" ? view.review.executingNode : undefined;
  const latest = useRef(initial);
  const [locallyExpired, setLocallyExpired] = useState(initial.expiresAt <= Date.now());
  const [values, setValues] = useState<Partial<Record<JiraHumanInputField, string>>>({});
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const pending = turnState === "pending" && view.state === "awaiting-input" && !locallyExpired && view.expiresAt > Date.now() && reviewFacts !== undefined;
  const shownState = locallyExpired && (view.state === "awaiting-input" || view.state === "ready") ? "expired" : view.state;
  const accept = useCallback((next: JiraHumanInputView): void => {
    if (initial.requestId !== next.requestId || initial.purpose !== next.purpose || initial.expiresAt !== next.expiresAt) throw new TypeError("Private input request changed");
    if ((latest.current.review !== undefined || next.review !== undefined) && !sameJiraHumanInputReview(latest.current, next))
      throw new TypeError("Private input review changed");
    if (!forwardInputState(latest.current, next)) return;
    latest.current = next;
    if (mounted.current) { setView(next); setVerified(true); setFailed(false); }
  }, [initial.requestId, initial.purpose, initial.expiresAt]);
  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setVerified(false);
    try { accept(await getJiraHumanInput(initial.requestId, signal)); }
    catch (error) {
      if (signal?.aborted) return;
      reportInputFailure("refresh", error);
      if (mounted.current) { setValues({}); setFailed(true); }
    }
  }, [accept, initial.requestId]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    try { accept(initial); }
    catch (error) {
      setValues({}); setVerified(false); setFailed(true);
      reportInputFailure("refresh", error);
    }
  }, [accept, initial]);
  useEffect(() => {
    // Durable terminal views remain sufficient after short-lived private vault records expire.
    if (TERMINAL_STATES.has(latest.current.state)) {
      setVerified(true);
      return;
    }
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => { abort.abort(); };
  }, [refresh, initial.revision, initial.state, turnState]);
  useEffect(() => {
    if (!pending) setValues({});
    if (view.state !== "awaiting-input" && view.state !== "ready") return;
    const timer = window.setTimeout(() => {
      setValues({}); setVerified(false); setLocallyExpired(true);
      // Client time disables entry; a later authoritative consumed view still wins.
    }, Math.max(0, view.expiresAt - Date.now()));
    return () => { window.clearTimeout(timer); };
  }, [pending, view.expiresAt, view.state]);
  async function send(cancel: boolean): Promise<void> {
    if (busy || (!cancel && (!verified || !pending))) return;
    const supplied = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
    setValues({}); setBusy(true); setVerified(false); setFailed(false);
    try {
      accept(cancel ? await cancelJiraHumanInput(view.requestId) :
        await submitJiraHumanInput(view.requestId, { expectedRevision: view.revision, values: supplied }));
    } catch (error) {
      reportInputFailure(cancel ? "cancel" : "submit", error);
      if (mounted.current) setFailed(true);
    }
    finally { if (mounted.current) setBusy(false); }
  }
  const ready = view.fields.every((field) => (values[field]?.length ?? 0) > 0);
  return (
    <section className={styles.cmpCard} aria-label={t("chat.jira.humanInput.title")}>
      <h4>{t("chat.jira.humanInput.title")}</h4>
      <p>{t(STATE_KEYS[shownState])}</p>
      <p>{t(attestation ? "chat.jira.humanInput.attestationPrivate" : "chat.jira.humanInput.private")}</p>
      {reviewFacts === undefined ? <p>{t("chat.jira.humanInput.review.unavailable")}</p> :
        <dl className={styles.cmpFactsGroup}>{reviewFacts.map((fact) => <div key={fact.label}>
          <dt>{fact.label}</dt><dd>{fact.value}</dd>
        </div>)}</dl>}
      {failed ? <p role="alert">{t("chat.jira.humanInput.failed")}</p> : null}
      {/* Keep private entry outside a browser credential form: only the explicit control sends it. */}
      {pending ? <div>
        <fieldset disabled={busy || !verified}>
          <legend>{t("chat.jira.humanInput.fields")}</legend>
          {[...view.fields, ...view.optionalFields].map((field) => <PrivateField key={field}
            field={field} view={view} value={values[field] ?? ""} node={node}
            change={(key, value) => { setValues((current) => ({ ...current, [key]: value })); }}
          />)}
        </fieldset>
        <div className={styles.cmpActions}>
          <button type="button" className="lk-btn lk-btn--primary" disabled={busy || !verified || !ready} onClick={() => { void send(false); }}>{t("chat.jira.humanInput.submit")}</button>
          <button type="button" className="lk-btn" disabled={busy} onClick={() => { void send(true); }}>{t("chat.jira.humanInput.cancel")}</button>
        </div>
      </div> : null}
      {!verified || (reviewFacts === undefined && !TERMINAL_STATES.has(view.state)) ?
        <button type="button" className="lk-btn" disabled={busy} onClick={() => { void refresh(); }}>{t("chat.jira.humanInput.refresh")}</button> : null}
    </section>
  );
}
