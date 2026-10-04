import {
  useOptionalWidgetTranslate as useTranslate,
  type OptionalWidgetTranslate as I18nTranslate,
} from "@/lib/optional-widget-i18n";
import type { ReactNode } from "react";

import { Icons } from "../../Icons";
import type { FilesNavigation } from "./useFilesNavigation";
import styles from "./FilesRootBar.module.css";

const BackIcon = Icons.back;
const UpIcon = Icons.arrowUp;
const FolderIcon = Icons.folder;

interface RootControlsProps {
  readonly navigation: FilesNavigation;
  readonly canGoUp: boolean;
  readonly onUp: () => void;
  readonly onRoot: () => void;
}
interface RootPathProps {
  readonly opening?: boolean;
  readonly draft: string;
  readonly editable: boolean;
  readonly onDraftChange: (value: string) => void;
}
interface FilesRootBarProps extends RootControlsProps, RootPathProps {
  readonly showNavigation?: boolean;
  readonly onOpen: (value: string) => void;
}

interface RootAction {
  readonly key: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly run: () => void;
  readonly icon: ReactNode;
}

function rootActions(props: RootControlsProps, t: I18nTranslate): readonly RootAction[] {
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

function RootControls({ navigation, canGoUp, onUp, onRoot }: RootControlsProps): ReactNode {
  const t = useTranslate();
  return (
    <div className={styles.cmpControls}>
      {rootActions({ navigation, canGoUp, onUp, onRoot }, t).map((action) => (
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

function RootPath({ opening, draft, editable, onDraftChange }: RootPathProps): ReactNode {
  const t = useTranslate();
  return (
    <div className={styles.cmpPath}>
      <input
        type="text"
        className="files-root-input mono"
        aria-label={t(
          editable ? "filesWidget.rootBar.pathLabel" : "filesWidget.navigation.currentPath",
        )}
        placeholder={t("filesWidget.rootBar.pathPlaceholder")}
        title={draft}
        spellCheck={false}
        value={draft}
        readOnly={!editable}
        disabled={opening}
        onChange={(event): void => onDraftChange(event.target.value)}
      />
      {editable ? (
        <button
          type="submit"
          disabled={opening}
          className="files-root-open"
          title={t("filesWidget.rootBar.openFolderTitle")}
        >
          {t(opening ? "editor.empty.opening" : "filesWidget.rootBar.open")}
        </button>
      ) : null}
    </div>
  );
}

export function FilesRootBar({
  showNavigation,
  opening,
  navigation,
  draft,
  editable,
  canGoUp,
  onDraftChange,
  onOpen,
  onUp,
  onRoot,
}: FilesRootBarProps): ReactNode {
  const t = useTranslate();
  return (
    <fieldset
      className={styles.cmpRootGroup}
      aria-label={t("filesWidget.rootBar.label")}
      aria-busy={opening === true}
    >
      <form
        className={`files-root-bar ${styles.cmpRootBar}`}
        data-navigation={showNavigation !== false}
        onSubmit={(event): void => {
          event.preventDefault();
          if (editable && opening !== true) onOpen(draft);
        }}
      >
        {showNavigation !== false ? (
          <RootControls navigation={navigation} canGoUp={canGoUp} onUp={onUp} onRoot={onRoot} />
        ) : null}
        <RootPath
          {...(opening === undefined ? {} : { opening })}
          draft={draft}
          editable={editable}
          onDraftChange={onDraftChange}
        />
      </form>
    </fieldset>
  );
}
