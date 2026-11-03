// The one error of corpus generation (#4208): a conversation that cannot be built, a writer whose
// text lost or altered a fact, a generated scenario that fails its own validation. A corpus that
// loses a fact is rejected here, never scored.
export class CorpusError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CorpusError";
  }
}
