// One import site for the server activity log. The writer, the calling surface, the field policy and
// the severity ordering live in @oscharko-dev/keiko-activity-log (ADR-0179); this module re-exports
// them and installs the BFF route vocabulary into the package redaction. Instrumentation sites import
// from here so the layering stays an implementation detail.

import { configureActivityLogRouteRedactor } from "@oscharko-dev/keiko-activity-log";
import { redactRoutePath, ROUTE_TEMPLATE_REDACTOR_ID } from "./route-template.js";

// The route vocabulary stays in the BFF. The package defaults to refusing every path until the
// server composition root supplies this narrow reducer.
configureActivityLogRouteRedactor(ROUTE_TEMPLATE_REDACTOR_ID, redactRoutePath);

export * from "@oscharko-dev/keiko-activity-log";
export { redactRoutePath } from "./route-template.js";
