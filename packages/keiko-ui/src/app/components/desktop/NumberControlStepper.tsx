"use client";

import type { ReactNode } from "react";

interface NumberControlStepperProps {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onStepUp: () => void;
  readonly onStepDown: () => void;
}

export function NumberControlStepper({
  label,
  disabled = false,
  onStepUp,
  onStepDown,
}: NumberControlStepperProps): ReactNode {
  const increaseLabel = `Increase ${label}`;
  const decreaseLabel = `Decrease ${label}`;

  return (
    <span className="number-control-stepper">
      <button
        type="button"
        className="number-control-stepper-button number-control-stepper-up"
        aria-label={increaseLabel}
        disabled={disabled}
        onPointerDown={(event) => {
          event.preventDefault();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onStepUp();
        }}
      />
      <button
        type="button"
        className="number-control-stepper-button number-control-stepper-down"
        aria-label={decreaseLabel}
        disabled={disabled}
        onPointerDown={(event) => {
          event.preventDefault();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onStepDown();
        }}
      />
    </span>
  );
}
