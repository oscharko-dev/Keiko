import { expect, type Page, type Route } from "@playwright/test";
import {
  parseCodingWorkbenchRuntimeApprovalDecisionRequest,
  parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
  parseCodingWorkbenchRuntimeRetryRequest,
  parseCodingWorkbenchRuntimeStartRequest,
  parseCodingWorkbenchRuntimeStopRequest,
  parseCodingWorkbenchRuntimeTakeoverRequest,
  compareCodingWorkbenchModeAuthority,
  resolveEffectiveCodingWorkbenchMode,
  validateCodingWorkbenchCodexAuthSetupRequest,
  validateCodingWorkbenchRuntimeReadiness,
  type CodingWorkbenchMode,
  type CodingWorkbenchRuntimeReadiness,
  type CodingWorkbenchValidationResult,
  type MemoryAutonomyPolicyWire,
} from "@oscharko-dev/keiko-contracts";
import type { LiveRuntimeFixtureOptions } from "./coding-workbench-live-runtime.js";
import { parsedAutonomyPolicyUpdate } from "./autonomyPolicyRequest.js";
import {
  activeWorkspace,
  codexProfile,
  codexSetupPlan,
  eventStream,
  FIXTURE_RUN_ID,
  fulfillJson,
  snapshot,
  sourceProfile,
  type FixtureAuthStatus,
  type RuntimeFixtureState,
} from "./coding-workbench-live-runtime-fixtures.js";

type RuntimeOptions = Required<
  Pick<
    LiveRuntimeFixtureOptions,
    "deploymentCeiling" | "disconnectStreamOnce" | "eventCount" | "runtimeAvailable"
  >
>;

// The clamp is the product invariant under test, so the fixture must not re-implement it: it uses
// the same contracts resolver the server does. A local copy could drift and let a projection bug
// pass as a server-capped result (#1991).
function effectiveMode(
  requestedMode: CodingWorkbenchMode,
  ceiling: CodingWorkbenchMode,
): CodingWorkbenchMode {
  return resolveEffectiveCodingWorkbenchMode(requestedMode, ceiling);
}

// The product-wide autonomy mode now lives in Settings and reaches the Workbench through this
// policy channel (#2644), so the fixture owns it as server state: a persisted request is stored
// verbatim and the effective mode is always re-derived against the deployment ceiling.
async function handleAutonomyPolicy(
  route: Route,
  ceiling: CodingWorkbenchMode,
  state: { requestedMode: CodingWorkbenchMode; revision: number },
): Promise<void> {
  if (route.request().method() === "PUT") {
    const update = parsedAutonomyPolicyUpdate(route.request().postData());
    if (update === null) {
      // The client parses failures out of the server's `{ error: { code, message } }` envelope; a
      // bare body would degrade to a generic HTTP error here and hide client-side regressions in
      // error-code handling behind a fixture that does not speak the real contract.
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "INVALID_AUTONOMY_REQUEST",
            message: "The requested autonomy mode is not a supported product mode.",
          },
        }),
      });
      return;
    }
    const exactRevision = update.expectedRevision === state.revision;
    const staleDowngrade =
      update.expectedRevision < state.revision &&
      compareCodingWorkbenchModeAuthority(update.requestedMode, state.requestedMode) < 0;
    if (!exactRevision && !staleDowngrade) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "CONFLICT",
            message: "Memory autonomy policy changed. Reload and retry.",
          },
        }),
      });
      return;
    }
    state.requestedMode = update.requestedMode;
    state.revision += 1;
  }
  const policy: MemoryAutonomyPolicyWire = {
    requestedMode: state.requestedMode,
    effectiveMode: effectiveMode(state.requestedMode, ceiling),
    deploymentCeiling: ceiling,
    revision: state.revision,
  };
  await fulfillJson(route, policy);
}

