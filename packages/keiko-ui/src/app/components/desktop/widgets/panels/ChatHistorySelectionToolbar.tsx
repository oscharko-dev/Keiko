import { useEffect, type ReactNode, type RefObject } from "react";
import { useTranslate } from "@/lib/i18n";
import styles from "./ChatHistorySelection.module.css";

interface SelectAllChatsProps {
  readonly checkboxRef: RefObject<HTMLInputElement | null>;
  readonly visibleCount: number;
  readonly selectedCount: number;
  readonly busy: boolean;
  readonly toggleAll: () => void;
  readonly clear: () => void;
}

interface DeleteSelectedChatsProps {
  readonly selectedCount: number;
  readonly busy: boolean;
  readonly clear: () => void;
  readonly removeSelected: () => void;
}

type ChatHistorySelectionToolbarProps = SelectAllChatsProps & DeleteSelectedChatsProps;

function SelectAllChats(props: SelectAllChatsProps): ReactNode {
  const t = useTranslate();
  const { checkboxRef, visibleCount, selectedCount, busy, toggleAll } = props;
  useEffect((): void => {
    if (checkboxRef.current !== null) {
      checkboxRef.current.indeterminate = selectedCount > 0 && selectedCount < visibleCount;
    }
  }, [checkboxRef, selectedCount, visibleCount]);
  return (
    <label className={styles.cmpSelectAll}>
      <input
        ref={checkboxRef}
        type="checkbox"
        className={styles.cmpCheckbox}
        checked={visibleCount > 0 && selectedCount === visibleCount}
        disabled={busy || visibleCount === 0}
        aria-label={t("chat.history.selection.allDisplayed")}
        onChange={toggleAll}
        onKeyDown={(event): void => {
          if (event.key === "Escape" && !busy) props.clear();
        }}
      />
      {t("chat.history.selection.all")}
    </label>
  );
}

function DeleteSelectedChats(props: DeleteSelectedChatsProps): ReactNode {
  const t = useTranslate();
  const { busy, selectedCount, removeSelected } = props;
  return (
    <button
      type="button"
      className="lk-btn lk-btn-danger"
      disabled={busy || selectedCount === 0}
      title={t("chat.history.selection.permanent")}
      onClick={removeSelected}
      onKeyDown={(event): void => {
        if (event.key === "Escape" && !busy) props.clear();
      }}
    >
      {busy
        ? t("chat.history.selection.deleting")
        : t("chat.history.selection.delete", { count: selectedCount })}
    </button>
  );
}

export function ChatHistorySelectionToolbar({
  checkboxRef,
  visibleCount,
  selectedCount,
  busy,
  toggleAll,
  clear,
  removeSelected,
}: ChatHistorySelectionToolbarProps): ReactNode {
  const props = {
    checkboxRef,
    visibleCount,
    selectedCount,
    busy,
    toggleAll,
    clear,
    removeSelected,
  };
  return (
    <div className={styles.cmpToolbar}>
      <SelectAllChats {...props} />
      <DeleteSelectedChats {...props} />
    </div>
  );
}
