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
import { useTranslate } from "@/lib/i18n";
import { formatError } from "./format-error";
import { EditMemoryDialog } from "./EditMemoryDialog";
import { ForgetConfirmDialog } from "./ForgetConfirmDialog";

type BusyAction = "accept" | "reject" | "pin" | "unpin" | "archive" | null;

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

  const isProposed = record.status === "proposed";
  const canArchive =
    record.status === "accepted" ||
    record.status === "superseded" ||
    record.status === "conflicted" ||
    record.status === "expired";
  const isForgotten = record.status === "forgotten";

  return (
    <div className="mc-actions" role="group" aria-label={t("memoria.actions")}>
      {isProposed ? (
        <>
          <button
            type="button"
            className="lk-btn lk-btn-primary"
            aria-disabled={busy !== null}
            aria-busy={busy === "accept"}
            onClick={handleAccept}
            aria-label={t("memoria.actions.approveProposal")}
          >
            {busy === "accept" ? t("memoria.approving") : t("memoria.approve")}
          </button>
          <button
            type="button"
            className="lk-btn lk-btn-ghost"
            aria-disabled={busy !== null}
            aria-busy={busy === "reject"}
            onClick={handleReject}
            aria-label={t("memoria.actions.rejectProposal")}
          >
            {busy === "reject" ? t("memoria.rejecting") : t("memoria.reject")}
          </button>
        </>
      ) : null}

      {!isForgotten ? (
        <>
          <button
            type="button"
            className="lk-btn lk-btn-ghost"
            aria-disabled={busy !== null}
            onClick={() => {
              if (busy !== null) return;
              setError(null);
              setNotice(null);
              setShowEdit(true);
            }}
            aria-label={t("memoria.actions.editLabel")}
          >
            {t("memoria.actions.edit")}
          </button>
          <button
            type="button"
            className="lk-btn lk-btn-ghost"
            aria-disabled={busy !== null}
            onClick={() => {
              if (busy !== null) return;
              setError(null);
              setNotice(null);
              setShowCorrect(true);
            }}
            aria-label={t("memoria.actions.correctLabel")}
          >
            {t("memoria.actions.correct")}
          </button>
        </>
      ) : null}

      {!isForgotten ? (
        record.pinned ? (
          <button
            type="button"
            className="lk-btn lk-btn-ghost"
            aria-disabled={busy !== null}
            aria-busy={busy === "unpin"}
            onClick={handleUnpin}
            aria-label={t("memoria.actions.unpinLabel")}
          >
            {busy === "unpin" ? t("memoria.actions.unpinning") : t("memoria.actions.unpin")}
          </button>
        ) : (
          <button
            type="button"
            className="lk-btn lk-btn-ghost"
            aria-disabled={busy !== null}
            aria-busy={busy === "pin"}
            onClick={handlePin}
            aria-label={t("memoria.actions.pinLabel")}
          >
            {busy === "pin" ? t("memoria.actions.pinning") : t("memoria.actions.pin")}
          </button>
        )
      ) : null}

      {canArchive ? (
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          aria-disabled={busy !== null}
          aria-busy={busy === "archive"}
          onClick={handleArchive}
          aria-label={t("memoria.actions.archiveLabel")}
        >
          {busy === "archive" ? t("memoria.archiving") : t("memoria.actions.archive")}
        </button>
      ) : null}

      {!isForgotten ? (
        <button
          type="button"
          className="lk-btn lk-btn-danger"
          aria-disabled={busy !== null}
          onClick={() => {
            if (busy !== null) return;
            setError(null);
            setNotice(null);
            setShowForget(true);
          }}
          aria-label={t("memoria.forget.title")}
        >
          {t("memoria.forgetMemory")}
        </button>
      ) : null}

      <button
        type="button"
        className="lk-btn lk-btn-danger"
        aria-disabled={busy !== null}
        onClick={() => {
          if (busy !== null) return;
          setError(null);
          setNotice(null);
          setShowDelete(true);
        }}
        aria-label={t("memoria.delete.title")}
      >
        {t("memoria.deleteRecord")}
      </button>

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

      {showEdit ? (
        <EditMemoryDialog
          record={record}
          onSave={(updated) => {
            setShowEdit(false);
            onRecordChange(updated);
          }}
          onClose={() => {
            setShowEdit(false);
          }}
        />
      ) : null}

      {showCorrect ? (
        <EditMemoryDialog
          mode="correct"
          record={record}
          correctMemoryImpl={correctImpl}
          onSave={handleCorrectionSaved}
          onClose={() => {
            setShowCorrect(false);
          }}
        />
      ) : null}

      {showForget ? (
        <ForgetConfirmDialog
          record={record}
          onComplete={() => {
            setShowForget(false);
            onRecordChange(null);
          }}
          onClose={() => {
            setShowForget(false);
          }}
        />
      ) : null}

      {showDelete ? (
        <ForgetConfirmDialog
          mode="delete"
          record={record}
          deleteMemoryImpl={deleteImpl}
          onComplete={() => {
            setShowDelete(false);
            onRecordChange(null);
          }}
          onClose={() => {
            setShowDelete(false);
          }}
        />
      ) : null}
    </div>
  );
}
