"use client";

// Issue #211 — Memory action buttons: approve / reject / correct / pin / unpin / archive / forget / delete.
// Governance gating: pin/unpin are mutually exclusive based on record.pinned.
// approve/reject only appear for proposed status.
//
// WCAG: every button ≥ 24px target size (lk-btn height is 30px).
// focus-visible rings via .lk-btn:focus-visible in globals.css.
// aria-busy on in-flight buttons. Destructive actions (forget/delete) gate through
// dialogs. aria-pressed NOT used here — these are action buttons, not toggles.

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts";
import {
  acceptMemoryProposal,
  archiveMemory,
  correctMemory,
  deleteMemory,
  pinMemory,
  rejectMemoryProposal,
  unpinMemory,
} from "@/lib/memory-api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { formatError } from "./format-error";
import { EditMemoryDialog } from "./EditMemoryDialog";
import { ForgetConfirmDialog } from "./ForgetConfirmDialog";

type BusyAction = "accept" | "reject" | "pin" | "unpin" | "archive" | null;

interface ProposedActionButtonsProps {
  readonly isProposed: boolean;
  readonly busy: BusyAction;
  readonly onAccept: () => void;
  readonly onReject: () => void;
  readonly t: I18nTranslate;
}

// Extracted from MemoryActions (SonarCloud S3776) — approve/reject only render for proposed
// memories; isolating the gate keeps it from nesting inside the parent return.
function ProposedActionButtons({
  isProposed,
  busy,
  onAccept,
  onReject,
  t,
}: ProposedActionButtonsProps): ReactNode {
  if (!isProposed) return null;
  return (
    <>
      <button
        type="button"
        className="lk-btn lk-btn-primary"
        aria-disabled={busy !== null}
        aria-busy={busy === "accept"}
        onClick={onAccept}
        aria-label={t("memoria.actions.approveProposal")}
      >
        {busy === "accept" ? t("memoria.approving") : t("memoria.approve")}
      </button>
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        aria-disabled={busy !== null}
        aria-busy={busy === "reject"}
        onClick={onReject}
        aria-label={t("memoria.actions.rejectProposal")}
      >
        {busy === "reject" ? t("memoria.rejecting") : t("memoria.reject")}
      </button>
    </>
  );
}

interface EditCorrectButtonsProps {
  readonly isForgotten: boolean;
  readonly busy: BusyAction;
  readonly onEdit: () => void;
  readonly onCorrect: () => void;
  readonly t: I18nTranslate;
}

// Extracted from MemoryActions (SonarCloud S3776) — edit/correct only render for non-forgotten
// memories.
function EditCorrectButtons({
  isForgotten,
  busy,
  onEdit,
  onCorrect,
  t,
}: EditCorrectButtonsProps): ReactNode {
  if (isForgotten) return null;
  return (
    <>
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        aria-disabled={busy !== null}
        onClick={onEdit}
        aria-label={t("memoria.actions.editLabel")}
      >
        {t("memoria.actions.edit")}
      </button>
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        aria-disabled={busy !== null}
        onClick={onCorrect}
        aria-label={t("memoria.actions.correctLabel")}
      >
        {t("memoria.actions.correct")}
      </button>
    </>
  );
}

interface PinToggleButtonProps {
  readonly isForgotten: boolean;
  readonly pinned: boolean;
  readonly busy: BusyAction;
  readonly onPin: () => void;
  readonly onUnpin: () => void;
  readonly t: I18nTranslate;
}

