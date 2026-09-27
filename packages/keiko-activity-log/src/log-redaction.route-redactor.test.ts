// The route-template reducer is injected by the server composition root (ADR-0179). These tests pin
// the seam itself: fail closed until configured, and never silently replaced once configured.

import { afterEach, describe, expect, it } from "vitest";

import {
  ActivityLogRouteRedactorConflictError,
  configureActivityLogRouteRedactor,
  redactLogString,
  resetActivityLogRouteRedactor,
  REDACTED_PATH,
  type ActivityLogRouteRedactor,
} from "./log-redaction.js";

const ROUTE_PATH = "/api/runs/1a2b3c4d5e6f7a8b9c0d/events";
const templateReducer: ActivityLogRouteRedactor = (pathname) =>
  pathname.startsWith("/api/runs/") ? "/api/runs/:id/events" : undefined;

afterEach(() => {
  resetActivityLogRouteRedactor();
});

describe("Activity Log route redactor seam", () => {
  it("replaces every path-shaped value until a composition root configures a reducer", () => {
    expect(redactLogString(ROUTE_PATH)).toBe(REDACTED_PATH);
  });

  it("reduces a path through the configured reducer and still fails closed on its misses", () => {
    configureActivityLogRouteRedactor(templateReducer);
    expect(redactLogString(ROUTE_PATH)).toBe("/api/runs/:id/events");
    expect(redactLogString("/Users/someone/private/notes.txt")).toBe(REDACTED_PATH);
  });

  it("treats repeating the same reducer as a no-op", () => {
    configureActivityLogRouteRedactor(templateReducer);
    expect(() => {
      configureActivityLogRouteRedactor(templateReducer);
    }).not.toThrow();
    expect(redactLogString(ROUTE_PATH)).toBe("/api/runs/:id/events");
  });

  it("refuses a different reducer instead of silently weakening redaction", () => {
    configureActivityLogRouteRedactor(templateReducer);
    const echo: ActivityLogRouteRedactor = (pathname) => pathname;
    expect(() => {
      configureActivityLogRouteRedactor(echo);
    }).toThrow(ActivityLogRouteRedactorConflictError);
    expect(redactLogString(ROUTE_PATH)).toBe("/api/runs/:id/events");
  });
});
