"use client";

import type { CSSProperties, ReactNode } from "react";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { Icons } from "../../Icons";

const GitIcon = Icons.git;

const FIELD_STYLE: CSSProperties = {
  width: "100%",
  padding: "var(--space-2)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-control)",
  background: "var(--background-secondary)",
  color: "var(--text-body)",
  font: "var(--text-body-sm)",
};

const FIELD_LABEL_STYLE: CSSProperties = {
  font: "var(--text-caption)",
  color: "var(--fg-muted)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  flex: 1,
};

const FACT_STYLE: CSSProperties = {
  font: "var(--text-caption)",
  color: "var(--fg-muted)",
  margin: 0,
};

/** One labelled text input of the governed delivery forms. */
export function GovernedField(props: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly labelInput?: boolean;
}): ReactNode {
  return (
    <label style={FIELD_LABEL_STYLE}>
      {props.label}{" "}
      <input
        style={FIELD_STYLE}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        aria-label={props.labelInput === true ? props.label : undefined}
      />
    </label>
  );
}

/** The empty state shown while no project is selected. */
export function GovernedEmpty(props: {
  readonly testId: string;
  readonly text: string;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      style={{ padding: "var(--space-4)", color: "var(--fg-muted)", font: "var(--text-body-sm)" }}
    >
      <p>
        <GitIcon size={13} /> {props.text}
      </p>
    </div>
  );
}

/** Recommendation and policy rows shared by the merge and pull-request readiness panels. */
export function GovernedPolicyFacts(props: {
  readonly recommendation: string;
  readonly policyOutcome: string;
  readonly policyBlockReason: string | undefined;
}): ReactNode {
  const t = useOptionalWidgetTranslate();
  return (
    <>
      <p style={FACT_STYLE} data-field="recommendation">
        {t("governedDelivery.ui.recommendation", { value: props.recommendation })}
      </p>
      <p style={FACT_STYLE} data-field="policy">
        {t("governedDelivery.ui.policy", { value: props.policyOutcome })}
        {props.policyBlockReason === undefined ? "" : ` (${props.policyBlockReason})`}
      </p>
    </>
  );
}

interface GovernedFieldSpec {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** A wrapping row of labelled inputs, described as data. */
export function GovernedFieldRow(props: {
  readonly disabled: boolean;
  readonly fields: readonly GovernedFieldSpec[];
}): ReactNode {
  return (
    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
      {props.fields.map((field) => (
        <GovernedField
          key={field.label}
          label={field.label}
          value={field.value}
          disabled={props.disabled}
          onChange={field.onChange}
        />
      ))}
    </div>
  );
}
