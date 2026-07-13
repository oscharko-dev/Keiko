"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type ReactNode,
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
  type CodingWorkbenchQuestionsStatus,
} from "@/lib/useCodingWorkbenchQuestions";
import { PanelTitle } from "./CodingWorkbenchSections";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import { cx } from "./codingWorkbenchLabels";
import styles from "./codingWorkbenchStyles";

const TERMINAL_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
]);

export function CodingWorkbenchQuestions({
  runId,
  runState,
}: {
  readonly runId: string | undefined;
  readonly runState: CodingWorkbenchRuntimeStateName | undefined;
}): ReactNode {
  const active = runState === "running";
  const terminal = runId !== undefined && TERMINAL_STATES.has(runState ?? "idle");
  const result = useCodingWorkbenchQuestions({ runId, active, terminal });
  const t = useCodingWorkbenchTranslate();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const focusedRequestRef = useRef<string | undefined>(undefined);
  const firstRequestId = result.questions[0]?.id;
  const captureHeading = useCallback((node: HTMLHeadingElement | null): void => {
    headingRef.current = node;
  }, []);
  const captureStatus = useCallback((node: HTMLParagraphElement | null): void => {
    statusRef.current = node;
  }, []);

  useEffect(() => {
    if (firstRequestId === undefined || focusedRequestRef.current === firstRequestId) return;
    focusedRequestRef.current = firstRequestId;
    headingRef.current?.focus();
  }, [firstRequestId]);
  useEffect(() => {
    if (result.status === "stale") statusRef.current?.focus();
  }, [result.status]);

  if (runId === undefined && !terminal) return null;
  return (
    <section
      className={styles.card}
      aria-labelledby="coding-workbench-questions-title"
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
        statusRef={captureStatus}
        t={t}
      />
      {(result.status === "offline" || result.status === "error" || result.status === "stale") && (
        <button className={styles.button} type="button" onClick={result.retry}>
          {t("codingWorkbench.questions.retry")}
        </button>
      )}
      {result.questions.length > 0 ? (
        <div className={styles.questionRequests}>
          {result.questions.slice(0, 1).map((request, index) => (
            <QuestionRequestForm
              key={request.id}
              request={request}
              busy={result.status !== "ready"}
              headingRef={index === 0 ? captureHeading : undefined}
              onAnswer={result.answer}
              onReject={result.reject}
              t={t}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function QuestionStatus({
  status,
  count,
  statusRef,
  t,
}: {
  readonly status: CodingWorkbenchQuestionsStatus;
  readonly count: number;
  readonly statusRef: (node: HTMLParagraphElement | null) => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const alert = status === "offline" || status === "error";
  return (
    <p
      ref={statusRef}
      className={styles.questionStatus}
      role={alert ? "alert" : "status"}
      aria-live={alert ? undefined : "polite"}
      aria-atomic="true"
      tabIndex={status === "stale" ? -1 : undefined}
      data-tone={alert ? "danger" : status === "stale" ? "warning" : "neutral"}
    >
      {questionStatusLabel(status, count, t)}
    </p>
  );
}

function questionStatusLabel(
  status: CodingWorkbenchQuestionsStatus,
  count: number,
  t: CodingWorkbenchTranslate,
): string {
  return status === "ready"
    ? t("codingWorkbench.questions.ready", { count })
    : t(`codingWorkbench.questions.${status}`);
}

interface QuestionRequestFormProps {
  readonly request: CodingWorkbenchRuntimeQuestionRequest;
  readonly busy: boolean;
  readonly headingRef: ((node: HTMLHeadingElement | null) => void) | undefined;
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
  const submit = (event: FormEvent<HTMLFormElement>): void => {
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
      <h3 ref={headingRef} className={styles.cardTitle} tabIndex={headingRef ? -1 : undefined}>
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
          {t(busy ? "codingWorkbench.questions.answering" : "codingWorkbench.questions.answer")}
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
  const next =
    inputType === "radio"
      ? [label]
      : checked
        ? [...previous, label]
        : previous.filter((item) => item !== label);
  return replaceAt(current, index, next);
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
