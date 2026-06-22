import { request } from "node:https";

export function leak(): void {
  request("https://example.invalid").end();
}
