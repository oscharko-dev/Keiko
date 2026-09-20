"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  CodingWorkbenchContextUsage,
  CodingWorkbenchContextUsageBreakdown,
} from "@oscharko-dev/keiko-contracts";
import { TaskWorkspaceManager } from "../../TaskWorkspaceManager";
import { useOptionalActiveWorkspace } from "../../context/ActiveWorkspaceContext";
import { Icons } from "../../Icons";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchWindow.module.css";

const InfoIcon = Icons.info;

export interface CodingWorkbenchInfoFact {
  readonly label: string;
  readonly value: string;
  readonly primary?: boolean;
  readonly tone?: "default" | "warning" | undefined;
  readonly mode?: string | undefined;
}

function useInformationPopover(): {
  readonly open: boolean;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly toggle: () => void;
  readonly close: () => void;
} {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback((): void => setOpen(false), []);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return (): void => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);
  return { open, rootRef, toggle: () => setOpen((value) => !value), close };
}

function InformationFacts({
  facts,
}: {
  readonly facts: readonly CodingWorkbenchInfoFact[];
}): ReactNode {
  return (
    <dl className={styles.cmpInfoGrid}>
      {facts.map((fact) => (
        <div
          key={fact.label}
          className={styles.cmpInfoRow}
          data-tone={fact.tone ?? "default"}
          {...(fact.mode === undefined ? {} : { "data-mode": fact.mode })}
        >
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function OptionalTaskWorkspaceManager(): ReactNode {
  return useOptionalActiveWorkspace() === null ? null : <TaskWorkspaceManager />;
}

function TaskWorkspaceLocation(): ReactNode {
  const workspace = useOptionalActiveWorkspace();
  const t = useCodingWorkbenchTranslate();
  const [visible, setVisible] = useState(false);
  const id = useId();
  const path = workspace?.activeBinding?.activeRoot;
  if (path === undefined) return null;
  return (
    <div className={styles.cmpWorkspaceLocation}>
      <button
        type="button"
        className={styles.cmpInfoTrigger}
        aria-expanded={visible}
        aria-controls={visible ? id : undefined}
        onClick={() => {
          setVisible(!visible);
          reportClientDiagnostic("[keiko] coding workbench workspace location toggled");
        }}
      >
        {t("codingWorkbench.history.location")}
      </button>
      {visible ? <code id={id}>{path}</code> : null}
    </div>
  );
}

interface ContextSegment {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
  readonly tone: string;
}

function measuredBreakdown(
  breakdown: CodingWorkbenchContextUsageBreakdown | undefined,
  usedInputTokens: number,
  t: ReturnType<typeof useCodingWorkbenchTranslate>,
): readonly ContextSegment[] | null {
  if (breakdown === undefined) return null;
  const segments: ContextSegment[] = [
    {
      key: "messages",
      label: t("codingWorkbench.info.context.messages"),
      tokens: breakdown.conversationMessagesTokens ?? 0,
      tone: "messages",
    },
    {
      key: "system",
      label: t("codingWorkbench.info.context.system"),
      tokens: breakdown.systemContextTokens ?? 0,
      tone: "system",
    },
    {
      key: "tools",
      label: t("codingWorkbench.info.context.tools"),
      tokens: breakdown.toolDefinitionTokens ?? 0,
      tone: "tools",
    },
    {
      key: "adjustment",
      label: t("codingWorkbench.info.context.adjustment"),
      tokens: breakdown.providerAccountingAdjustmentTokens ?? 0,
      tone: "adjustment",
    },
  ].filter((segment) => segment.tokens > 0);
  return segments.reduce((sum, segment) => sum + segment.tokens, 0) === usedInputTokens
    ? segments
    : null;
}

function contextSegments(
  usage: Extract<CodingWorkbenchContextUsage, { readonly state: "available" }>,
  t: ReturnType<typeof useCodingWorkbenchTranslate>,
): readonly ContextSegment[] {
  const used = measuredBreakdown(usage.breakdown, usage.usedInputTokens, t) ?? [
    {
      key: "used",
      label: t("codingWorkbench.info.context.used"),
      tokens: usage.usedInputTokens,
      tone: "messages",
    },
  ];
  return [
    ...used,
    {
      key: "reserve",
      label: t("codingWorkbench.info.context.reserve"),
      tokens: usage.reservedOutputTokens,
      tone: "reserve",
    },
    {
      key: "free",
      label: t("codingWorkbench.info.context.free"),
      tokens: usage.freeTokens,
      tone: "free",
    },
  ];
}

function tokenText(tokens: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(tokens);
}

function ContextLegend(props: {
  readonly capacity: number;
  readonly segments: readonly ContextSegment[];
}): ReactNode {
  return (
    <dl className={styles.cmpContextLegend}>
      {props.segments.map((segment) => (
        <div key={segment.key}>
          <dt>
            <span className={styles.cmpContextSwatch} data-tone={segment.tone} />
            {segment.label}
          </dt>
          <dd>
            {tokenText(segment.tokens)}{" "}
            <span>{((segment.tokens / props.capacity) * 100).toFixed(1)}%</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ContextUsageAvailable(props: {
  readonly usage: Extract<CodingWorkbenchContextUsage, { readonly state: "available" }>;
  readonly titleId: string;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const { usage } = props;
  const segments = contextSegments(usage, t);
  const percent = Math.min(100, (usage.usedInputTokens / usage.capacityTokens) * 100);
  return (
    <section className={styles.cmpContextUsage} aria-labelledby={props.titleId}>
      <div className={styles.cmpContextUsageHeading}>
        <h4 id={props.titleId}>{t("codingWorkbench.info.contextWindow")}</h4>
        <span>
          {tokenText(usage.usedInputTokens)} / {tokenText(usage.capacityTokens)} (
          {percent.toFixed(1)}%)
        </span>
      </div>
      <div
        className={styles.cmpContextMeter}
        role="img"
        aria-label={t("codingWorkbench.info.context.meter", { percent: percent.toFixed(1) })}
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            data-tone={segment.tone}
            style={{ inlineSize: `${String((segment.tokens / usage.capacityTokens) * 100)}%` }}
          />
        ))}
      </div>
      <ContextLegend capacity={usage.capacityTokens} segments={segments} />
      <ContextUsageSummary usage={usage} />
    </section>
  );
}

function ContextUsageSummary(props: {
  readonly usage: Extract<CodingWorkbenchContextUsage, { readonly state: "available" }>;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const { usage } = props;
  return (
    <dl className={styles.cmpContextSummary}>
      <div>
        <dt>{t("codingWorkbench.info.context.current")}</dt>
        <dd>{tokenText(usage.usedInputTokens)}</dd>
      </div>
      <div>
        <dt>{t("codingWorkbench.info.context.cumulative")}</dt>
        <dd>{tokenText(usage.cumulativePromptTokens)}</dd>
      </div>
      {usage.runPromptBudgetTokens === undefined ? null : (
        <div>
          <dt>{t("codingWorkbench.info.context.runBudget")}</dt>
          <dd>{tokenText(usage.runPromptBudgetTokens)}</dd>
        </div>
      )}
      {usage.compaction === undefined ? null : (
        <div>
          <dt>{t("codingWorkbench.info.context.compactions")}</dt>
          <dd>{tokenText(usage.compaction.count)}</dd>
        </div>
      )}
    </dl>
  );
}

function ContextUsagePanel(props: {
  readonly usage: CodingWorkbenchContextUsage | undefined;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const titleId = useId();
  if (props.usage?.state === "available") {
    return <ContextUsageAvailable usage={props.usage} titleId={titleId} />;
  }
  return (
    <section className={styles.cmpContextUsage} aria-labelledby={titleId}>
      <h4 id={titleId}>{t("codingWorkbench.info.contextWindow")}</h4>
      <p className={styles.cmpContextUnavailable}>{t("codingWorkbench.info.notReported")}</p>
    </section>
  );
}

interface InfoPanelProps {
  readonly facts: readonly CodingWorkbenchInfoFact[];
  readonly contextUsage?: CodingWorkbenchContextUsage | undefined;
}

export function CodingWorkbenchInfoPanel(props: InfoPanelProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const popover = useInformationPopover();
  return (
    <div ref={popover.rootRef} className={styles.cmpInfoBar}>
      <button
        type="button"
        className={styles.cmpInfoTrigger}
        aria-label={t("codingWorkbench.info.open")}
        aria-expanded={popover.open}
        aria-haspopup="dialog"
        onClick={popover.toggle}
      >
        <InfoIcon size={16} />
        <span>{t("codingWorkbench.info.label")}</span>
      </button>
      {popover.open ? (
        <dialog open aria-label={t("codingWorkbench.info.title")} className={styles.cmpInfoPopover}>
          <header className={styles.cmpInfoHeader}>
            <h3>{t("codingWorkbench.info.label")}</h3>
          </header>
          <InformationFacts facts={props.facts.filter((fact) => fact.primary)} />
          <InformationDetails {...props} />
        </dialog>
      ) : null}
    </div>
  );
}

function InformationDetails(props: InfoPanelProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <details
      className={styles.cmpInfoDetails}
      onToggle={() =>
        reportClientDiagnostic("[keiko] coding workbench information details toggled")
      }
    >
      <summary className={styles.cmpActivitySummary}>{t("codingWorkbench.info.details")}</summary>
      <InformationFacts facts={props.facts.filter((fact) => !fact.primary)} />
      <p className={styles.helpText}>{t("codingWorkbench.controls.help")}</p>
      <TaskWorkspaceLocation />
      <OptionalTaskWorkspaceManager />
      <ContextUsagePanel usage={props.contextUsage} />
    </details>
  );
}