async function handleFoundationRoute(
  route: Route,
  pathname: string,
  authStatus: FixtureAuthStatus,
): Promise<boolean> {
  // Restore-time re-verification (release-audit F-09b): restoring surfaces run the #447
  // reconciliation pass before claiming a persisted binding, so the fixture must answer it the
  // way the real server does for a healthy workspace — a report entry re-stamping the binding.
  if (route.request().method() === "POST" && pathname === "/api/task-workspaces/reconciliation") {
    await fulfillJson(route, {
      report: {
        entries: [{ workspaceId: activeWorkspace().instance.workspaceId, status: "healthy" }],
      },
    });
    return true;
  }
  if (route.request().method() !== "GET") return false;
  if (pathname === "/api/task-workspaces/active") {
    await fulfillJson(route, { active: activeWorkspace() });
    return true;
  }
  if (pathname === "/api/task-workspaces") {
    await fulfillJson(route, { instances: [activeWorkspace().instance] });
    return true;
  }
  if (pathname === "/api/coding-sidecar/gateway/profile") {
    await fulfillJson(route, sourceProfile());
    return true;
  }
  if (pathname === "/api/coding-workbench/codex-subscription/profile") {
    await fulfillJson(route, codexProfile(authStatus));
    return true;
  }
  return false;
}

async function handleCodexSetupRoute(
  route: Route,
  pathname: string,
  fixture: RuntimeFixtureState,
): Promise<boolean> {
  if (
    route.request().method() !== "POST" ||
    pathname !== "/api/coding-workbench/codex-subscription/setup"
  )
    return false;
  const result = validateCodingWorkbenchCodexAuthSetupRequest(route.request().postDataJSON());
  if (result.ok) {
    await fulfillJson(route, codexSetupPlan(result.value.method));
    return true;
  }
  fixture.validationErrors.push(...result.errors);
  await route.fulfill({ status: 400, contentType: "application/json", body: "{}" });
  return true;
}

async function parsedRequest<T extends { readonly requestId: string }>(
  route: Route,
  parse: (value: unknown) => CodingWorkbenchValidationResult<T>,
  fixture: RuntimeFixtureState,
  expectedRequestId?: string,
): Promise<T | null> {
  const result = parse(route.request().postDataJSON());
  const errors = result.ok ? [] : [...result.errors];
  if (result.ok && expectedRequestId !== undefined && result.value.requestId !== expectedRequestId)
    errors.push(`requestId must equal ${expectedRequestId}`);
  if (errors.length === 0 && result.ok) return result.value;
  fixture.validationErrors.push(...errors);
  await route.fulfill({
    status: 400,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "INVALID_E2E_REQUEST", message: errors.join("; ") } }),
  });
  return null;
}

async function transition(
  route: Route,
  fixture: RuntimeFixtureState,
  state: RuntimeFixtureState["state"],
): Promise<void> {
  fixture.state = state;
  fixture.revision += 1;
  await fulfillJson(route, snapshot(fixture));
}

async function handleRuntimeGet(
  route: Route,
  pathname: string,
  searchParams: URLSearchParams,
  options: RuntimeOptions,
  fixture: RuntimeFixtureState,
): Promise<boolean> {
  if (pathname === "/api/coding-workbench/runtime/readiness") {
    const requestedMode = (searchParams.get("requestedMode") ??
      "governed-assist") as CodingWorkbenchMode;
    const readiness: CodingWorkbenchRuntimeReadiness = {
      schemaVersion: "1",
      requestedMode,
      deploymentCeiling: options.deploymentCeiling,
      effectiveMode: effectiveMode(requestedMode, options.deploymentCeiling),
      runtimeAvailable: options.runtimeAvailable,
      // #2475: an unavailable runtime must name its reason; the fixture mirrors the server.
      ...(options.runtimeAvailable ? {} : { runtimeUnavailableReason: "runtime-unqualified" }),
    };
    expect(validateCodingWorkbenchRuntimeReadiness(readiness).ok).toBe(true);
    await fulfillJson(route, readiness);
    return true;
  }
  if (pathname === "/api/coding-workbench/runtime/status") {
    await fulfillJson(route, snapshot(fixture));
    return true;
  }
  if (pathname.endsWith(`/runs/${FIXTURE_RUN_ID}/events`)) {
    fixture.streamConnections += 1;
    const disconnecting = options.disconnectStreamOnce && fixture.streamConnections === 1;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: eventStream(disconnecting ? 0 : options.eventCount, disconnecting ? 10 : 60_000),
    });
    return true;
  }
  if (pathname.endsWith(`/runs/${FIXTURE_RUN_ID}`)) {
    await fulfillJson(route, snapshot(fixture));
    return true;
  }
  return false;
}

