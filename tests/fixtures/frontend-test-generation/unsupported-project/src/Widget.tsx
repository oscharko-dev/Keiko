// A React component in a project that declares React but NO supported component-testing stack
// (no @testing-library/react). The generator must report a clear limitation instead of fabricating a
// component test it cannot ground (Issue #1203 Acceptance Criterion 5). There is intentionally no
// expected test file here: the correct outcome is a stated limitation, not a generated test.
export interface WidgetProps {
  readonly title: string;
}

export function Widget({ title }: WidgetProps): JSX.Element {
  return <section aria-label={title}>{title}</section>;
}
