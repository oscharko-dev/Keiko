import "vitest";

// jest-axe ships a Jest matcher; this augments Vitest's matcher interface so `toHaveNoViolations`
// is typed under the Vitest `expect`.
declare module "vitest" {
  interface Assertion {
    toHaveNoViolations(): void;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): void;
  }
}