async function handleRunCommand(
  route: Route,
  pathname: string,
  fixture: RuntimeFixtureState,
): Promise<boolean> {
  if (pathname.endsWith(`/${FIXTURE_RUN_ID}/stop`)) {
    if (
      (await parsedRequest(
        route,
        parseCodingWorkbenchRuntimeStopRequest,
        fixture,
        FIXTURE_RUN_ID,
      )) !== null
    )
      await transition(route, fixture, "recovery-required");
    return true;
  }
  if (pathname.endsWith(`/${FIXTURE_RUN_ID}/takeover`)) {
    if (
      (await parsedRequest(
        route,
        parseCodingWorkbenchRuntimeTakeoverRequest,
        fixture,
        FIXTURE_RUN_ID,
      )) !== null
    )
      await transition(route, fixture, "taken-over");
    return true;
  }
  return false;
}

async function handleApprovalCommand(route: Route, fixture: RuntimeFixtureState): Promise<boolean> {
  const request = await parsedRequest(
    route,
    parseCodingWorkbenchRuntimeApprovalDecisionRequest,
    fixture,
    "permission-2257",
  );
  if (request !== null) {
    expect(request.expectedRevision).toBe(fixture.revision);
    await transition(route, fixture, request.decision === "approved" ? "running" : "cancelled");
  }
  return true;
}

async function handleRecoveryCommand(
  route: Route,
  pathname: string,
  fixture: RuntimeFixtureState,
): Promise<boolean> {
  if (pathname.endsWith(`/${FIXTURE_RUN_ID}/recovery-ack`)) {
    const request = await parsedRequest(
      route,
      parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
      fixture,
      FIXTURE_RUN_ID,
    );
    if (request !== null) {
      fixture.recoveryAcknowledged = true;
      await transition(route, fixture, "recovery-required");
    }
    return true;
  }
  if (!pathname.endsWith(`/${FIXTURE_RUN_ID}/retry`)) return false;
  const retry = await parsedRequest(route, parseCodingWorkbenchRuntimeRetryRequest, fixture);
  if (retry !== null && fixture.recoveryAcknowledged) {
    fixture.recoveryAcknowledged = false;
    await transition(route, fixture, "running");
  }
  return true;
}

async function handleRuntimePost(
  route: Route,
  pathname: string,
  fixture: RuntimeFixtureState,
): Promise<boolean> {
  if (pathname === "/api/coding-workbench/runtime/runs") {
    if ((await parsedRequest(route, parseCodingWorkbenchRuntimeStartRequest, fixture)) !== null)
      await transition(route, fixture, "awaiting-approval");
    return true;
  }
  if (pathname.endsWith(`/${FIXTURE_RUN_ID}/approvals`))
    return handleApprovalCommand(route, fixture);
  if (await handleRunCommand(route, pathname, fixture)) return true;
  return handleRecoveryCommand(route, pathname, fixture);
}

export async function installRuntimeRoutes(
  page: Page,
  options: LiveRuntimeFixtureOptions,
  fixture: RuntimeFixtureState,
): Promise<void> {
  const runtimeOptions: RuntimeOptions = {
    deploymentCeiling: options.deploymentCeiling ?? "supervised-coding",
    disconnectStreamOnce: options.disconnectStreamOnce ?? false,
    eventCount: options.eventCount ?? 0,
    runtimeAvailable: options.runtimeAvailable ?? true,
  };
  const authStatus = options.authStatus ?? "connected";
  // #2386 fixed the product default at the supervised middle mode; the policy channel starts there
  // so the Workbench sees the same baseline it had before the modes moved into Settings.
  const autonomy = { requestedMode: options.requestedMode ?? "supervised-coding", revision: 0 };
  await page.route("**/api/**", async (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    if (pathname === "/api/memory/autonomy-policy") {
      await handleAutonomyPolicy(route, runtimeOptions.deploymentCeiling, autonomy);
      return;
    }
    if (await handleFoundationRoute(route, pathname, authStatus)) return;
    if (await handleCodexSetupRoute(route, pathname, fixture)) return;
    if (route.request().method() === "GET") {
      if (await handleRuntimeGet(route, pathname, searchParams, runtimeOptions, fixture)) return;
    } else if (route.request().method() === "POST") {
      if (await handleRuntimePost(route, pathname, fixture)) return;
    }
    await route.continue();
  });
}
