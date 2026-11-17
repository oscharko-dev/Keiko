"use client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { AtlassianLivePodUpdateRequest } from "@oscharko-dev/keiko-contracts";
import { isSafeAtlassianDisplayName } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  useOptionalWidgetTranslate as useTranslate,
  type WidgetMessageKey,
} from "@/lib/optional-widget-i18n";
import type { AtlassianConnectorMetadata } from "@/lib/atlassian-connectors-api";
import { TextField } from "./TextField";
import type { ConnectorEditMode } from "./useConnectorCard";
interface Props {
  readonly connector: AtlassianConnectorMetadata;
  readonly mode: ConnectorEditMode;
  readonly busy: boolean;
  readonly submit: (patch: AtlassianLivePodUpdateRequest) => void;
  readonly close: () => void;
  readonly refresh: () => void;
  readonly unconfirmed: boolean;
}
interface Entry {
  readonly region: RefObject<HTMLDivElement | null>;
  readonly value: string;
  readonly error: WidgetMessageKey | undefined;
  readonly setValue: (value: string) => void;
  readonly save: () => void;
  readonly saveOnEnter: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly cancel: () => void;
}

const IME_PROCESS_KEY_CODE = 229;

function useUpdateEntry({ connector, mode, busy, submit, close, unconfirmed }: Props): Entry {
  const region = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(mode === "rename" ? connector.displayName : "");
  const [error, setError] = useState<WidgetMessageKey>();
  useEffect(() => {
    region.current?.querySelector("input")?.focus();
  }, []);
  const save = (): void => {
    if (busy || unconfirmed) return;
    const valid = mode === "rename" ? isSafeAtlassianDisplayName(value.trim()) : value.length > 0;
    if (!valid) {
      setError(
        mode === "rename"
          ? "atlassianConnectors.validation.displayName"
          : "atlassianConnectors.validation.token",
      );
      return;
    }
    const patch = mode === "rename" ? { displayName: value.trim() } : { apiToken: value };
    if (mode === "rotate") setValue("");
    submit({ expectedGeneration: connector.generation ?? 1, ...patch });
  };
  return {
    region,
    value,
    setValue,
    error,
    save,
    saveOnEnter: (event): void => {
      // WebKit can dispatch the composition-confirming Enter after compositionend (#324380).
      if (
        event.key !== "Enter" ||
        event.defaultPrevented ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === IME_PROCESS_KEY_CODE
      )
        return;
      event.preventDefault();
      save();
    },
    cancel: (): void => {
      setValue("");
      close();
    },
  };
}
function UpdateButtons({
  mode,
  busy,
  save,
  close,
  refresh,
  unconfirmed,
}: Pick<Props, "mode" | "busy" | "close" | "refresh" | "unconfirmed"> & {
  readonly save: () => void;
}): ReactNode {
  const t = useTranslate();
  const saveLabel =
    mode === "rename" ? "atlassianConnectors.live.saveName" : "atlassianConnectors.live.saveToken";
  // One state text at a time: a replaced token is stored and verified by the same request, and the
  // card's chip already says so, so the button names that state instead of a second one.
  const busyLabel =
    mode === "rename" ? "atlassianConnectors.live.saving" : "atlassianConnectors.verify.verifying";
  return (
    <div className="acx-actions">
      <button
        type="button"
        className="lk-btn lk-btn-primary"
        disabled={busy || unconfirmed}
        onClick={save}
      >
        {t(busy ? busyLabel : saveLabel)}
      </button>
      {unconfirmed ? (
        <button type="button" className="lk-btn" disabled={busy} onClick={refresh}>
          {t("atlassianConnectors.live.refresh")}
        </button>
      ) : null}
      <button type="button" className="lk-btn" disabled={busy} onClick={close}>
        {t("atlassianConnectors.add.cancel")}
      </button>
    </div>
  );
}
export function ConnectorUpdateForm(props: Props): ReactNode {
  const t = useTranslate();
  const id = useId();
  const { mode, busy } = props;
  const entry = useUpdateEntry(props);
  // Keep the masked API token outside a native browser password form.
  return (
    <div
      ref={entry.region}
      className="acx-form"
      role="form"
      aria-label={t(
        mode === "rename"
          ? "atlassianConnectors.live.renameTitle"
          : "atlassianConnectors.live.rotateTitle",
      )}
    >
      {mode === "rotate" ? (
        <p className="acx-hint">{t("atlassianConnectors.live.rotateHint")}</p>
      ) : null}
      <TextField
        id={id}
        labelKey={
          mode === "rename"
            ? "atlassianConnectors.add.displayName"
            : "atlassianConnectors.live.newToken"
        }
        type={mode === "rename" ? "text" : "password"}
        value={entry.value}
        onChange={entry.setValue}
        onKeyDown={entry.saveOnEnter}
        errorKey={entry.error}
        disabled={busy}
        autoComplete="off"
      />
      <UpdateButtons
        mode={mode}
        busy={busy}
        save={entry.save}
        close={entry.cancel}
        refresh={props.refresh}
        unconfirmed={props.unconfirmed}
      />
    </div>
  );
}
