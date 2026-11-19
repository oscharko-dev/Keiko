/* Rules of the pipe relay's plan and port rewrite (#4068, ADR-0043 D21). Needs no administrator
 * rights and no network: the end-to-end relay through a real AppContainer runs in
 * scripts/testing/test-windows-relay-confinement.mjs. */
#include "gateway_relay.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures;

static void expect(int condition, const char *name) {
  if (!condition) {
    ++failures;
    printf("FAIL %s\n", name);
  }
}

#define PREFIX L"0123456789abcdef0123456789abcdef"

static void plan_round_trip(void) {
  struct keiko_relay_plan plan;
  wchar_t text[KEIKO_RELAY_PLAN_CHARS];
  expect(keiko_relay_plan_parse(PREFIX L"/o1983,i52011", &plan), "plan parses");
  expect(strcmp(plan.prefix, "0123456789abcdef0123456789abcdef") == 0, "prefix kept");
  expect(plan.route_count == 2, "two routes");
  expect(plan.routes[0].direction == KEIKO_RELAY_OUTBOUND && plan.routes[0].host_port == 1983,
         "outbound route");
  expect(plan.routes[1].direction == KEIKO_RELAY_INBOUND && plan.routes[1].host_port == 52011,
         "inbound route");
  expect(keiko_relay_plan_format(&plan, text, KEIKO_RELAY_PLAN_CHARS), "plan formats");
  expect(wcscmp(text, PREFIX L"/o1983,i52011") == 0, "format round-trips");
}

static void plan_refusals(void) {
  static const wchar_t *const refused[] = {
      L"",
      PREFIX,
      PREFIX L"/",
      PREFIX L"/o",
      PREFIX L"/o0",
      PREFIX L"/o65536",
      PREFIX L"/o123456",
      PREFIX L"/x1983",
      PREFIX L"/o1983,",
      PREFIX L"/o1983;i2",
      PREFIX L"/o1983,o1983",
      PREFIX L"/i1983,i1984",
      PREFIX L"/o1,o2,o3,o4,o5",
      L"0123456789ABCDEF0123456789abcdef/o1983",
      L"0123456789abcdef0123456789abcde/o1983",
      PREFIX L"/o1983 ",
  };
  struct keiko_relay_plan plan;
  size_t index;
  for (index = 0; index < sizeof(refused) / sizeof(refused[0]); ++index) {
    char name[64];
    (void)snprintf(name, sizeof(name), "plan refused #%zu", index);
    expect(!keiko_relay_plan_parse(refused[index], &plan), name);
  }
  expect(keiko_relay_plan_parse(PREFIX L"/o1,o2,o3,i4", &plan) && plan.route_count == 4,
         "four routes accepted");
}

static void pipe_name(void) {
  struct keiko_relay_plan plan;
  wchar_t name[96];
  expect(keiko_relay_plan_parse(PREFIX L"/o1983", &plan), "plan for pipe name");
  keiko_relay_pipe_name(&plan, 1, name);
  expect(wcscmp(name, L"\\\\.\\pipe\\KeikoRelay-" PREFIX L"-1") == 0, "pipe name");
}

static void rewrite(const wchar_t *value, const wchar_t *expected, const char *name) {
  wchar_t *output = keiko_relay_rewrite_port(value, 1983, 61001);
  expect(output != NULL && wcscmp(output, expected) == 0, name);
  free(output);
}

static void port_rewrite(void) {
  rewrite(L"http://127.0.0.1:1983/api/coding-sidecar/gateway",
          L"http://127.0.0.1:61001/api/coding-sidecar/gateway", "url rewritten");
  rewrite(L"127.0.0.1:1983", L"127.0.0.1:61001", "bare address rewritten");
  rewrite(L"a=127.0.0.1:1983;b=127.0.0.1:1983/x", L"a=127.0.0.1:61001;b=127.0.0.1:61001/x",
          "every occurrence rewritten");
  rewrite(L"http://127.0.0.1:19830/x", L"http://127.0.0.1:19830/x", "longer port kept");
  rewrite(L"http://127.0.0.1:198/x", L"http://127.0.0.1:198/x", "shorter port kept");
  rewrite(L"http://localhost:1983/x", L"http://localhost:1983/x", "other host kept");
  rewrite(L"", L"", "empty value kept");
}

int main(void) {
  plan_round_trip();
  plan_refusals();
  pipe_name();
  port_rewrite();
  printf("gateway-relay-rules: failures=%d\n", failures);
  return failures == 0 ? 0 : 1;
}
