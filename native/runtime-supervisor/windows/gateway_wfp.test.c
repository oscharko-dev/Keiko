/* Native validation and optional privileged filter-lifecycle proof. No runtime is enabled here. */
#include "gateway_wfp.h"
#include <sddl.h>
#include <stdio.h>
#include <string.h>
#include <rpc.h>

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

static DWORD assert_removed(const struct keiko_gateway_filters *before) {
  HANDLE engine = NULL;
  size_t index;
  DWORD result = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, NULL, &engine);
  if (result != ERROR_SUCCESS) return result;
  for (index = 0; index < 3; index++) {
    FWPM_FILTER0 *filter = NULL;
    DWORD found = FwpmFilterGetById0(engine, before->ids[index], &filter);
    if (filter != NULL) FwpmFreeMemory0((void **)&filter);
    if (found != FWP_E_FILTER_NOT_FOUND) result = ERROR_INVALID_DATA;
  }
  {
    FWPM_SUBLAYER0 *sublayer = NULL;
    DWORD found = FwpmSubLayerGetByKey0(engine, &before->sublayer, &sublayer);
    if (sublayer != NULL) FwpmFreeMemory0((void **)&sublayer);
    if (found != FWP_E_SUBLAYER_NOT_FOUND) result = ERROR_INVALID_DATA;
  }
  {
    DWORD closed = FwpmEngineClose0(engine);
    if (closed != ERROR_SUCCESS) return closed;
  }
  return result;
}

static int lifecycle_test(UINT16 family) {
  struct keiko_gateway_filters filters = {0};
  struct keiko_gateway_filters before = {0};
  PSID sid = NULL;
  DWORD result;
  if (!ConvertStringSidToSidW(L"S-1-15-2-112233-445566-778899-112244-335577-669988-123456", &sid))
    return 1;
  /* Synthetic package identity: these filters cannot affect any existing application. This is
   * only an installation/cleanup proof; the socket proof must use a real unique AppContainer. */
  result = keiko_gateway_filters_open(sid, family, 1983, &filters);
  if (result == ERROR_SUCCESS) {
    before = filters;
    result = keiko_gateway_filters_close(&filters);
    if (result == ERROR_SUCCESS) result = assert_removed(&before);
  }
  LocalFree(sid);
  printf("gateway-filter-lifecycle: %s; code=%lu\n", result == ERROR_SUCCESS ? "passed" : "failed",
         (unsigned long)result);
  return result == ERROR_SUCCESS ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc == 1) return validation_tests();
  if (argc == 2 && strcmp(argv[1], "--filter-lifecycle") == 0) {
    if (lifecycle_test(AF_INET) != 0) return 1;
    return lifecycle_test(AF_INET6);
  }
  return 2;
}
