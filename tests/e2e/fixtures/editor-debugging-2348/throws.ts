export function throwsFixture(): never {
  const left = 1;
  const total = left + 1;
  const message = "deterministic debug exception";
  if (total === 2) {
    void message;
  }
  throw new Error(message);
}

throwsFixture();
