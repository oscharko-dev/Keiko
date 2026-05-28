// Single-sourced package version; CLI and SDK both read this to avoid drift.
export const SDK_VERSION = "0.1.0";

// Minimal typed agent surface; downstream issues expand this into the real config.
export interface AgentConfig {
  readonly model: string;
  readonly workingDirectory: string;
}
