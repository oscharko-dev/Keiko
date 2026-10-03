import type { ReactNode } from "react";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { Icons } from "../../Icons";
import type { FilesNavigation } from "./useFilesNavigation";
import styles from "./FilesRootBar.module.css";

const BackIcon = Icons.back;
const UpIcon = Icons.arrowUp;
const FolderIcon = Icons.folder;

interface FilesRootBarProps {
  readonly showNavigation?: boolean;
  readonly opening?: boolean;
  readonly navigation: FilesNavigation;
  readonly draft: string;
  readonly editable: boolean;
  readonly canGoUp: boolean;
  readonly onDraftChange: (value: string) => void;
  readonly onOpen: (value: string) => void;
  readonly onUp: () => void;
  readonly onRoot: () => void;
}

interface RootAction {
  readonly key: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly run: () => void;
  readonly icon: ReactNode;
}

function rootActions(props: FilesRootBarProps, t: I18nTranslate): readonly RootAction[] {
  return [
    {
      key: "back",
      label: t("filesWidget.navigation.back"),
      disabled: !props.navigation.canGoBack,
      run: props.navigation.back,
      icon: <BackIcon size={13} />,
    },
    {
      key: "forward",
      label: t("filesWidget.navigation.forward"),
      disabled: !props.navigation.canGoForward,
      run: props.navigation.forward,
      icon: (
        <span className={styles.cmpForward}>
          <BackIcon size={13} />
        </span>
      ),
    },
    {
      key: "up",
      label: t("filesWidget.rootBar.openParent"),
      disabled: !props.canGoUp,
      run: props.onUp,
      icon: <UpIcon size={13} />,
    },
    {
      key: "root",
      label: t("filesWidget.navigation.root"),
      disabled: props.navigation.path === null,
      run: props.onRoot,
      icon: <FolderIcon size={13} />,
    },
  ];
}

function RootControls(props: FilesRootBarProps): ReactNode {
  const t = useTranslate();
  return (
    <div className={styles.cmpControls}>
      {rootActions(props, t).map((action) => (
        <button
          key={action.key}
          type="button"
          className="files-root-up"
          title={action.label}
          aria-label={action.label}
          disabled={action.disabled}
          onClick={action.run}
        >
          {action.icon}
        </button>
      ))}
    </div>
  );
}

function RootPath(props: FilesRootBarProps): ReactNode {
  const t = useTranslate();
  return (
    <div className={styles.cmpPath}>
      <input
        type="text"
        className="files-root-input mono"
        aria-label={t(
          props.editable ? "filesWidget.rootBar.pathLabel" : "filesWidget.navigation.currentPath",
        )}
        placeholder={t("filesWidget.rootBar.pathPlaceholder")}
        title={props.draft}
        spellCheck={false}
        value={props.draft}
        readOnly={!props.editable}
        disabled={props.opening}
        onChange={(event): void => props.onDraftChange(event.target.value)}
      />
      {props.editable ? (
        <button
          type="submit"
          disabled={props.opening}
          className="files-root-open"
          title={t("filesWidget.rootBar.openFolderTitle")}
        >
          {t(props.opening ? "editor.empty.opening" : "filesWidget.rootBar.open")}
        </button>
      ) : null}
    </div>
  );
}

export function FilesRootBar(props: FilesRootBarProps): ReactNode {
  const t = useTranslate();
  return (
    <form
      className={`files-root-bar ${styles.cmpRootBar}`}
      data-navigation={props.showNavigation !== false}
      aria-label={t("filesWidget.rootBar.label")}
      aria-busy={props.opening === true}
      onSubmit={(event): void => {
        event.preventDefault();
        if (props.editable && props.opening !== true) props.onOpen(props.draft);
      }}
    >
      {props.showNavigation !== false ? <RootControls {...props} /> : null}
      <RootPath {...props} />
    </form>
  );
}
