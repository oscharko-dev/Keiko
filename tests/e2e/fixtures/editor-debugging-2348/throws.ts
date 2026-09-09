export function throwsFixture(): never {
  const left = 1;
  const total = left + 1;
  const message = "deterministic debug exception";
  if (total === 2) {
    // deliberately empty: this line exists as a stable breakpoint target for the debug fixture
  }
  throw new Error(message);
}

throwsFixture();
