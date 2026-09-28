/* Native validation and optional privileged filter-lifecycle proof. No runtime is enabled here. */
#include "gateway_wfp.h"
#include <sddl.h>
#include <stdio.h>
#include <string.h>

static int validation_tests(void) {
  struct keiko_gateway_filters filters = {0};
  PSID broad = NULL;
  PSID package = NULL;
  PSID capability = NULL;
  int ok;
  if (!ConvertStringSidToSidW(L"S-1-15-2-1", &broad) ||
      !ConvertStringSidToSidW(L"S-1-15-2-11-22-33-44-55-66-77", &package) ||
      !ConvertStringSidToSidW(L"S-1-15-3-11-22-33-44-55-66-77", &capability)) {
    LocalFree(broad);
    LocalFree(package);
    LocalFree(capability);
    return 1;
  }
  ok = keiko_gateway_filters_open(NULL, AF_INET, 1983, &filters) == ERROR_INVALID_PARAMETER &&
       keiko_gateway_filters_open(broad, AF_INET, 1983, &filters) == ERROR_INVALID_PARAMETER &&
       keiko_gateway_filters_open(capability, AF_INET, 1983, &filters) == ERROR_INVALID_PARAMETER &&
       keiko_gateway_filters_open(package, AF_INET, 0, &filters) == ERROR_INVALID_PARAMETER &&
       keiko_gateway_filters_open(package, AF_UNSPEC, 1983, &filters) == ERROR_INVALID_PARAMETER &&
       keiko_gateway_filters_open(package, AF_INET, 1983, NULL) == ERROR_INVALID_PARAMETER &&
       keiko_gateway_filters_close(&filters) == ERROR_SUCCESS && filters.engine == NULL;
  /* A second open must never overwrite an owned engine handle, even for a valid policy. */
  filters.engine = (HANDLE)(ULONG_PTR)1;
  ok = ok && keiko_gateway_filters_open(package, AF_INET, 1983, &filters) ==
                 ERROR_INVALID_PARAMETER && filters.engine == (HANDLE)(ULONG_PTR)1;
  filters.engine = NULL;
  LocalFree(broad);
  LocalFree(package);
  LocalFree(capability);
  puts(ok ? "gateway-policy-validation: passed" : "gateway-policy-validation: failed");
  return ok ? 0 : 1;
}

static int lifecycle_test(void) {
  struct keiko_gateway_filters filters = {0};
  PSID sid = NULL;
  DWORD result;
  if (!ConvertStringSidToSidW(L"S-1-15-2-112233-445566-778899-112244-335577-669988-123456", &sid))
    return 1;
  /* Synthetic package identity: these filters cannot affect any existing application. This is
   * only an installation/cleanup proof; the socket proof must use a real unique AppContainer. */
  result = keiko_gateway_filters_open(sid, AF_INET, 1983, &filters);
  if (result == ERROR_SUCCESS) result = keiko_gateway_filters_close(&filters);
  LocalFree(sid);
  printf("gateway-filter-lifecycle: %s; code=%lu\n", result == ERROR_SUCCESS ? "passed" : "failed",
         (unsigned long)result);
  return result == ERROR_SUCCESS ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc == 1) return validation_tests();
  if (argc == 2 && strcmp(argv[1], "--filter-lifecycle") == 0) return lifecycle_test();
  return 2;
}
