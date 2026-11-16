"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  JiraHumanInputField,
  JiraHumanInputPurpose,
  JiraHumanInputView,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ChatTurnState } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  getJiraHumanInput,
  submitJiraHumanInput,
  cancelJiraHumanInput,
} from "@/lib/jira-human-input-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { bffRequestErrorKind } from "@/lib/http";
import {
  useOptionalWidgetTranslate as useTranslate,
  type WidgetMessageKey,
} from "@/lib/optional-widget-i18n";
import { TextField } from "./widgets/connectors/TextField";
import {
  jiraHumanInputReviewFacts,
  sameJiraHumanInputReview,
} from "./jira-human-input-presentation";
import styles from "./JiraChatTools.module.css";

function fieldKey(field: JiraHumanInputField): WidgetMessageKey {
  switch (field) {
    case "password":
      return "chat.jira.humanInput.password";
    case "currentPassword":
      return "chat.jira.humanInput.currentPassword";
    case "newPassword":
      return "chat.jira.humanInput.newPassword";
    case "oldPassword":
      return "chat.jira.humanInput.oldPassword";
    case "license":
      return "chat.jira.humanInput.license";
    case "ownerShutdownConfirmation":
      return "chat.jira.humanInput.ownerShutdownConfirmation";
  }
}
function passwordLabel(purpose: JiraHumanInputPurpose): WidgetMessageKey | undefined {
  switch (purpose) {
    case "update-myself":
      return "chat.jira.humanInput.currentPassword";
    case "update-my-password":
    case "update-user-password":
    case "validate-create-user-password":
      return "chat.jira.humanInput.newPassword";
    default:
      return undefined;
  }
}
const TERMINAL_STATES: ReadonlySet<JiraHumanInputView["state"]> = new Set([
  "consumed",
  "cancelled",
  "expired",
]);
const STATE_KEYS: Readonly<Record<JiraHumanInputView["state"], WidgetMessageKey>> = {
  "awaiting-input": "chat.jira.humanInput.waiting",
  ready: "chat.jira.humanInput.ready",
  consumed: "chat.jira.humanInput.consumed",
  cancelled: "chat.jira.humanInput.cancelled",
  expired: "chat.jira.humanInput.expired",
};
function reportInputFailure(action: "refresh" | "submit" | "cancel", error: unknown): void {
  reportClientDiagnostic(`jira-human-input-${action}-failed`, {
    kind: "other",
    failureStage: "jira human input",
    errorKind: bffRequestErrorKind(error),
  });
}
function forwardInputState(previous: JiraHumanInputView, next: JiraHumanInputView): boolean {
  if (previous.state === next.state) return previous.revision === next.revision;
  if (previous.state === "awaiting-input") return next.state !== "awaiting-input";
  return (
    previous.state === "ready" &&
    previous.revision === next.revision &&
    (next.state === "consumed" || next.state === "cancelled" || next.state === "expired")
  );
}
interface OwnerConfirmationFieldProps {
  readonly field: JiraHumanInputField;
  readonly value: string;
  readonly node: string | undefined;
  readonly change: (field: JiraHumanInputField, value: string) => void;
}
interface PrivateFieldProps extends OwnerConfirmationFieldProps {
  readonly view: JiraHumanInputView;
}
function OwnerConfirmationField({
  field,
  value,
  node,
  change,
}: OwnerConfirmationFieldProps): ReactNode {
  const t = useTranslate();
  return (
    <div className="acx-field">
      {node === undefined ? (
        <p role="alert">{t("chat.jira.humanInput.ownerUnavailable")}</p>
      ) : (
        <label className="acx-label">
          <input
            type="checkbox"
            checked={value === "confirmed"}
            onChange={(event) => {
              change(field, event.target.checked ? "confirmed" : "");
            }}
          />
          {t("chat.jira.humanInput.ownerShutdownConfirmation", { node })}
        </label>
      )}
    </div>
  );
}
function PrivateField({ field, view, value, node, change }: PrivateFieldProps): ReactNode {
  const t = useTranslate();
  if (field === "ownerShutdownConfirmation")
    return <OwnerConfirmationField field={field} value={value} node={node} change={change} />;
  if (field === "license")
    return (
      <div className="acx-field">
        <label className="acx-label" htmlFor={`${view.requestId}-license`}>
          {t(fieldKey("license"))}
        </label>
        <textarea
          id={`${view.requestId}-license`}
          className="acx-input"
          rows={4}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => {
            change(field, event.target.value);
          }}
        />
      </div>
    );
  return (
    <TextField
      id={`${view.requestId}-${field}`}
      labelKey={
        field === "password"
          ? (passwordLabel(view.purpose) ?? fieldKey("password"))
          : fieldKey(field)
      }
      type="password"
      value={value}
      autoComplete="off"
      hintKey={
        view.optionalFields.includes(field)
          ? "chat.jira.humanInput.optional"
          : "chat.jira.humanInput.required"
      }
      onChange={(next) => {
        change(field, next);
      }}
    />
  );
}
interface InputObservation {
  readonly view: JiraHumanInputView;
  readonly verified: boolean;
  readonly failed: boolean;
  readonly latest: RefObject<JiraHumanInputView>;
  readonly mounted: RefObject<boolean>;
  readonly setVerified: Dispatch<SetStateAction<boolean>>;
  readonly setFailed: Dispatch<SetStateAction<boolean>>;
  readonly accept: (next: JiraHumanInputView) => void;
  readonly refresh: (signal?: AbortSignal) => Promise<void>;
}
function validateInputUpdate(
  initial: Pick<JiraHumanInputView, "requestId" | "purpose" | "expiresAt">,
  previous: JiraHumanInputView,
  next: JiraHumanInputView,
): boolean {
  if (
    initial.requestId !== next.requestId ||
    initial.purpose !== next.purpose ||
    initial.expiresAt !== next.expiresAt
  )
    throw new TypeError("Private input request changed");
  if (
    (previous.review !== undefined || next.review !== undefined) &&
    !sameJiraHumanInputReview(previous, next)
  )
    throw new TypeError("Private input review changed");
  return forwardInputState(previous, next);
}
function useInputObservationEffects(
  initial: JiraHumanInputView,
  turnState: ChatTurnState | undefined,
  observation: InputObservation,
  clear: () => void,
): void {
  const { mounted, latest, accept, refresh, setVerified, setFailed } = observation;
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, [mounted]);
  useEffect(() => {
    try {
      accept(initial);
    } catch (error) {
      clear();
      setVerified(false);
      setFailed(true);
      reportInputFailure("refresh", error);
    }
  }, [accept, initial, clear, setVerified, setFailed]);
  useEffect(() => {
    // Durable terminal views remain sufficient after short-lived private vault records expire.
    if (TERMINAL_STATES.has(latest.current.state)) {
      setVerified(true);
      return;
    }
    const abort = new AbortController();
    void refresh(abort.signal);
    return (): void => {
      abort.abort();
    };
  }, [refresh, initial.revision, initial.state, turnState, latest, setVerified]);
}
function useInputRefresh(
  accept: InputObservation["accept"],
  requestId: string,
  mounted: RefObject<boolean>,
  clear: () => void,
  setVerified: InputObservation["setVerified"],
  setFailed: InputObservation["setFailed"],
): InputObservation["refresh"] {
  return useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setVerified(false);
      try {
        accept(await getJiraHumanInput(requestId, signal));
      } catch (error) {
        if (signal?.aborted) return;
        reportInputFailure("refresh", error);
        if (mounted.current) {
          clear();
          setFailed(true);
        }
      }
    },
    [accept, requestId, clear, mounted, setVerified, setFailed],
  );
}
function useInputObservation(
  initial: JiraHumanInputView,
  turnState: ChatTurnState | undefined,
  clear: () => void,
): InputObservation {
  const [view, setView] = useState(initial);
  const [verified, setVerified] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = useRef(initial);
  const mounted = useRef(true);
  const { requestId, purpose, expiresAt } = initial;
  const accept = useCallback(
    (next: JiraHumanInputView): void => {
      if (!validateInputUpdate({ requestId, purpose, expiresAt }, latest.current, next)) return;
      latest.current = next;
      if (mounted.current) {
        setView(next);
        setVerified(true);
        setFailed(false);
      }
    },
    [requestId, purpose, expiresAt],
  );
  const refresh = useInputRefresh(
    accept,
    initial.requestId,
    mounted,
    clear,
    setVerified,
    setFailed,
  );
  const observation = {
    view,
    verified,
    failed,
    latest,
    mounted,
    setVerified,
    setFailed,
    accept,
    refresh,
  };
  useInputObservationEffects(initial, turnState, observation, clear);
  return observation;
}
function useInputPending(
  view: JiraHumanInputView,
  turnState: ChatTurnState | undefined,
  reviewAvailable: boolean,
  clear: () => void,
  setVerified: InputObservation["setVerified"],
): {
  readonly pending: boolean;
  readonly shownState: JiraHumanInputView["state"];
} {
  const [expired, setExpired] = useState(view.expiresAt <= Date.now());
  const pending =
    turnState === "pending" &&
    view.state === "awaiting-input" &&
    !expired &&
    view.expiresAt > Date.now() &&
    reviewAvailable;
  useEffect(() => {
    if (!pending) clear();
    if (view.state !== "awaiting-input" && view.state !== "ready") return;
    const timer = window.setTimeout(
      () => {
        clear();
        setVerified(false);
        setExpired(true);
      },
      Math.max(0, view.expiresAt - Date.now()),
    );
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [pending, view.expiresAt, view.state, clear, setVerified]);
  return {
    pending,
    shownState:
      expired && (view.state === "awaiting-input" || view.state === "ready")
        ? "expired"
        : view.state,
  };
}
type PrivateInputValues = Partial<Record<JiraHumanInputField, string>>;
function useInputSubmission(
  observation: InputObservation,
  pending: boolean,
  values: PrivateInputValues,
  clear: () => void,
): {
  readonly busy: boolean;
  readonly send: (cancel: boolean) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const { view, verified, accept, setVerified, setFailed, mounted } = observation;
  async function send(cancel: boolean): Promise<void> {
    if (busy || (!cancel && (!verified || !pending))) return;
    const supplied = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
    clear();
    setBusy(true);
    setVerified(false);
    setFailed(false);
    try {
      accept(
        cancel
          ? await cancelJiraHumanInput(view.requestId)
          : await submitJiraHumanInput(view.requestId, {
              expectedRevision: view.revision,
              values: supplied,
            }),
      );
    } catch (error) {
      reportInputFailure(cancel ? "cancel" : "submit", error);
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return { busy, send };
}
function PrivateInputActions({
  observation,
  values,
  submission,
}: {
  readonly observation: InputObservation;
  readonly values: PrivateInputValues;
  readonly submission: ReturnType<typeof useInputSubmission>;
}): ReactNode {
  const t = useTranslate();
  const { view, verified } = observation;
  const { busy, send } = submission;
  const ready = view.fields.every((field) => (values[field]?.length ?? 0) > 0);
  return (
    <div className={styles.cmpActions}>
      <button
        type="button"
        className="lk-btn lk-btn--primary"
        disabled={busy || !verified || !ready}
        onClick={(): void => {
          void send(false);
        }}
      >
        {t("chat.jira.humanInput.submit")}
      </button>
      <button
        type="button"
        className="lk-btn"
        disabled={busy}
        onClick={(): void => {
          void send(true);
        }}
      >
        {t("chat.jira.humanInput.cancel")}
      </button>
    </div>
  );
}
function PrivateInputControls({
  observation,
  pending,
  values,
  setValues,
  submission,
}: {
  readonly observation: InputObservation;
  readonly pending: boolean;
  readonly values: PrivateInputValues;
  readonly setValues: Dispatch<SetStateAction<PrivateInputValues>>;
  readonly submission: ReturnType<typeof useInputSubmission>;
}): ReactNode {
  const t = useTranslate();
  const { view, verified } = observation;
  const { busy } = submission;
  const node =
    view.review?.targetKind === "anonymization-task" ? view.review.executingNode : undefined;
  if (!pending) return null;
  // Keep private entry outside a browser credential form: only the explicit control sends it.
  return (
    <div>
      <fieldset disabled={busy || !verified}>
        <legend>{t("chat.jira.humanInput.fields")}</legend>
        {[...view.fields, ...view.optionalFields].map((field) => (
          <PrivateField
            key={field}
            field={field}
            view={view}
            value={values[field] ?? ""}
            node={node}
            change={(key, value): void => {
              setValues((current) => ({ ...current, [key]: value }));
            }}
          />
        ))}
      </fieldset>
      <PrivateInputActions observation={observation} values={values} submission={submission} />
    </div>
  );
}
function PrivateInputReview({
  facts,
}: {
  readonly facts: ReturnType<typeof jiraHumanInputReviewFacts>;
}): ReactNode {
  const t = useTranslate();
  return (
    <>
      {facts === undefined ? (
        <p>{t("chat.jira.humanInput.review.unavailable")}</p>
      ) : (
        <dl className={styles.cmpFactsGroup}>
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}
function PrivateInputRefresh({
  observation,
  reviewAvailable,
  busy,
}: {
  readonly observation: InputObservation;
  readonly reviewAvailable: boolean;
  readonly busy: boolean;
}): ReactNode {
  const t = useTranslate();
  const { view, verified, refresh } = observation;
  return (
    <>
      {!verified || (!reviewAvailable && !TERMINAL_STATES.has(view.state)) ? (
        <button
          type="button"
          className="lk-btn"
          disabled={busy}
          onClick={(): void => {
            void refresh();
          }}
        >
          {t("chat.jira.humanInput.refresh")}
        </button>
      ) : null}{" "}
    </>
  );
}
/** Values exist only while typing and during the single BFF submission, never in saved drafts. */
interface JiraHumanInputProps {
  readonly initial: JiraHumanInputView;
  readonly turnState: ChatTurnState | undefined;
}
export function JiraHumanInput({ initial, turnState }: JiraHumanInputProps): ReactNode {
  const t = useTranslate();
  const [values, setValues] = useState<PrivateInputValues>({});
  const clear = useCallback((): void => {
    setValues({});
  }, []);
  const observation = useInputObservation(initial, turnState, clear);
  const { view, failed } = observation;
  const reviewFacts = jiraHumanInputReviewFacts(view, t);
  const { pending, shownState } = useInputPending(
    view,
    turnState,
    reviewFacts !== undefined,
    clear,
    observation.setVerified,
  );
  const submission = useInputSubmission(observation, pending, values, clear);
  const attestation = initial.purpose === "unlock-user-anonymization";
  return (
    <section className={styles.cmpCard} aria-label={t("chat.jira.humanInput.title")}>
      <h4>{t("chat.jira.humanInput.title")}</h4>
      <p>{t(STATE_KEYS[shownState])}</p>
      <p>
        {t(
          attestation ? "chat.jira.humanInput.attestationPrivate" : "chat.jira.humanInput.private",
        )}
      </p>
      <PrivateInputReview facts={reviewFacts} />
      {failed ? <p role="alert">{t("chat.jira.humanInput.failed")}</p> : null}
      <PrivateInputControls
        observation={observation}
        pending={pending}
        values={values}
        setValues={setValues}
        submission={submission}
      />
      <PrivateInputRefresh
        observation={observation}
        reviewAvailable={reviewFacts !== undefined}
        busy={submission.busy}
      />
    </section>
  );
}
