"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SubmitEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS,
  type CodingWorkbenchRuntimeQuestion,
  type CodingWorkbenchRuntimeQuestionRequest,
  type CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";

import {
  useCodingWorkbenchQuestions,
  type CodingWorkbenchQuestionMutationFailure,
  type CodingWorkbenchQuestionsStatus,
  type UseCodingWorkbenchQuestionsResult,
} from "@/lib/useCodingWorkbenchQuestions";
import { PanelTitle } from "./CodingWorkbenchPanelTitle";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import { actionFailureAlert, cx } from "./codingWorkbenchLabels";
import styles from "./CodingWorkbenchWindow.module.css";

const TERMINAL_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
]);

export function CodingWorkbenchQuestions({
  runId,
  revision,
  runState,
  runtimeEventSignal,
  refreshSnapshot,
}: {
  readonly runId: string | undefined;
  readonly revision: number | undefined;
  readonly runState: CodingWorkbenchRuntimeStateName | undefined;
  readonly runtimeEventSignal: number;
  readonly refreshSnapshot: () => Promise<void>;
}): ReactNode {
  const terminal = runId !== undefined && TERMINAL_STATES.has(runState ?? "idle");
  const result = useCodingWorkbenchQuestions({
    runId,
    revision,
    runState,
    runtimeEventSignal,
    refreshSnapshot,
  });
  if (runId === undefined && !terminal) return null;
  return <CodingWorkbenchQuestionsSurface result={result} variant="standalone" />;
}

export interface CodingWorkbenchQuestionsSurfaceProps {
  readonly result: UseCodingWorkbenchQuestionsResult;
  readonly variant: "standalone" | "inline";
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
}

