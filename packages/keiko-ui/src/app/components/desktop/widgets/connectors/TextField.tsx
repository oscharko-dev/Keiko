// Issue #2245 (Epic #2238) — a small labelled text field used across the connector forms. Keeps
// each form's render short (≤50 lines) and gives every input an associated <label>, inline hint,
// and role="alert" error wired via aria-describedby.

import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";

export interface TextFieldProps {
  readonly id: string;
  readonly labelKey: MessageKey;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: "text" | "password" | "email";
  readonly placeholderKey?: MessageKey;
  readonly hintKey?: MessageKey;
  readonly errorKey?: MessageKey | undefined;
  readonly autoComplete?: string;
  readonly disabled?: boolean;
}

export function TextField(props: TextFieldProps): ReactNode {
  const t = useTranslate();
  const { id, value, onChange, errorKey, hintKey } = props;
  const hintId = hintKey === undefined ? undefined : `${id}-hint`;
  const errorId = errorKey === undefined ? undefined : `${id}-error`;
  const describedBy = [errorId, hintId].filter((entry) => entry !== undefined).join(" ");
  return (
    <div className="acx-field">
      <label className="acx-label" htmlFor={id}>
        {t(props.labelKey)}
      </label>
      <input
        id={id}
        className="acx-input"
        type={props.type ?? "text"}
        value={value}
        disabled={props.disabled ?? false}
        autoComplete={props.autoComplete ?? "off"}
        aria-invalid={errorKey !== undefined}
        {...(describedBy.length > 0 ? { "aria-describedby": describedBy } : {})}
        {...(props.placeholderKey === undefined ? {} : { placeholder: t(props.placeholderKey) })}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {errorKey !== undefined ? (
        <p className="acx-error" id={errorId} role="alert">
          {t(errorKey)}
        </p>
      ) : null}
      {hintKey !== undefined ? (
        <p className="acx-hint" id={hintId}>
          {t(hintKey)}
        </p>
      ) : null}
    </div>
  );
}
