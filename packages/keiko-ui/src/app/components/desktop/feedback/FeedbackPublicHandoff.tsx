"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

import {
  revalidateFeedbackReportV1,
  type FeedbackRevalidationOutcomeV1,
  type PreparedFeedbackSnapshotV1,
} from "@/lib/feedback-api";
import {
  createFeedbackPublicProjectionV1,
  type FeedbackPublicProjectionV1,
} from "@/lib/feedback-public-projection";
import { useFeedbackTranslate, type FeedbackTranslate } from "./feedback-i18n";
import {
  FeedbackPublicWindowGuard,
  initializeFeedbackPublicWindow,
  isolateFeedbackPublicWindow,
  reserveFeedbackPublicWindow,
  type FeedbackPublicWindowOpener,
  type FeedbackPublicWindowContent,
  type FeedbackReservedWindow,
} from "./feedback-public-window";

export type FeedbackClipboardWriter = (text: string) => Promise<void>;
export type FeedbackRevalidator = typeof revalidateFeedbackReportV1;
export type FeedbackPublicOpener = FeedbackPublicWindowOpener;

type PublicAction = "idle" | "copy" | "open";
type PublicCopyState = "idle" | "busy" | "success" | "error";
type ProjectionResult =
  | { readonly kind: "projection"; readonly projection: FeedbackPublicProjectionV1 }
  | { readonly kind: "error" | "invalidated" | "stale" };

interface PublicActionState {
  readonly action: PublicAction;
  readonly copyState: PublicCopyState;
  readonly copyText: string | undefined;
  readonly popupBlocked: boolean;
  readonly validationError: boolean;
  begin(action: Exclude<PublicAction, "idle">): number | undefined;
  current(generation: number): boolean;
  finish(generation: number): void;
  copyFailed(): void;
  copySucceeded(): void;
  revealCopy(text: string): void;
  holdReservation(generation: number, window: FeedbackReservedWindow): boolean;
  closeReservation(generation: number): void;
  releaseReservation(generation: number): void;
  popupWasBlocked(): void;
  validationFailed(): void;
}

interface PublicActionDeps {
  readonly prepared: PreparedFeedbackSnapshotV1;
  readonly revalidateReport: FeedbackRevalidator;
  readonly onInvalidated: (outcome: FeedbackRevalidationOutcomeV1["outcome"]) => void;
  readonly state: PublicActionState;
}

interface PublicStateValues {
  readonly action: PublicAction;
  readonly copyState: PublicCopyState;
  readonly copyText: string | undefined;
  readonly popupBlocked: boolean;
  readonly validationError: boolean;
}

interface PublicStateControls {
  readonly begin: PublicActionState["begin"];
  readonly current: PublicActionState["current"];
  readonly finish: PublicActionState["finish"];
  readonly setCopyState: (state: PublicCopyState) => void;
  readonly setCopyText: (text: string) => void;
  readonly setPopupBlocked: (blocked: boolean) => void;
  readonly setValidationError: (failed: boolean) => void;
  readonly holdReservation: PublicActionState["holdReservation"];
  readonly closeReservation: PublicActionState["closeReservation"];
  readonly releaseReservation: PublicActionState["releaseReservation"];
}

export async function writeFeedbackClipboard(text: string): Promise<void> {
  try {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      throw new Error("feedback clipboard unavailable");
    }
    await navigator.clipboard.writeText(text);
  } catch {
    throw new Error("feedback clipboard unavailable");
  }
}

export function openFeedbackPublicUrl(): FeedbackReservedWindow | null {
  return reserveFeedbackPublicWindow();
}

function publicActionState(
  values: PublicStateValues,
  controls: PublicStateControls,
): PublicActionState {
  return {
    ...values,
    begin: controls.begin,
    current: controls.current,
    finish: controls.finish,
    copyFailed: () => controls.setCopyState("error"),
    copySucceeded: () => controls.setCopyState("success"),
    revealCopy: controls.setCopyText,
    holdReservation: controls.holdReservation,
    closeReservation: controls.closeReservation,
    releaseReservation: controls.releaseReservation,
    popupWasBlocked: () => controls.setPopupBlocked(true),
    validationFailed: () => {
      controls.setValidationError(true);
      controls.setCopyState("idle");
    },
  };
}

