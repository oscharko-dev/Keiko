/* Disposable-runner experiment only. Never linked into a shipping service or local default test.
 * Qualifies Microsoft's separate inbound-loopback mechanism and coexistence with another deny. */
#include "gateway_wfp.h"
#include <sddl.h>
#include <rpc.h>
#include <stdio.h>
#include <stdlib.h>

struct gateway_inbound_fixture {
  HANDLE job;
  PROCESS_INFORMATION process;
};

DWORD gateway_inbound_stop(struct gateway_inbound_fixture *fixture) {
  DWORD result = ERROR_SUCCESS;
  if (fixture == NULL) return result;
  if (fixture->job != NULL && !TerminateJobObject(fixture->job, 0)) result = GetLastError();
  if (fixture->process.hProcess != NULL) {
    if (WaitForSingleObject(fixture->process.hProcess, 5000) != WAIT_OBJECT_0) result = ERROR_TIMEOUT;
    CloseHandle(fixture->process.hProcess);
  }
  if (fixture->process.hThread != NULL) CloseHandle(fixture->process.hThread);
  if (fixture->job != NULL) CloseHandle(fixture->job);
  free(fixture);
  return result;
}

DWORD gateway_inbound_start(PSID sid, struct gateway_inbound_fixture **owned) {
  struct gateway_inbound_fixture *fixture = calloc(1, sizeof(*fixture));
  STARTUPINFOEXW startup = {0};
  SECURITY_ATTRIBUTES inheritable = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  HANDLE null_io = INVALID_HANDLE_VALUE;
  LPWSTR text = NULL;
  wchar_t executable[MAX_PATH], command[MAX_PATH + 256];
  DWORD result = ERROR_SUCCESS, length;
  SIZE_T bytes = 0;
  int attributes_ready = 0;
  if (fixture == NULL) return ERROR_OUTOFMEMORY;
  if (owned == NULL || *owned != NULL || !ConvertSidToStringSidW(sid, &text)) {
    result = ERROR_INVALID_PARAMETER; goto done;
  }
  length = GetSystemDirectoryW(executable, MAX_PATH);
  if (length == 0 || length >= MAX_PATH ||
      wcscat_s(executable, MAX_PATH, L"\\CheckNetIsolation.exe") != 0 ||
      _snwprintf_s(command, MAX_PATH + 256, _TRUNCATE,
                    L"\"%ls\" LoopbackExempt -is -p=%ls", executable, text) < 0) {
    result = ERROR_BUFFER_OVERFLOW; goto done;
  }
  /* Do not capture the OS utility's localized output: it may contain the private package SID. */
  null_io = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         &inheritable, OPEN_EXISTING, 0, NULL);
  (void)InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  startup.lpAttributeList = calloc(1, bytes);
  if (startup.lpAttributeList == NULL) { result = ERROR_OUTOFMEMORY; goto done; }
  if (null_io == INVALID_HANDLE_VALUE ||
      !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) {
    result = GetLastError(); goto done;
  }
  attributes_ready = 1;
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = null_io;
  startup.StartupInfo.hStdOutput = null_io;
  startup.StartupInfo.hStdError = null_io;
  fixture->job = CreateJobObjectW(NULL, NULL);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (fixture->job == NULL ||
      !SetInformationJobObject(fixture->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                  &null_io, sizeof(null_io), NULL, NULL) ||
      !CreateProcessW(executable, command, NULL, NULL, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL,
        &startup.StartupInfo, &fixture->process) ||
      !AssignProcessToJobObject(fixture->job, fixture->process.hProcess) ||
      ResumeThread(fixture->process.hThread) == (DWORD)-1) { result = GetLastError(); goto done; }
  /* Bounded diagnostic readiness window; socket behavior, not process existence, is the oracle. */
  if (WaitForSingleObject(fixture->process.hProcess, 1000) != WAIT_TIMEOUT) result = ERROR_NOT_READY;
done:
  if (attributes_ready) DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList);
  if (null_io != INVALID_HANDLE_VALUE) CloseHandle(null_io);
  if (text != NULL) LocalFree(text);
  if (result == ERROR_SUCCESS) *owned = fixture;
  else {
    if (fixture->process.hProcess != NULL) (void)TerminateProcess(fixture->process.hProcess, 1);
    (void)gateway_inbound_stop(fixture);
  }
  printf("socket-inbound-provision: code=%lu\n", result);
  return result;
}

DWORD gateway_inbound_block(PSID sid, UINT16 family, HANDLE *owned) {
  FWPM_SESSION0 session = {0};
  FWPM_SUBLAYER0 sublayer = {0};
  FWPM_FILTER0 filter = {0};
  FWPM_FILTER_CONDITION0 condition = {0};
  UINT64 weight = 1;
  DWORD result;
  if (owned == NULL || *owned != NULL) return ERROR_INVALID_PARAMETER;
  session.flags = FWPM_SESSION_FLAG_DYNAMIC;
  session.txnWaitTimeoutInMSec = 5000;
  result = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, &session, owned);
  if (result != ERROR_SUCCESS) return result;
  sublayer.displayData.name = L"Keiko inbound deny coexistence fixture";
  sublayer.weight = 0x100;
  result = UuidCreate(&sublayer.subLayerKey);
  if (result == RPC_S_UUID_LOCAL_ONLY) result = ERROR_SUCCESS;
  if (result == ERROR_SUCCESS) result = FwpmSubLayerAdd0(*owned, &sublayer, NULL);
  filter.displayData.name = sublayer.displayData.name;
  filter.subLayerKey = sublayer.subLayerKey;
  filter.layerKey = family == AF_INET ? FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4 : FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6;
  filter.action.type = FWP_ACTION_BLOCK;
  filter.weight.type = FWP_UINT64;
  filter.weight.uint64 = &weight;
  condition.fieldKey = FWPM_CONDITION_ALE_PACKAGE_ID;
  condition.matchType = FWP_MATCH_EQUAL;
  condition.conditionValue.type = FWP_SID;
  condition.conditionValue.sid = sid;
  filter.numFilterConditions = 1;
  filter.filterCondition = &condition;
  if (result == ERROR_SUCCESS) result = FwpmFilterAdd0(*owned, &filter, NULL, NULL);
  if (result != ERROR_SUCCESS) { (void)FwpmEngineClose0(*owned); *owned = NULL; }
  return result;
}
