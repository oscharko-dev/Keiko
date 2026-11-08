"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { JiraHumanInputField, JiraHumanInputPurpose, JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ChatToolExchange, ChatTurnState } from "@oscharko-dev/keiko-contracts/bff-wire";
import { getJiraHumanInput, submitJiraHumanInput, cancelJiraHumanInput } from "@/lib/jira-human-input-api";
import { useOptionalWidgetTranslate as useTranslate, type WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { TextField } from "./widgets/connectors/TextField";
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
function forwardInputState(previous: JiraHumanInputView, next: JiraHumanInputView): boolean {
  if (previous.state === next.state) return previous.revision === next.revision;
  if (previous.state === "awaiting-input") return next.state !== "awaiting-input";
  return previous.state === "ready" && previous.revision === next.revision &&
    (next.state === "consumed" || next.state === "cancelled" || next.state === "expired");
}
function reviewedNode(call: ChatToolExchange["call"] | undefined): string | undefined {
  const task = call?.arguments.expectedTask;
  if (task === null || typeof task !== "object" || Array.isArray(task)) return undefined;
  return "executingNode" in task && typeof task.executingNode === "string" ? task.executingNode : undefined;
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
export function JiraHumanInput({ initial, turnState, call }: {
  readonly initial: JiraHumanInputView;
  readonly turnState: ChatTurnState | undefined;
  readonly call?: ChatToolExchange["call"];
}): ReactNode {
  const t = useTranslate();
  const node = reviewedNode(call);
  const attestation = initial.purpose === "unlock-user-anonymization";
  const [view, setView] = useState(initial);
  const latest = useRef(initial);
  const [locallyExpired, setLocallyExpired] = useState(initial.expiresAt <= Date.now());
  const [values, setValues] = useState<Partial<Record<JiraHumanInputField, string>>>({});
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const pending = turnState === "pending" && view.state === "awaiting-input" && !locallyExpired && view.expiresAt > Date.now();
  const shownState = locallyExpired && (view.state === "awaiting-input" || view.state === "ready") ? "expired" : view.state;
  const accept = useCallback((next: JiraHumanInputView): void => {
    if (initial.requestId !== next.requestId || initial.purpose !== next.purpose || initial.expiresAt !== next.expiresAt) throw new TypeError("Private input request changed");
    if (!forwardInputState(latest.current, next)) return;
    latest.current = next;
    if (mounted.current) { setView(next); setVerified(true); setFailed(false); }
  }, [initial.requestId, initial.purpose, initial.expiresAt]);
  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setVerified(false);
    try { accept(await getJiraHumanInput(initial.requestId, signal)); }
    catch { if (mounted.current && !signal?.aborted) setFailed(true); }
  }, [accept, initial.requestId]);
  useEffect(() => { accept(initial); }, [accept, initial]);
  useEffect(() => {
    mounted.current = true;
    // Durable terminal views remain sufficient after short-lived private vault records expire.
    if (TERMINAL_STATES.has(initial.state)) {
      setVerified(true);
      return () => { mounted.current = false; };
    }
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => { mounted.current = false; abort.abort(); };
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
    } catch { if (mounted.current) setFailed(true); }
    finally { if (mounted.current) setBusy(false); }
  }
  const ready = view.fields.every((field) => (values[field]?.length ?? 0) > 0);
  return (
    <section className={styles.cmpCard} aria-label={t("chat.jira.humanInput.title")}>
      <h4>{t("chat.jira.humanInput.title")}</h4>
      <p>{t(STATE_KEYS[shownState])}</p>
      <p>{t(attestation ? "chat.jira.humanInput.attestationPrivate" : "chat.jira.humanInput.private")}</p>
      {failed ? <p role="alert">{t("chat.jira.humanInput.failed")}</p> : null}
      {pending ? <form onSubmit={(event) => { event.preventDefault(); void send(false); }} autoComplete="off">
        <fieldset disabled={busy || !verified}>
          <legend>{t("chat.jira.humanInput.fields")}</legend>
          {[...view.fields, ...view.optionalFields].map((field) => <PrivateField key={field}
            field={field} view={view} value={values[field] ?? ""} node={node}
            change={(key, value) => { setValues((current) => ({ ...current, [key]: value })); }}
          />)}
        </fieldset>
        <div className={styles.cmpActions}>
          <button type="submit" className="lk-btn lk-btn--primary" disabled={busy || !verified || !ready}>{t("chat.jira.humanInput.submit")}</button>
          <button type="button" className="lk-btn" disabled={busy} onClick={() => { void send(true); }}>{t("chat.jira.humanInput.cancel")}</button>
        </div>
      </form> : null}
      {!verified ? <button type="button" className="lk-btn" disabled={busy} onClick={() => { void refresh(); }}>{t("chat.jira.humanInput.refresh")}</button> : null}
    </section>
  );
}