function usePublicActionState(digest: string): PublicActionState {
  const [copyText, setCopyText] = useState<string | undefined>();
  const [action, setAction] = useState<PublicAction>("idle");
  const [copyState, setCopyState] = useState<PublicCopyState>("idle");
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [validationError, setValidationError] = useState(false);
  const [guard] = useState(() => new FeedbackPublicWindowGuard());
  useEffect(() => {
    guard.activate(digest);
    setCopyText(undefined);
    setAction("idle");
    setCopyState("idle");
    setPopupBlocked(false);
    setValidationError(false);
    return () => guard.deactivate();
  }, [digest, guard]);
  const current = (candidate: number): boolean => guard.current(digest, candidate);
  const begin = (next: "copy" | "open"): number | undefined => {
    const generation = guard.begin(digest);
    if (generation === undefined) return undefined;
    setAction(next);
    setPopupBlocked(false);
    setValidationError(false);
    if (next === "copy") setCopyState("busy");
    return generation;
  };
  const finish = (candidate: number): void => {
    if (guard.finish(digest, candidate)) setAction("idle");
  };
  return publicActionState(
    { action, copyState, copyText, popupBlocked, validationError },
    {
      begin,
      current,
      finish,
      setCopyState,
      setCopyText,
      setPopupBlocked,
      setValidationError,
      holdReservation: (generation, window) => guard.hold(digest, generation, window),
      closeReservation: (generation) => guard.closeHeld(generation),
      releaseReservation: (generation) => guard.release(generation),
    },
  );
}

async function validatedProjection(
  deps: PublicActionDeps,
  generation: number,
): Promise<ProjectionResult> {
  let result: FeedbackRevalidationOutcomeV1;
  try {
    result = await deps.revalidateReport(deps.prepared);
  } catch {
    return deps.state.current(generation) ? { kind: "error" } : { kind: "stale" };
  }
  if (!deps.state.current(generation)) return { kind: "stale" };
  if (result.outcome !== "valid") {
    deps.onInvalidated(result.outcome);
    return { kind: "invalidated" };
  }
  if (!deps.state.current(generation)) return { kind: "stale" };
  try {
    return {
      kind: "projection",
      projection: createFeedbackPublicProjectionV1(deps.prepared.report),
    };
  } catch {
    return deps.state.current(generation) ? { kind: "error" } : { kind: "stale" };
  }
}

async function performCopy(deps: PublicActionDeps, write: FeedbackClipboardWriter): Promise<void> {
  const generation = deps.state.begin("copy");
  if (generation === undefined) return;
  const result = await validatedProjection(deps, generation);
  if (result.kind === "error") deps.state.validationFailed();
  if (result.kind !== "projection" || !deps.state.current(generation)) {
    deps.state.finish(generation);
    return;
  }
  deps.state.revealCopy(result.projection.copyText);
  if (!deps.state.current(generation)) return;
  try {
    await write(result.projection.copyText);
    if (deps.state.current(generation)) deps.state.copySucceeded();
  } catch {
    if (deps.state.current(generation)) deps.state.copyFailed();
  } finally {
    deps.state.finish(generation);
  }
}

function requestReservation(open: FeedbackPublicOpener): FeedbackReservedWindow | null {
  try {
    return open();
  } catch {
    return null;
  }
}

async function performOpen(
  deps: PublicActionDeps,
  open: FeedbackPublicOpener,
  content: FeedbackPublicWindowContent,
): Promise<void> {
  const generation = deps.state.begin("open");
  if (generation === undefined) return;
  const reserved = requestReservation(open);
  if (
    reserved === null ||
    !initializeFeedbackPublicWindow(reserved, content) ||
    !isolateFeedbackPublicWindow(reserved)
  ) {
    deps.state.popupWasBlocked();
    deps.state.finish(generation);
    return;
  }
  if (!deps.state.holdReservation(generation, reserved)) return;
  const result = await validatedProjection(deps, generation);
  if (result.kind === "error") deps.state.validationFailed();
  if (result.kind !== "projection" || !deps.state.current(generation)) {
    deps.state.closeReservation(generation);
    deps.state.finish(generation);
    return;
  }
  deps.state.revealCopy(result.projection.copyText);
  if (!deps.state.current(generation)) return;
  try {
    reserved.location.replace(result.projection.href);
    deps.state.releaseReservation(generation);
  } catch {
    deps.state.closeReservation(generation);
    if (deps.state.current(generation)) deps.state.popupWasBlocked();
  } finally {
    deps.state.finish(generation);
  }
}