// Extracted from MemoryActions (SonarCloud S3776) — pin/unpin is a nested gate (non-forgotten,
// then pinned-vs-not) that previously nested a ternary inside a ternary in the parent return.
function PinToggleButton({
  isForgotten,
  pinned,
  busy,
  onPin,
  onUnpin,
  t,
}: PinToggleButtonProps): ReactNode {
  if (isForgotten) return null;
  if (pinned) {
    return (
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        aria-disabled={busy !== null}
        aria-busy={busy === "unpin"}
        onClick={onUnpin}
        aria-label={t("memoria.actions.unpinLabel")}
      >
        {busy === "unpin" ? t("memoria.actions.unpinning") : t("memoria.actions.unpin")}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="lk-btn lk-btn-ghost"
      aria-disabled={busy !== null}
      aria-busy={busy === "pin"}
      onClick={onPin}
      aria-label={t("memoria.actions.pinLabel")}
    >
      {busy === "pin" ? t("memoria.actions.pinning") : t("memoria.actions.pin")}
    </button>
  );
}

interface ArchiveButtonProps {
  readonly canArchive: boolean;
  readonly busy: BusyAction;
  readonly onArchive: () => void;
  readonly t: I18nTranslate;
}

// Extracted from MemoryActions (SonarCloud S3776) — archive only renders for statuses that are
// archivable.
function ArchiveButton({ canArchive, busy, onArchive, t }: ArchiveButtonProps): ReactNode {
  if (!canArchive) return null;
  return (
    <button
      type="button"
      className="lk-btn lk-btn-ghost"
      aria-disabled={busy !== null}
      aria-busy={busy === "archive"}
      onClick={onArchive}
      aria-label={t("memoria.actions.archiveLabel")}
    >
      {busy === "archive" ? t("memoria.archiving") : t("memoria.actions.archive")}
    </button>
  );
}

interface ForgetButtonProps {
  readonly isForgotten: boolean;
  readonly busy: BusyAction;
  readonly onForget: () => void;
  readonly t: I18nTranslate;
}

// Extracted from MemoryActions (SonarCloud S3776) — forget only renders for non-forgotten
// memories.
function ForgetButton({ isForgotten, busy, onForget, t }: ForgetButtonProps): ReactNode {
  if (isForgotten) return null;
  return (
    <button
      type="button"
      className="lk-btn lk-btn-danger"
      aria-disabled={busy !== null}
      onClick={onForget}
      aria-label={t("memoria.forget.title")}
    >
      {t("memoria.forgetMemory")}
    </button>
  );
}

interface StatusMessagesProps {
  readonly error: string | null;
  readonly notice: string | null;
}

// Extracted from MemoryActions (SonarCloud S3776) — the error/notice live-region pair.
function StatusMessages({ error, notice }: StatusMessagesProps): ReactNode {
  return (
    <>
      {error !== null ? (
        <p role="alert" aria-live="assertive" className="mc-action-error">
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" aria-live="polite" className="mc-action-notice">
          {notice}
        </p>
      ) : null}
    </>
  );
}

interface ActionDialogsProps {
  readonly record: MemoryRecord;
  readonly showEdit: boolean;
  readonly showCorrect: boolean;
  readonly showForget: boolean;
  readonly showDelete: boolean;
  readonly correctImpl: typeof correctMemory;
  readonly deleteImpl: typeof deleteMemory;
  readonly onEditSave: (updated: MemoryRecord) => void;
  readonly onEditClose: () => void;
  readonly onCorrectionSaved: (correction: MemoryRecord) => void;
  readonly onCorrectClose: () => void;
  readonly onForgetComplete: () => void;
  readonly onForgetClose: () => void;
  readonly onDeleteComplete: () => void;
  readonly onDeleteClose: () => void;
}

// Extracted from MemoryActions (SonarCloud S3776) — the four dialog-visibility gates, previously
// four separate ternaries at the bottom of the parent return.
function ActionDialogs({
  record,
  showEdit,
  showCorrect,
  showForget,
  showDelete,
  correctImpl,
  deleteImpl,
  onEditSave,
  onEditClose,
  onCorrectionSaved,
  onCorrectClose,
  onForgetComplete,
  onForgetClose,
  onDeleteComplete,
  onDeleteClose,
}: ActionDialogsProps): ReactNode {
  return (
    <>
      {showEdit ? (
        <EditMemoryDialog record={record} onSave={onEditSave} onClose={onEditClose} />
      ) : null}

      {showCorrect ? (
        <EditMemoryDialog
          mode="correct"
          record={record}
          correctMemoryImpl={correctImpl}
          onSave={onCorrectionSaved}
          onClose={onCorrectClose}
        />
      ) : null}

      {showForget ? (
        <ForgetConfirmDialog
          record={record}
          onComplete={onForgetComplete}
          onClose={onForgetClose}
        />
      ) : null}

      {showDelete ? (
        <ForgetConfirmDialog
          mode="delete"
          record={record}
          deleteMemoryImpl={deleteImpl}
          onComplete={onDeleteComplete}
          onClose={onDeleteClose}
        />
      ) : null}
    </>
  );
}

interface MemoryActionsProps {
  readonly record: MemoryRecord;
  readonly onRecordChange: (updated: MemoryRecord | null) => void;
  readonly acceptImpl?: typeof acceptMemoryProposal;
  readonly rejectImpl?: typeof rejectMemoryProposal;
  readonly pinImpl?: typeof pinMemory;
  readonly unpinImpl?: typeof unpinMemory;
  readonly archiveImpl?: typeof archiveMemory;
  readonly deleteImpl?: typeof deleteMemory;
  readonly correctImpl?: typeof correctMemory;
}

export function MemoryActions({
  record,
  onRecordChange,
  acceptImpl = acceptMemoryProposal,
  rejectImpl = rejectMemoryProposal,
  pinImpl = pinMemory,
  unpinImpl = unpinMemory,
  archiveImpl = archiveMemory,
  deleteImpl = deleteMemory,
  correctImpl = correctMemory,
}: MemoryActionsProps): ReactNode {
  const t = useTranslate();
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [showCorrect, setShowCorrect] = useState(false);
  const [showForget, setShowForget] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  // Buttons use aria-disabled + this guard instead of native disabled so the
  // pressed button keeps keyboard focus while busy (uiux-fix F005, PR #823 pattern).
  const run = useCallback(
    async (action: BusyAction, fn: () => Promise<void>): Promise<void> => {
      if (busy !== null) return;
      setBusy(action);
      setError(null);
      setNotice(null);
      try {
        await fn();
      } catch (err) {
        setError(formatError(err));
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const handleAccept = useCallback((): void => {
    void run("accept", async () => {
      const res = await acceptImpl(record.id as MemoryId);
      onRecordChange(res.memory);
    });
  }, [acceptImpl, onRecordChange, record.id, run]);

  const handleReject = useCallback((): void => {
    void run("reject", async () => {
      const res = await rejectImpl(record.id as MemoryId, "rejected by user in MemoriaViva");
      onRecordChange(res.memory);
    });
  }, [onRecordChange, record.id, rejectImpl, run]);

  const handlePin = useCallback((): void => {
    void run("pin", async () => {
      const res = await pinImpl(record.id as MemoryId);
      onRecordChange(res.memory);
    });
  }, [onRecordChange, pinImpl, record.id, run]);

  const handleUnpin = useCallback((): void => {
    void run("unpin", async () => {
      const res = await unpinImpl(record.id as MemoryId);
      onRecordChange(res.memory);
    });
  }, [onRecordChange, record.id, run, unpinImpl]);

  const handleArchive = useCallback((): void => {
    void run("archive", async () => {
      const res = await archiveImpl(record.id as MemoryId, "archived by user in MemoriaViva");
      onRecordChange(res.memory);
    });
  }, [archiveImpl, onRecordChange, record.id, run]);

  const handleCorrectionSaved = useCallback(
    (correction: MemoryRecord): void => {
      setShowCorrect(false);
      setNotice(t("memoria.actions.correctionSubmitted", { body: correction.body }));
    },
    [t],
  );

  const handleOpenEdit = useCallback((): void => {
    if (busy !== null) return;
    setError(null);
    setNotice(null);
    setShowEdit(true);
  }, [busy]);

  const handleOpenCorrect = useCallback((): void => {
    if (busy !== null) return;
    setError(null);
    setNotice(null);
    setShowCorrect(true);
  }, [busy]);

  const handleOpenForget = useCallback((): void => {
    if (busy !== null) return;
    setError(null);
    setNotice(null);
    setShowForget(true);
  }, [busy]);

  const handleOpenDelete = useCallback((): void => {
    if (busy !== null) return;
    setError(null);
    setNotice(null);
    setShowDelete(true);
  }, [busy]);

  const isProposed = record.status === "proposed";
  const canArchive =
    record.status === "accepted" ||
    record.status === "superseded" ||
    record.status === "conflicted" ||
    record.status === "expired";
  const isForgotten = record.status === "forgotten";

  return (
    <div className="mc-actions" role="group" aria-label={t("memoria.actions")}>
      <ProposedActionButtons
        isProposed={isProposed}
        busy={busy}
        onAccept={handleAccept}
        onReject={handleReject}
        t={t}
      />

      <EditCorrectButtons
        isForgotten={isForgotten}
        busy={busy}
        onEdit={handleOpenEdit}
        onCorrect={handleOpenCorrect}
        t={t}
      />

      <PinToggleButton
        isForgotten={isForgotten}
        pinned={record.pinned}
        busy={busy}
        onPin={handlePin}
        onUnpin={handleUnpin}
        t={t}
      />

      <ArchiveButton canArchive={canArchive} busy={busy} onArchive={handleArchive} t={t} />

      <ForgetButton isForgotten={isForgotten} busy={busy} onForget={handleOpenForget} t={t} />

      <button
        type="button"
        className="lk-btn lk-btn-danger"
        aria-disabled={busy !== null}
        onClick={handleOpenDelete}
        aria-label={t("memoria.delete.title")}
      >
        {t("memoria.deleteRecord")}
      </button>

      <StatusMessages error={error} notice={notice} />

      <ActionDialogs
        record={record}
        showEdit={showEdit}
        showCorrect={showCorrect}
        showForget={showForget}
        showDelete={showDelete}
        correctImpl={correctImpl}
        deleteImpl={deleteImpl}
        onEditSave={(updated) => {
          setShowEdit(false);
          onRecordChange(updated);
        }}
        onEditClose={() => {
          setShowEdit(false);
        }}
        onCorrectionSaved={handleCorrectionSaved}
        onCorrectClose={() => {
          setShowCorrect(false);
        }}
        onForgetComplete={() => {
          setShowForget(false);
          onRecordChange(null);
        }}
        onForgetClose={() => {
          setShowForget(false);
        }}
        onDeleteComplete={() => {
          setShowDelete(false);
          onRecordChange(null);
        }}
        onDeleteClose={() => {
          setShowDelete(false);
        }}
      />
    </div>
  );
}
