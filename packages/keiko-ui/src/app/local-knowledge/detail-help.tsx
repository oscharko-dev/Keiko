"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import detailStyles from "./capsule-detail.module.css";

type ExplainableTag = "div" | "li" | "span";

interface ExplainableProps {
  readonly children: ReactNode;
  readonly description: string;
  readonly as?: ExplainableTag;
  readonly block?: boolean;
  readonly className?: string;
  readonly placement?: "bottom" | "top";
}

function explainableClassName(block: boolean, className: string | undefined): string {
  const classes = [detailStyles.explainable];
  if (block) classes.push(detailStyles.explainableBlock);
  if (className !== undefined) classes.push(className);
  return classes.join(" ");
}

export function Explainable({
  children,
  description,
  as = "span",
  block = false,
  className,
  placement = "bottom",
}: ExplainableProps): ReactNode {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const Tag = as;

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") setOpen(false);
  }

  return (
    <Tag
      className={explainableClassName(block, className)}
      data-placement={placement}
      tabIndex={0}
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={handleKeyDown}
    >
      {children}
      {open ? (
        <span id={tooltipId} role="tooltip" className={detailStyles.helpTooltip}>
          {description}
        </span>
      ) : null}
    </Tag>
  );
}