function reservationContent(t: FeedbackTranslate): FeedbackPublicWindowContent {
  return {
    language: typeof document === "undefined" ? undefined : document.documentElement.lang,
    status: t("feedback.public.reservationStatus"),
    title: t("feedback.public.reservationTitle"),
  };
}

function CompleteCopy({
  id,
  text,
  t,
}: {
  readonly id: string;
  readonly text: string;
  readonly t: FeedbackTranslate;
}): ReactNode {
  return (
    <>
      <label className="feedback-public-label" htmlFor={id}>
        {t("feedback.public.completeCopy")}
      </label>
      <textarea id={id} className="feedback-public-copy-text" value={text} readOnly />
    </>
  );
}

function PublicMessages({
  state,
  t,
}: {
  readonly state: PublicActionState;
  readonly t: FeedbackTranslate;
}): ReactNode {
  return (
    <>
      {state.copyState === "success" ? (
        <p className="feedback-public-success" role="status">
          {t("feedback.public.copySuccess")}
        </p>
      ) : null}
      {state.copyState === "error" ? (
        <p className="feedback-public-error" role="alert">
          {t("feedback.public.copyError")}
        </p>
      ) : null}
      {state.validationError ? (
        <p className="feedback-public-error" role="alert">
          {t("feedback.public.revalidationError")}
        </p>
      ) : null}
      {state.popupBlocked ? (
        <p className="feedback-public-error" role="alert">
          {t("feedback.public.popupBlocked")}
        </p>
      ) : null}
    </>
  );
}

function PublicCopyArea({
  copyId,
  onCopy,
  state,
}: {
  readonly copyId: string;
  readonly onCopy: () => void;
  readonly state: PublicActionState;
}): ReactNode {
  const t = useFeedbackTranslate();
  return (
    <div className="feedback-public-fallback">
      <p className="feedback-public-description">{t("feedback.preview.copyAvailable")}</p>
      {state.copyText === undefined ? null : (
        <CompleteCopy id={copyId} text={state.copyText} t={t} />
      )}
      <button
        className="feedback-primary-action feedback-public-copy-action"
        type="button"
        aria-busy={state.copyState === "busy" || undefined}
        aria-disabled={state.action !== "idle" || undefined}
        onClick={onCopy}
      >
        {state.copyState === "busy" ? t("feedback.public.copying") : t("feedback.public.copy")}
      </button>
      <PublicMessages state={state} t={t} />
    </div>
  );
}

export function FeedbackPublicHandoff({
  prepared,
  writeClipboard,
  revalidateReport,
  openPublic,
  onInvalidated,
}: {
  readonly prepared: PreparedFeedbackSnapshotV1;
  readonly writeClipboard: FeedbackClipboardWriter;
  readonly revalidateReport: FeedbackRevalidator;
  readonly openPublic: FeedbackPublicOpener;
  readonly onInvalidated: (outcome: FeedbackRevalidationOutcomeV1["outcome"]) => void;
}): ReactNode {
  const t = useFeedbackTranslate();
  const copyId = useId();
  const state = usePublicActionState(prepared.exactBodySha256);
  const deps = { prepared, revalidateReport, onInvalidated, state };
  return (
    <section className="feedback-public-handoff" aria-label={t("feedback.public.region")}>
      <p className="feedback-public-notice">{t("feedback.preview.publicNotice")}</p>
      <button
        className="feedback-primary-action"
        type="button"
        aria-busy={state.action === "open" || undefined}
        aria-disabled={state.action !== "idle" || undefined}
        onClick={() => void performOpen(deps, openPublic, reservationContent(t))}
      >
        {t("feedback.preview.publicLink")}
      </button>
      <PublicCopyArea
        copyId={copyId}
        onCopy={() => void performCopy(deps, writeClipboard)}
        state={state}
      />
    </section>
  );
}
