/** What one step of {@link runAsyncSteps} reports: finished with a value, or ready for the next. */
export type AsyncStepOutcome<T> =
  { readonly done: true; readonly value: T } | { readonly done: false };

/**
 * Runs `step` until it reports `done`, calling it again only after the previous call settled. It is
 * the sequential `for (;;) { await step(); }` without an await inside a loop and without a
 * recursive async function (`return next()`), which would leave every step's outer promise pending
 * until the very last one settled: a 60,000-entry tree or a multi-gigabyte file would hold hundreds
 * of thousands of live promises and closures at once. Here each settled step schedules the next from
 * its own continuation and returns nothing to wait on, so no promise outlives its step and memory
 * stays constant however many steps run. A step that throws or rejects ends the run with that error.
 */
export function runAsyncSteps<T>(step: () => Promise<AsyncStepOutcome<T>>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const schedule = (): void => {
      // Starting the step from a resolved promise turns a step that throws before returning a
      // promise into an ordinary rejection of this run.
      Promise.resolve()
        .then(step)
        .then((outcome) => {
          if (outcome.done) resolve(outcome.value);
          else schedule();
        }, reject);
    };
    schedule();
  });
}
