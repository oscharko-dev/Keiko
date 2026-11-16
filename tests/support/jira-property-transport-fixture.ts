import { expect } from "vitest";
import type {
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import { response } from "./jira-managed-remote.js";

export const REVIEWED_PROPERTY_NODES = [{ path: "", kind: "null" }] as const;
export const REQUESTED_PROPERTY_NODES = [
  { path: "", kind: "boolean", booleanValue: false },
] as const;
export const PROPERTY_FIXTURE_KEY = "view ~settings";

/** One independently selected synthetic property; parent identity stays with each existing fixture. */
interface PropertyTransportFixture {
  readonly read: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly write: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
}
export function propertyTransportFixture(
  root: string | undefined,
  initiallyPresent = true,
): PropertyTransportFixture {
  let present = initiallyPresent;
  let value: unknown = null;
  const selected =
    root === undefined ? undefined : `${root}/${encodeURIComponent(PROPERTY_FIXTURE_KEY)}`;
  return {
    read(request: AtlassianHttpBodyRequest): AtlassianHttpBodyResult | undefined {
      if (root === undefined) return undefined;
      const path = new URL(request.url).pathname;
      if (path === root)
        return response({
          keys: present
            ? [{ key: PROPERTY_FIXTURE_KEY, self: "https://untrusted.invalid/property" }]
            : [],
        });
      if (path !== selected) return undefined;
      return present ? response({ key: PROPERTY_FIXTURE_KEY, value }) : response({}, 404);
    },
    write(request: AtlassianHttpBodyRequest): AtlassianHttpBodyResult | undefined {
      if (selected === undefined || new URL(request.url).pathname !== selected) return undefined;
      if (request.method === "PUT") {
        if (request.bodyJson === undefined) throw new TypeError("Missing native property body");
        value = JSON.parse(request.bodyJson) as unknown;
        present = true;
      } else {
        expect(request.method).toBe("DELETE");
        expect(request.bodyJson).toBeUndefined();
        present = false;
      }
      return response({}, 204);
    },
  };
}
