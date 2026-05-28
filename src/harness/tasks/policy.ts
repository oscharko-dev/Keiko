// Shared task abstraction. Each Wave-1 task type provides a TaskPlan describing the
// initial model messages, the patch target, and the state-path capabilities the loop is
// allowed to enter. The loop reads `allows*` flags to route — read-only enforcement for
// explain-plan is a property of the task, not of configuration (ADR-0004 D8).

import type { ChatMessage } from "../../gateway/types.js";
import type { TaskInput } from "../types.js";
import { buildExplainPlan } from "./explain-plan.js";
import { buildGenerateUnitTests } from "./generate-unit-tests.js";
import { buildInvestigateBug } from "./investigate-bug.js";

export interface TaskPlan {
  // The capabilities this task is permitted to use. The loop NEVER enters a disallowed
  // state; for explain-plan all three are false, making it read-only by construction.
  readonly allowsTools: boolean;
  readonly allowsPatch: boolean;
  readonly allowsVerification: boolean;
  readonly targetFile: string;
  // Initial messages seeding the first model call. SENSITIVE content — never logged raw.
  readonly messages: readonly ChatMessage[];
  // Short, non-sensitive rationale describing the plan, surfaced as a reasoning:trace.
  readonly rationale: string;
}

// Routes a validated TaskInput to its task-specific plan. The discriminated union makes
// this total: adding a TaskType without a branch is a compile error.
export function resolveTaskPlan(task: TaskInput): TaskPlan {
  switch (task.taskType) {
    case "generate-unit-tests":
      return buildGenerateUnitTests(task.input);
    case "investigate-bug":
      return buildInvestigateBug(task.input);
    case "explain-plan":
      return buildExplainPlan(task.input);
  }
}
