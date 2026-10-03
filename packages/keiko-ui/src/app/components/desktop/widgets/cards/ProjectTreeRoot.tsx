import type { ReactNode } from "react";
import { Icons } from "../../Icons";
import { useFilesWidgetTranslate } from "./files-widget-i18n";
import styles from "./FilesPresentation.module.css";

const FolderIcon = Icons.folder;
const ChevronIcon = Icons.chevronR;

interface ProjectTreeRootProps {
  readonly root: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}

export function ProjectTreeRoot({
  root,
  expanded,
  onToggle,
  children,
}: ProjectTreeRootProps): ReactNode {
  const t = useFilesWidgetTranslate();
  const name =
    root
      .replaceAll("\\", "/")
      .split("/")
      .reverse()
      .find((part) => part.length > 0) ?? root;
  return (
    <>
      <button
        type="button"
        role="treeitem"
        aria-selected={false}
        aria-level={1}
        aria-expanded={expanded}
        aria-label={t("tree.projectRoot", { name })}
        className={`tr-row ${styles.cmpProjectRoot}`}
        data-path=""
        onKeyDown={(event) => {
          if (
            (event.key === "ArrowRight" && !expanded) ||
            (event.key === "ArrowLeft" && expanded)
          ) {
            event.preventDefault();
            event.stopPropagation();
            onToggle();
          }
        }}
        onClick={onToggle}
      >
        <span className={styles.cmpCaret} data-open={expanded}>
          <ChevronIcon size={11} />
        </span>
        <FolderIcon size={14} />
        <span className={styles.cmpRootName}>{name}</span>
        <span className={styles.cmpRootPath} title={root}>
          {root}
        </span>
      </button>
      {expanded ? <fieldset className={styles.cmpProjectGroup}>{children}</fieldset> : null}
    </>
  );
}
