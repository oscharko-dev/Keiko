import type { ReactNode } from "react";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchRequestState } from "./CodingWorkbenchWindow";
import type {
  CodingWorkbenchModeOption,
  CodingWorkbenchProjection,
} from "./codingWorkbenchProjection";
import {
  cx,
  diffText,
  eventDetail,
  eventTitle,
  isActiveRunState,
  modeDescription,
  modeLabel,
  permissionLabel,
  progressText,
  requestStatusLabel,
  runStateLabel,
  runtimeLabel,
  verificationText,
} from "./codingWorkbenchLabels";
import styles from "./CodingWorkbenchWindow.module.css";

export function WorkbenchHeader({
  projection,
}: {
  readonly projection: CodingWorkbenchProjection;
}): ReactNode {
  return (
    <header className={styles.header}>
      <div>
        <p className={styles.eyebrow}>Coding Workbench</p>
        <h2 className={styles.title}>{projection.title}</h2>
        <p className={styles.summary}>{projection.currentStep}</p>
      </div>
      <span className={styles.statePill}>{runStateLabel(projection.runState)}</span>
    </header>
  );
}

export function ModeAuthority({
  options,
  selectedMode,
  locked,
  onModeChange,
}: {
  readonly options: readonly CodingWorkbenchModeOption[];
  readonly selectedMode: CodingWorkbenchMode;
  readonly locked: boolean;
  readonly onModeChange: (mode: CodingWorkbenchMode) => void;
}): ReactNode {
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-mode-title">
      <PanelTitle eyebrow="Mode authority" id="coding-workbench-mode-title">
        Select governed autonomy
      </PanelTitle>
      <div className={styles.modeGrid} role="radiogroup" aria-label="Coding autonomy mode">
        {options.map((option) => (
          <ModeOption
            key={option.mode}
            option={option}
            selected={selectedMode === option.mode}
            locked={locked}
            onModeChange={onModeChange}
          />
        ))}
      </div>
    </section>
  );
}

function ModeOption({
  option,
  selected,
  locked,
  onModeChange,
}: {
  readonly option: CodingWorkbenchModeOption;
  readonly selected: boolean;
  readonly locked: boolean;
  readonly onModeChange: (mode: CodingWorkbenchMode) => void;
}): ReactNode {
  const disabled = locked || !option.enabled;
  const id = `coding-workbench-mode-${option.mode}`;
  return (
    <div
      className={styles.modeOption}
      data-selected={selected ? "true" : "false"}
      data-enabled={disabled ? "false" : "true"}
    >
      <input
        id={id}
        type="radio"
        name="coding-workbench-mode"
        checked={selected}
        disabled={disabled}
        onChange={() => onModeChange(option.mode)}
      />
      <label className={styles.modeText} htmlFor={id}>
        <span className={styles.modeName}>{modeLabel(option.mode)}</span>
        <span className={styles.modeDetail}>{option.reason ?? modeDescription(option.mode)}</span>
      </label>
    </div>
  );
}

export function AuthoritySummary({
  projection,
}: {
  readonly projection: CodingWorkbenchProjection;
}): ReactNode {
  const authority = projection.authority;
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-authority-title">
      <PanelTitle eyebrow="Authority Envelope" id="coding-workbench-authority-title">
        Current boundaries
      </PanelTitle>
      <dl className={styles.authorityList}>
        <AuthorityItem label="Task" value={projection.taskRef} />
        <AuthorityItem label="Mode" value={modeLabel(authority.effectiveMode)} />
        <AuthorityItem label="Runtime" value={runtimeLabel(authority.runtimeSource)} />
        <AuthorityItem
          label="Branch"
          value={`${authority.branch.baseRef} -> ${authority.branch.headRef}`}
        />
        <AuthorityItem label="Network" value={authority.networkPolicy.mode} />
        <AuthorityItem label="Approval" value={authority.approvalProofDigest} />
      </dl>
    </section>
  );
}

export function RunSummary({
  projection,
}: {
  readonly projection: CodingWorkbenchProjection;
}): ReactNode {
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-run-title">
      <PanelTitle eyebrow="Run timeline" id="coding-workbench-run-title">
        Current run
      </PanelTitle>
      <div className={styles.metricGrid}>
        <Metric label="Task" value={projection.taskRef} detail={projection.progress.label} />
        <Metric
          label="Todo progress"
          value={progressText(projection.progress)}
          detail="Content-free counts"
        />
        <Metric label="Diff summary" value={projection.diff.label} detail={diffText(projection)} />
        <Metric
          label="Verification"
          value={projection.verification.label}
          detail={verificationText(projection)}
        />
        <Metric
          label="Delivery"
          value={projection.deliveryStatus}
          detail="Human-gated closeout remains required"
        />
      </div>
    </section>
  );
}

