"use client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type SubmitEvent,
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
  readonly form: RefObject<HTMLFormElement | null>;
  readonly value: string;
  readonly error: WidgetMessageKey | undefined;
  readonly setValue: (value: string) => void;
  readonly save: (event: SubmitEvent) => void;
  readonly cancel: () => void;
}
function useUpdateEntry({ connector, mode, busy, submit, close, unconfirmed }: Props): Entry {
  const form = useRef<HTMLFormElement>(null);
  const [value, setValue] = useState(mode === "rename" ? connector.displayName : "");
  const [error, setError] = useState<WidgetMessageKey>();
  useEffect(() => {
    form.current?.querySelector("input")?.focus();
  }, []);
  const save = (event: SubmitEvent): void => {
    event.preventDefault();
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
    form,
    value,
    setValue,
    error,
    save,
    cancel: (): void => {
      setValue("");
      close();
    },
  };
}
function UpdateButtons({
  mode,
  busy,
  close,
  refresh,
  unconfirmed,
}: Pick<Props, "mode" | "busy" | "close" | "refresh" | "unconfirmed">): ReactNode {
  const t = useTranslate();
  return (
    <div className="acx-actions">
      <button type="submit" className="lk-btn lk-btn-primary" disabled={busy || unconfirmed}>
        {t(
          busy
            ? "atlassianConnectors.live.saving"
            : mode === "rename"
              ? "atlassianConnectors.live.saveName"
              : "atlassianConnectors.live.saveToken",
        )}
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
  return (
    <form
      ref={entry.form}
      className="acx-form"
      aria-label={t(
        mode === "rename"
          ? "atlassianConnectors.live.renameTitle"
          : "atlassianConnectors.live.rotateTitle",
      )}
      onSubmit={entry.save}
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
        errorKey={entry.error}
        disabled={busy}
        autoComplete="off"
      />
      <UpdateButtons
        mode={mode}
        busy={busy}
        close={entry.cancel}
        refresh={props.refresh}
        unconfirmed={props.unconfirmed}
      />
    </form>
  );
}
