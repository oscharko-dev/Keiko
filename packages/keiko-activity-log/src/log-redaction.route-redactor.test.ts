// The route-template reducer is injected by the server composition root (ADR-0179). These tests pin
// the seam itself: fail closed until configured, and never replaced once configured.

import { afterEach, describe, expect, it } from "vitest";

import {
  ActivityLogRouteRedactorConflictError,
  configureActivityLogRouteRedactor,
  redactLogString,
  resetActivityLogRouteRedactor,
  REDACTED_PATH,
  type ActivityLogRouteRedactor,
} from "./log-redaction.js";

const REDUCER_ID = "test/route-template";
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
    configureActivityLogRouteRedactor(REDUCER_ID, templateReducer);
    expect(redactLogString(ROUTE_PATH)).toBe("/api/runs/:id/events");
    expect(redactLogString("/Users/someone/private/notes.txt")).toBe(REDACTED_PATH);
  });

  it("keeps the first reducer when a second module graph registers the same id", () => {
    configureActivityLogRouteRedactor(REDUCER_ID, templateReducer);
    // A built copy of the same composition root carries a distinct but identical function.
    const duplicateGraphReducer: ActivityLogRouteRedactor = (pathname) => pathname;
    expect(() => {
      configureActivityLogRouteRedactor(REDUCER_ID, duplicateGraphReducer);
    }).not.toThrow();
    expect(redactLogString(ROUTE_PATH)).toBe("/api/runs/:id/events");
  });

  it("refuses a reducer under a different id instead of silently replacing redaction", () => {
    configureActivityLogRouteRedactor(REDUCER_ID, templateReducer);
    const echo: ActivityLogRouteRedactor = (pathname) => pathname;
    expect(() => {
      configureActivityLogRouteRedactor("test/echo", echo);
    }).toThrow(ActivityLogRouteRedactorConflictError);
    expect(redactLogString(ROUTE_PATH)).toBe("/api/runs/:id/events");
  });

  it("rejects a reducer without an id and stays fail-closed", () => {
    expect(() => {
      configureActivityLogRouteRedactor("", templateReducer);
    }).toThrow(TypeError);
    expect(redactLogString(ROUTE_PATH)).toBe(REDACTED_PATH);
  });
});
