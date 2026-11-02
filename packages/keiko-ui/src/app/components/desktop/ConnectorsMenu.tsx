"use client";
import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { autonomyOptions } from "./autonomyOptions";
import { useContextDisclosure } from "./useContextDisclosure";
import type { McpServerChoice } from "./useMcpServerChoices";
import type { PodChoice } from "./useJiraPodChoices";
import styles from "./ConnectorsMenu.module.css";

interface ConnectorsMenuMode {
  readonly value: CodingWorkbenchMode;
  readonly ceiling: CodingWorkbenchMode;
  readonly onChange: (mode: CodingWorkbenchMode) => void;
}

export interface ConnectorsMenuProps {
  readonly servers: readonly McpServerChoice[];
  /** Absent: every enabled server is offered. */
  readonly selectedServers: readonly string[] | undefined;
  readonly pods: readonly PodChoice[];
  readonly boundPodId: string | undefined;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly failed: boolean;
  readonly mode?: ConnectorsMenuMode | undefined;
  readonly onServersChange: (selection: readonly string[] | null) => void;
  readonly onPodChange: (podId: string | null) => void;
  readonly onOpen?: () => void;
  readonly onManageServers?: (() => void) | undefined;
  readonly onManagePods?: (() => void) | undefined;
}

/**
 * The next server selection after one switch. Selecting every enabled server stores no selection
 * (`null`), so a server added centrally later is offered too; anything narrower is stored sorted.
 */
export function nextServerSelection(
  servers: readonly McpServerChoice[],
  selected: readonly string[] | undefined,
  name: string,
  on: boolean,
): readonly string[] | null {
  const known = servers.map((server) => server.name);
  const current = new Set((selected ?? known).filter((entry) => known.includes(entry)));
  if (on) current.add(name);
  else current.delete(name);
  if (known.every((entry) => current.has(entry))) return null;
  return [...current].sort((left, right) => left.localeCompare(right));
}

export function activeConnectorCount(
  servers: readonly McpServerChoice[],
  selected: readonly string[] | undefined,
  boundPodId: string | undefined,
): number {
  const chosen = selected === undefined ? undefined : new Set(selected);
  const mcp = servers.filter((server) => chosen?.has(server.name) ?? true).length;
  return mcp + (boundPodId === undefined ? 0 : 1);
}

function ConnectorsIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0V7ZM12 16v5" />
    </svg>
  );
}

function SwitchRow({
  label,
  checked,
  disabled,
  hint,
  tone,
  onToggle,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly hint?: string | undefined;
  readonly tone?: McpServerChoice["state"] | undefined;
  readonly onToggle: (next: boolean) => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={styles.cmpRow}
      disabled={disabled}
      onClick={() => onToggle(!checked)}
    >
      <span className={styles.cmpDot} data-tone={tone ?? "connected"} aria-hidden="true" />
      <span className={styles.cmpLabel}>{label}</span>
      {hint === undefined ? null : <span className={styles.cmpHint}>{hint}</span>}
      <span className={styles.cmpSwitch} aria-hidden="true" />
    </button>
  );
}

function SectionHeader({
  title,
  manageLabel,
  onManage,
}: {
  readonly title: string;
  readonly manageLabel: string;
  readonly onManage: (() => void) | undefined;
}): ReactNode {
  return (
    <div className={styles.cmpSectionHead}>
      <h3>{title}</h3>
      {onManage === undefined ? null : (
        <button
          type="button"
          className={styles.cmpManage}
          aria-label={`${title}: ${manageLabel}`}
          onClick={onManage}
        >
          {manageLabel}
        </button>
      )}
    </div>
  );
}

function ServerSection(props: ConnectorsMenuProps): ReactNode {
  const t = useTranslate();
  const chosen = props.selectedServers === undefined ? undefined : new Set(props.selectedServers);
  return (
    <section className={styles.cmpSection} aria-label={t("chat.connectors.mcp")}>
      <SectionHeader
        title={t("chat.connectors.mcp")}
        manageLabel={t("chat.connectors.manage")}
        onManage={props.onManageServers}
      />
      {props.servers.length === 0 && !props.loading ? (
        <p className={styles.cmpEmpty}>{t("chat.connectors.noServers")}</p>
      ) : null}
      {props.servers.map((server) => (
        <SwitchRow
          key={server.name}
          label={server.name}
          checked={chosen?.has(server.name) ?? true}
          disabled={props.busy}
          tone={server.state}
          hint={server.state === "attention" ? t("chat.connectors.attention") : undefined}
          onToggle={(on) =>
            props.onServersChange(
              nextServerSelection(props.servers, props.selectedServers, server.name, on),
            )
          }
        />
      ))}
    </section>
  );
}

