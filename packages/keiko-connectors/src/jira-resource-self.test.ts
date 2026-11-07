import { expect, it } from "vitest";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";

const RESOURCE = "issue/10001/comment/10002";
const PATH = `/rest/api/2/${RESOURCE}`;

it.each([
  `https://jira.example.test/context${PATH}`,
  `https://public.example.test/another-context${PATH}`,
  `http://internal.example.test:8080${PATH}`,
  `https://public.example.test${PATH.replace("10001", "%31%30%30%30%31")}`,
])("compares native identity across proxy/base-URL differences: %s", (self) => {
  expect(jiraResourceSelfMatches(self, RESOURCE)).toBe(true);
});

it.each([
  undefined,
  null,
  7,
  "not a URL",
  PATH,
  `ftp://jira.example.test${PATH}`,
  `https://user:password@jira.example.test${PATH}`,
  `https://jira.example.test${PATH}?`,
  `https://jira.example.test${PATH}?expand=other`,
  `https://jira.example.test${PATH}#`,
  `https://jira.example.test${PATH}#other`,
  `https://jira.example.test${PATH.replace("10001", "99999")}`,
  `https://jira.example.test${PATH.replace("10002", "99999")}`,
  `https://jira.example.test${PATH}/extra`,
  `https://jira.example.test/rest%2Fapi%2F2%2F${RESOURCE}`,
  `https://jira.example.test${PATH.replace("10001", "100%2F01")}`,
  `https://jira.example.test${PATH.replace("10002", "100%02")}`,
  `https://jira.example.test${PATH}\n`,
  `https://jira.example.test\\context${PATH}`,
  `https://jira.example.test/${"a".repeat(4096)}${PATH}`,
])("refuses ambiguous or different native identities: %#", (self) => {
  expect(jiraResourceSelfMatches(self, RESOURCE)).toBe(false);
});
