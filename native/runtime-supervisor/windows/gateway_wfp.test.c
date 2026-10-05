/* Native validation and optional privileged filter-lifecycle proof. No runtime is enabled here. */
#include "gateway_wfp.h"
#include <sddl.h>
#include <stdio.h>
#include <string.h>
#include <rpc.h>
#include <stdlib.h>

int gateway_socket_proof(void);
int gateway_socket_child(int family, UINT16 gateway, UINT16 hostile);
int gateway_socket_leaf(int family, UINT16 gateway, UINT16 hostile);

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
    if (before->ids[index] == 0) continue;
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

static int guarded_child(void) {
  Sleep(INFINITE);
  return 0;
}

static int guarded_lifecycle_test(UINT16 family) {
  struct keiko_gateway_filters filters = {0};
  struct keiko_gateway_filters recovered = {0};
  struct keiko_gateway_filters before = {0};
  PSID sid = NULL;
  HANDLE job = NULL;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  PROCESS_INFORMATION child = {0};
  STARTUPINFOW startup = {0};
  static wchar_t executable[32768], command_line[32780];
  memset(executable, 0, sizeof(executable));
  memset(command_line, 0, sizeof(command_line));
  DWORD result = ERROR_SUCCESS;
  if (!ConvertStringSidToSidW(L"S-1-15-2-112233-445566-778899-112244-335577-669988-123456", &sid))
    return 1;
  job = CreateJobObjectW(NULL, NULL);
  if (job == NULL) { LocalFree(sid); return 1; }
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    CloseHandle(job);
    LocalFree(sid);
    return 1;
  }
  if (GetModuleFileNameW(NULL, executable, (DWORD)(sizeof(executable) / sizeof(executable[0]))) == 0 ||
      _snwprintf_s(command_line, sizeof(command_line) / sizeof(command_line[0]), _TRUNCATE,
                   L"\"%ls\" --guard-held", executable) < 0) {
    CloseHandle(job);
    LocalFree(sid);
    return 1;
  }
  startup.cb = sizeof(startup);
  if (!CreateProcessW(executable, command_line, NULL, NULL, FALSE,
                      CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL, &startup, &child) ||
      !AssignProcessToJobObject(job, child.hProcess) || ResumeThread(child.hThread) == (DWORD)-1) {
    if (child.hProcess != NULL) TerminateProcess(child.hProcess, 127);
    if (child.hThread != NULL) CloseHandle(child.hThread);
    if (child.hProcess != NULL) CloseHandle(child.hProcess);
    CloseHandle(job);
    LocalFree(sid);
    return 1;
  }
  result = keiko_gateway_filters_open_guarded(sid, family, 1983, job, &filters);
  if (result == ERROR_SUCCESS) {
    before = filters;
    result = keiko_gateway_filters_close(&filters);
    if (result == ERROR_BUSY) {
      /* Simulate loss of the original broker's volatile handles while the durable denies remain. */
      if (filters.guard_engine != NULL) (void)FwpmEngineClose0(filters.guard_engine);
      if (filters.job != NULL) CloseHandle(filters.job);
      filters.guard_engine = NULL;
      filters.job = NULL;
      result = keiko_gateway_filters_recover_guard(sid, job, &before.sublayer,
                                                    before.guard_keys, &recovered);
      if (result == ERROR_SUCCESS && keiko_gateway_filters_close(&recovered) != ERROR_BUSY)
        result = ERROR_INVALID_DATA;
      if (result == ERROR_SUCCESS && !TerminateJobObject(job, 127)) result = GetLastError();
      if (result == ERROR_SUCCESS && WaitForSingleObject(child.hProcess, 5000) != WAIT_OBJECT_0)
        result = ERROR_TIMEOUT;
      if (result == ERROR_SUCCESS) result = keiko_gateway_filters_close(&recovered);
      if (result == ERROR_SUCCESS) result = assert_removed(&before);
    } else if (result == ERROR_SUCCESS) {
      result = ERROR_INVALID_DATA;
    }
  }
  if (child.hProcess != NULL && WaitForSingleObject(child.hProcess, 0) == WAIT_TIMEOUT)
    (void)TerminateJobObject(job, 127);
  if (child.hThread != NULL) CloseHandle(child.hThread);
  if (child.hProcess != NULL) CloseHandle(child.hProcess);
  CloseHandle(job);
  LocalFree(sid);
  printf("gateway-guarded-lifecycle: family=%u %s; code=%lu\n", (unsigned)family,
         result == ERROR_SUCCESS ? "passed" : "failed", (unsigned long)result);
  return result == ERROR_SUCCESS ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc == 1) return validation_tests();
  if (argc == 2 && strcmp(argv[1], "--guard-held") == 0) return guarded_child();
  if (argc == 2 && strcmp(argv[1], "--socket-proof") == 0) return gateway_socket_proof();
  if (argc == 5 && strcmp(argv[1], "--socket-child") == 0) {
    return gateway_socket_child(atoi(argv[2]), (UINT16)atoi(argv[3]), (UINT16)atoi(argv[4]));
  }
  if (argc == 5 && strcmp(argv[1], "--socket-leaf") == 0) {
    return gateway_socket_leaf(atoi(argv[2]), (UINT16)atoi(argv[3]), (UINT16)atoi(argv[4]));
  }
  if (argc == 2 && strcmp(argv[1], "--filter-lifecycle") == 0) {
    if (lifecycle_test(AF_INET) != 0) return 1;
    return lifecycle_test(AF_INET6);
  }
  if (argc == 2 && strcmp(argv[1], "--guarded-lifecycle") == 0) {
    if (guarded_lifecycle_test(AF_INET) != 0) return 1;
    return guarded_lifecycle_test(AF_INET6);
  }
  return 2;
}