export function CodingWorkbenchQuestionsSurface({
  result,
  variant,
  restoreFocusRef,
}: CodingWorkbenchQuestionsSurfaceProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const focusedRequestRef = useRef<string | undefined>(undefined);
  const firstRequestId = result.questions[0]?.id;
  const answer = useFocusRestoringAction(result.answer, restoreFocusRef);
  const reject = useFocusRestoringAction(result.reject, restoreFocusRef);

  useEffect(() => {
    if (firstRequestId === undefined || focusedRequestRef.current === firstRequestId) return;
    focusedRequestRef.current = firstRequestId;
    headingRef.current?.focus();
  }, [firstRequestId]);

  const retryable =
    result.status === "offline" || result.status === "error" || result.status === "stale";
  // F-09a: only work actually in flight disables the form. A refused answer/reject leaves the
  // question open, and re-submitting it is the whole point of keeping it on screen — deriving
  // `busy` from `status !== "ready"` disabled every control the operator needed.
  const busy = result.status === "submitting" || result.status === "loading";
  return (
    <section
      className={variant === "inline" ? styles.questionInline : styles.card}
      aria-label={t("codingWorkbench.questions.sectionLabel")}
      data-testid="coding-workbench-questions"
      data-question-state={result.status}
    >
      <PanelTitle
        eyebrow={t("codingWorkbench.questions.eyebrow")}
        id="coding-workbench-questions-title"
      >
        {t("codingWorkbench.questions.title")}
      </PanelTitle>
      <p className={styles.helpText}>{t("codingWorkbench.questions.help")}</p>
      <QuestionStatus
        status={result.status}
        count={result.questions.length}
        failure={result.mutationFailure}
        t={t}
      />
      {retryable ? (
        <button className={styles.button} type="button" onClick={result.retry}>
          {t("codingWorkbench.questions.retry")}
        </button>
      ) : null}
      {result.questions.length > 0 ? (
        <div className={styles.questionRequests}>
          {result.questions.slice(0, 1).map((request) => (
            <QuestionRequestForm
              key={request.id}
              request={request}
              busy={busy}
              headingRef={headingRef}
              onAnswer={answer}
              onReject={reject}
              t={t}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function useFocusRestoringAction<T extends readonly unknown[]>(
  action: (...args: T) => Promise<boolean>,
  restoreFocusRef: RefObject<HTMLElement | null> | undefined,
): (...args: T) => Promise<boolean> {
  return useCallback(
    async (...args: T): Promise<boolean> => {
      const accepted = await action(...args);
      if (accepted) restoreFocusRef?.current?.focus();
      return accepted;
    },
    [action, restoreFocusRef],
  );
}

function QuestionStatus({
  status,
  count,
  failure,
  t,
}: {
  readonly status: CodingWorkbenchQuestionsStatus;
  readonly count: number;
  readonly failure: CodingWorkbenchQuestionMutationFailure | null;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const alert = failure !== null || status === "offline" || status === "error";
  return (
    <p
      className={styles.questionStatus}
      role={alert ? "alert" : "status"}
      aria-live={alert ? undefined : "polite"}
      aria-atomic="true"
      data-tone={statusTone(alert, status)}
      data-question-failure-code={failure?.code}
    >
      {questionStatusMessage(status, count, failure, t)}
    </p>
  );
}

// F-09a: a refused answer or reject reported the LISTING failure ("Questions could not be
// refreshed.") — a different action, and a sentence that told the operator to retry the wrong
// thing. The mutation failure owns the sentence whenever there is one, names the action that
// actually failed, and carries the machine code plus the correlation id.
function questionStatusMessage(
  status: CodingWorkbenchQuestionsStatus,
  count: number,
  failure: CodingWorkbenchQuestionMutationFailure | null,
  t: CodingWorkbenchTranslate,
): string {
  if (failure !== null) {
    return actionFailureAlert(`codingWorkbench.questions.${failure.action}Failed`, failure, t);
  }
  return status === "ready"
    ? t("codingWorkbench.questions.ready", { count })
    : t(`codingWorkbench.questions.${status}`);
}

interface QuestionRequestFormProps {
  readonly request: CodingWorkbenchRuntimeQuestionRequest;
  readonly busy: boolean;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onAnswer: (id: string, answers: readonly (readonly string[])[]) => Promise<boolean>;
  readonly onReject: (id: string) => Promise<boolean>;
  readonly t: CodingWorkbenchTranslate;
}

function QuestionRequestForm({
  request,
  busy,
  headingRef,
  onAnswer,
  onReject,
  t,
}: QuestionRequestFormProps): ReactNode {
  const [selections, setSelections] = useState<string[][]>(() => request.questions.map(() => []));
  const [customValues, setCustomValues] = useState<string[]>(() => request.questions.map(() => ""));
  const [validationVisible, setValidationVisible] = useState(false);
  const answers = useMemo(
    () => questionAnswers(request.questions, selections, customValues),
    [customValues, request.questions, selections],
  );
  const valid = answers.every((answer) => answer.length > 0);
  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setValidationVisible(!valid);
    if (valid && !busy) void onAnswer(request.id, answers);
  };
  return (
    <form
      className={styles.questionRequest}
      onSubmit={submit}
      data-question-request-id={request.id}
      aria-busy={busy}
    >
      <h3 ref={headingRef} className={styles.cardTitle} tabIndex={-1}>
        {t("codingWorkbench.questions.requestTitle")}
      </h3>
      {request.questions.map((question, index) => (
        <QuestionField
          key={`${request.id}-${String(index)}`}
          requestId={request.id}
          index={index}
          question={question}
          selected={selections[index] ?? []}
          customValue={customValues[index] ?? ""}
          disabled={busy}
          setSelections={setSelections}
          setCustomValues={setCustomValues}
          t={t}
        />
      ))}
      {validationVisible ? <p role="alert">{t("codingWorkbench.questions.required")}</p> : null}
      <div className={styles.controls}>
        <button className={cx(styles.button, styles.buttonPrimary)} type="submit" disabled={busy}>
          {t("codingWorkbench.questions.answer")}
        </button>
        <button
          className={styles.button}
          type="button"
          disabled={busy}
          onClick={() => void onReject(request.id)}
        >
          {t("codingWorkbench.questions.reject")}
        </button>
      </div>
    </form>
  );
}

interface QuestionFieldProps {
  readonly requestId: string;
  readonly index: number;
  readonly question: CodingWorkbenchRuntimeQuestion;
  readonly selected: readonly string[];
  readonly customValue: string;
  readonly disabled: boolean;
  readonly setSelections: Dispatch<SetStateAction<string[][]>>;
  readonly setCustomValues: Dispatch<SetStateAction<string[]>>;
  readonly t: CodingWorkbenchTranslate;
}

function QuestionField(props: QuestionFieldProps): ReactNode {
  const inputType = props.question.multiple === true ? "checkbox" : "radio";
  const name = `coding-question-${props.requestId}-${String(props.index)}`;
  const customId = `${name}-custom`;
  const select = (label: string, checked: boolean): void => {
    props.setSelections((current) =>
      updateSelections(current, props.index, label, checked, inputType),
    );
    if (inputType === "radio")
      props.setCustomValues((current) => replaceAt(current, props.index, ""));
  };
  const custom = (event: ChangeEvent<HTMLInputElement>): void => {
    const value = event.currentTarget.value;
    props.setCustomValues((current) => replaceAt(current, props.index, value));
    if (inputType === "radio" && value.length > 0) {
      props.setSelections((current) => replaceAt(current, props.index, []));
    }
  };
  return (
    <fieldset className={styles.questionFieldset} data-question-index={props.index}>
      <legend>{props.question.header}</legend>
      <p className={styles.questionPrompt}>{props.question.question}</p>
      {props.question.multiple === true ? (
        <p className={styles.helpText}>{props.t("codingWorkbench.questions.multipleHint")}</p>
      ) : null}
      <div className={styles.questionOptions}>
        {props.question.options.map((option, optionIndex) => (
          <label
            className={styles.questionOption}
            key={option.label}
            htmlFor={`${name}-option-${String(optionIndex)}`}
            aria-label={option.label}
          >
            <input
              id={`${name}-option-${String(optionIndex)}`}
              type={inputType}
              name={name}
              checked={props.selected.includes(option.label)}
              disabled={props.disabled}
              onChange={(event) => select(option.label, event.currentTarget.checked)}
              data-question-option={optionIndex}
            />
            <span className={styles.questionOptionText}>
              <strong>{option.label}</strong>
              <span>{option.description}</span>
            </span>
          </label>
        ))}
      </div>
      {props.question.custom === true ? (
        <label className={styles.fieldLabel} htmlFor={customId}>
          {props.t("codingWorkbench.questions.customLabel", { header: props.question.header })}
          <input
            id={customId}
            className={styles.questionInput}
            value={props.customValue}
            disabled={props.disabled}
            maxLength={CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS}
            onChange={custom}
          />
        </label>
      ) : null}
    </fieldset>
  );
}

function updateSelections(
  current: string[][],
  index: number,
  label: string,
  checked: boolean,
  inputType: "checkbox" | "radio",
): string[][] {
  const previous = current[index] ?? [];
  if (inputType === "radio") return replaceAt(current, index, [label]);
  const next = checked ? [...previous, label] : previous.filter((item) => item !== label);
  return replaceAt(current, index, next);
}

function statusTone(alert: boolean, status: CodingWorkbenchQuestionsStatus): string {
  if (alert) return "danger";
  // "unpaired" is the honest re-pair state (#2478): visible as a warning, but not an alert — the
  // run keeps working and only question content is withheld until a new session is paired.
  return status === "stale" || status === "unpaired" ? "warning" : "neutral";
}

function replaceAt<T>(current: readonly T[], index: number, value: T): T[] {
  const next = [...current];
  next[index] = value;
  return next;
}

function questionAnswers(
  questions: readonly CodingWorkbenchRuntimeQuestion[],
  selections: readonly (readonly string[])[],
  customValues: readonly string[],
): readonly (readonly string[])[] {
  return questions.map((question, index) => {
    const custom = customValues[index]?.trim() ?? "";
    if (question.multiple !== true && custom.length > 0) return [custom];
    return [...new Set([...(selections[index] ?? []), ...(custom.length > 0 ? [custom] : [])])];
  });
}