function PodSection(props: ConnectorsMenuProps): ReactNode {
  const t = useTranslate();
  const unknownBound =
    props.boundPodId !== undefined && !props.pods.some((pod) => pod.id === props.boundPodId);
  return (
    <section className={styles.cmpSection} aria-label={t("chat.connectors.jira")}>
      <SectionHeader
        title={t("chat.connectors.jira")}
        manageLabel={t("chat.connectors.manage")}
        onManage={props.onManagePods}
      />
      {props.pods.length === 0 && !props.loading && !unknownBound ? (
        <p className={styles.cmpEmpty}>{t("chat.connectors.noPods")}</p>
      ) : null}
      {unknownBound && !props.loading ? (
        <SwitchRow
          label={t("chat.jira.podUnavailable")}
          checked
          disabled={props.busy}
          tone="attention"
          onToggle={() => props.onPodChange(null)}
        />
      ) : null}
      {props.pods.map((pod) => {
        const bound = pod.id === props.boundPodId;
        return (
          <SwitchRow
            key={pod.id}
            label={pod.name}
            checked={bound}
            disabled={props.busy || (!pod.ready && !bound)}
            tone={pod.ready ? "connected" : "attention"}
            hint={pod.ready ? undefined : t("chat.jira.verifyRequired")}
            onToggle={(on) => props.onPodChange(on ? pod.id : null)}
          />
        );
      })}
    </section>
  );
}

function ModeSection({
  mode,
  busy,
}: {
  readonly mode: ConnectorsMenuMode;
  readonly busy: boolean;
}): ReactNode {
  const t = useTranslate();
  return (
    <section className={styles.cmpSection} aria-label={t("chat.connectors.access")}>
      <div className={styles.cmpSectionHead}>
        <h3>{t("chat.connectors.access")}</h3>
      </div>
      <div role="radiogroup" aria-label={t("chat.connectors.access")} className={styles.cmpModes}>
        {autonomyOptions(t, undefined, mode.ceiling).map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === mode.value}
            className={styles.cmpMode}
            disabled={busy || option.disabled}
            onClick={() => mode.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function ConnectorsPanelBody(props: ConnectorsMenuProps): ReactNode {
  const t = useTranslate();
  return (
    <>
      <ServerSection {...props} />
      <PodSection {...props} />
      {props.mode === undefined ? null : <ModeSection mode={props.mode} busy={props.busy} />}
      {props.failed ? (
        <p role="alert" className={styles.cmpError}>
          {t("chat.connectors.failed")}
        </p>
      ) : null}
    </>
  );
}

/**
 * The per-Chat and per-run connector selection (owner decision 2026-11-02): one switch per
 * centrally configured MCP server and per Jira Pod. What is switched off is not offered to the
 * model at all: no tools, no context.
 */
export function ConnectorsMenu(props: ConnectorsMenuProps): ReactNode {
  const t = useTranslate();
  const id = useId();
  const disclosure = useContextDisclosure();
  const count = activeConnectorCount(props.servers, props.selectedServers, props.boundPodId);
  const label = t("chat.connectors.title");
  return (
    <div className={styles.cmpRoot}>
      <button
        type="button"
        ref={disclosure.trigger}
        className={`${styles.cmpTrigger} ui-tip`}
        aria-label={count === 0 ? label : t("chat.connectors.active", { count })}
        data-tip={disclosure.open ? undefined : label}
        aria-controls={disclosure.open ? id : undefined}
        aria-expanded={disclosure.open}
        onClick={() => {
          if (!disclosure.open) props.onOpen?.();
          disclosure.toggle();
        }}
      >
        <ConnectorsIcon />
        {count === 0 ? null : <span className={styles.cmpCount}>{count}</span>}
      </button>
      {disclosure.open
        ? createPortal(
            <section
              ref={disclosure.panel}
              id={id}
              className={styles.cmpPanel}
              style={disclosure.position}
              aria-label={label}
              aria-busy={props.loading || props.busy}
            >
              <ConnectorsPanelBody {...props} />
            </section>,
            document.body,
          )
        : null}
    </div>
  );
}