export function ActionControls({
  projection,
  requestState,
  onStop,
  onTakeOver,
}: {
  readonly projection: CodingWorkbenchProjection;
  readonly requestState: CodingWorkbenchRequestState;
  readonly onStop: () => void;
  readonly onTakeOver: () => void;
}): ReactNode {
  const active = isActiveRunState(projection.runState);
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-controls-title">
      <PanelTitle eyebrow="Operator controls" id="coding-workbench-controls-title">
        Stop or take over
      </PanelTitle>
      <div className={styles.controls}>
        <button
          className={cx(styles.button, styles.buttonDanger)}
          disabled={!active}
          onClick={onStop}
          type="button"
        >
          Stop sidecar
        </button>
        <button className={styles.button} disabled={!active} onClick={onTakeOver} type="button">
          Take over manually
        </button>
      </div>
      <p className={styles.requestStatus} role="status">
        {requestStatusLabel(requestState)}
      </p>
    </section>
  );
}

export function PermissionPrompt({
  projection,
  onRequestState,
}: {
  readonly projection: CodingWorkbenchProjection;
  readonly onRequestState: (state: CodingWorkbenchRequestState) => void;
}): ReactNode {
  const request = projection.permissionRequest;
  if (request === undefined) return null;
  return (
    <section
      className={cx(styles.card, styles.permission)}
      aria-labelledby="coding-workbench-permission-title"
    >
      <PanelTitle eyebrow="Permission required" id="coding-workbench-permission-title">
        Just-in-time approval
      </PanelTitle>
      <p className={styles.summary}>
        {permissionLabel(request.kind)} requested for {request.reasonCode}. Raw commands, prompts,
        diffs, and customer content are not shown in this approval surface.
      </p>
      <div className={styles.controls}>
        <button
          className={cx(styles.button, styles.buttonPrimary)}
          type="button"
          onClick={() => onRequestState("approved")}
        >
          Approve once
        </button>
        <button className={styles.button} type="button" onClick={() => onRequestState("denied")}>
          Deny
        </button>
      </div>
    </section>
  );
}

export function PolicyDenials({ denials }: { readonly denials: readonly string[] }): ReactNode {
  if (denials.length === 0) return null;
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-denials-title">
      <PanelTitle eyebrow="Policy denials" id="coding-workbench-denials-title">
        Governance holds
      </PanelTitle>
      <ul className={styles.denials}>
        {denials.map((denial) => (
          <li key={denial} className={styles.denial}>
            <span className={styles.denialText}>{denial}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Timeline({
  events,
}: {
  readonly events: CodingWorkbenchProjection["timeline"];
}): ReactNode {
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-timeline-title">
      <PanelTitle eyebrow="Event stream" id="coding-workbench-timeline-title">
        Redacted run events
      </PanelTitle>
      {events.length === 0 ? (
        <p className={styles.emptyText}>No runtime events yet.</p>
      ) : (
        <ol className={styles.timeline} aria-label="Redacted coding run timeline">
          {events.map((event) => (
            <li key={event.eventId} className={styles.timelineItem}>
              <span className={styles.timelineMarker} aria-hidden="true" />
              <div>
                <p className={styles.timelineTitle}>{eventTitle(event)}</p>
                <p className={styles.timelineDetail}>{eventDetail(event)}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function PanelTitle({
  eyebrow,
  id,
  children,
}: {
  readonly eyebrow: string;
  readonly id: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div>
      <p className={styles.label}>{eyebrow}</p>
      <h3 id={id} className={styles.cardTitle}>
        {children}
      </h3>
    </div>
  );
}

function AuthorityItem({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className={styles.authorityItem}>
      <dt className={styles.metaLabel}>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}): ReactNode {
  return (
    <article className={styles.metric}>
      <p className={styles.metricLabel}>{label}</p>
      <p className={styles.metricValue}>{value}</p>
      <p className={styles.metricLabel}>{detail}</p>
    </article>
  );
}
