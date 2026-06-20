import { useState } from "react";

export interface CounterProps {
  readonly label: string;
  readonly initial?: number;
}

// A minimal interactive React component: a labelled button that increments a count.
export function Counter({ label, initial = 0 }: CounterProps): JSX.Element {
  const [count, setCount] = useState(initial);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      {label}: {count}
    </button>
  );
}
