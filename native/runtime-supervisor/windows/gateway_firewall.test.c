/* Disposable-runner experiment only: a package/program/user/port-scoped inbound firewall rule.
 * AppContainer admission and exact outbound confinement remain separate required controls.
 * No production integration or local default invocation. Remove/read back every created rule. */
#define COBJMACROS
#include "gateway_wfp.h"
#include <netfw.h>
#include <sddl.h>
#include <rpc.h>
#include <stdio.h>
#include <stdlib.h>

struct gateway_firewall_fixture {
  INetFwPolicy2 *policy;
  INetFwRules *rules;
  BSTR name;
  int initialized;
  int installed;
};

static DWORD install_package_rule(const wchar_t *name, const wchar_t *package,
                                   const wchar_t *application, UINT16 family, UINT16 port) {
  STARTUPINFOEXW startup = {0};
  PROCESS_INFORMATION process = {0};
  SECURITY_ATTRIBUTES inheritable = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  HANDLE job = NULL, null_io = INVALID_HANDLE_VALUE;
  wchar_t powershell[MAX_PATH], *script = NULL, *command = NULL, *separator;
  DWORD result = ERROR_SUCCESS, length, code = 1;
  SIZE_T bytes = 0;
  int initialized = 0;
  script = calloc(32768, sizeof(wchar_t));
  command = calloc(32768, sizeof(wchar_t));
  if (script == NULL || command == NULL) { result = ERROR_OUTOFMEMORY; goto done; }
  length = GetModuleFileNameW(NULL, script, 32768);
  if (length == 0 || length >= 32768) { result = ERROR_BUFFER_OVERFLOW; goto done; }
  separator = wcsrchr(script, L'\\');
  if (separator == NULL) { result = ERROR_INVALID_NAME; goto done; }
  separator[1] = L'\0';
  length = GetSystemDirectoryW(powershell, MAX_PATH);
  if (length == 0 || length >= MAX_PATH ||
      wcscat_s(powershell, MAX_PATH, L"\\WindowsPowerShell\\v1.0\\powershell.exe") != 0 ||
      wcscat_s(script, 32768, L"gateway-firewall.ps1") != 0 ||
      wcschr(application, L'\"') != NULL ||
      _snwprintf_s(command, 32768, _TRUNCATE,
        L"\"%ls\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%ls\" "
        L"-RuleName %ls -PackageSid %ls -Program \"%ls\" -Family %u -Port %u",
        powershell, script, name, package, application, (unsigned)family, (unsigned)port) < 0) {
    result = ERROR_BUFFER_OVERFLOW; goto done;
  }
  /* A fixed script and bounded scalar arguments; no command-string evaluation. Suppress output
   * containing private identities. The process-only policy does not alter machine configuration. */
  null_io = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         &inheritable, OPEN_EXISTING, 0, NULL);
  (void)InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  startup.lpAttributeList = calloc(1, bytes);
  if (startup.lpAttributeList == NULL) { result = ERROR_OUTOFMEMORY; goto done; }
  if (null_io == INVALID_HANDLE_VALUE ||
      !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) {
    result = GetLastError(); goto done;
  }
  initialized = 1;
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = null_io;
  startup.StartupInfo.hStdOutput = null_io;
  startup.StartupInfo.hStdError = null_io;
  job = CreateJobObjectW(NULL, NULL);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job == NULL ||
      !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                  &null_io, sizeof(null_io), NULL, NULL) ||
      !CreateProcessW(powershell, command, NULL, NULL, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL,
        &startup.StartupInfo, &process) || !AssignProcessToJobObject(job, process.hProcess) ||
      ResumeThread(process.hThread) == (DWORD)-1) { result = GetLastError(); goto done; }
  if (WaitForSingleObject(process.hProcess, 30000) != WAIT_OBJECT_0) result = ERROR_TIMEOUT;
  else if (!GetExitCodeProcess(process.hProcess, &code)) result = GetLastError();
  else result = code;
done:
  if (process.hProcess != NULL) {
    if (WaitForSingleObject(process.hProcess, 0) != WAIT_OBJECT_0 &&
        !TerminateProcess(process.hProcess, 1)) result = GetLastError();
    if (job != NULL && !TerminateJobObject(job, 1)) result = GetLastError();
    if (WaitForSingleObject(process.hProcess, 5000) != WAIT_OBJECT_0) result = ERROR_TIMEOUT;
    CloseHandle(process.hProcess);
  }
  if (process.hThread != NULL) CloseHandle(process.hThread);
  if (job != NULL) CloseHandle(job);
  if (initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList);
  if (null_io != INVALID_HANDLE_VALUE) CloseHandle(null_io);
  free(script); free(command);
  return result;
}

DWORD gateway_firewall_close(struct gateway_firewall_fixture *owner) {
  HRESULT result = S_OK;
  if (owner == NULL) return ERROR_SUCCESS;
  if (owner->installed) {
    INetFwRule *remaining = NULL;
    result = INetFwRules_Remove(owner->rules, owner->name);
    if (result == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) result = S_OK;
    if (SUCCEEDED(result)) {
      HRESULT found = INetFwRules_Item(owner->rules, owner->name, &remaining);
      if (remaining != NULL) INetFwRule_Release(remaining);
      if (found != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) result = E_UNEXPECTED;
    }
  }
  if (owner->rules != NULL) INetFwRules_Release(owner->rules);
  if (owner->policy != NULL) INetFwPolicy2_Release(owner->policy);
  SysFreeString(owner->name);
  if (owner->initialized) CoUninitialize();
  free(owner);
  printf("socket-inbound-firewall-cleanup: code=%lu\n", (DWORD)result);
  return (DWORD)result;
}

DWORD gateway_firewall_open(PSID sid, const wchar_t *executable, UINT16 family, UINT16 port,
                             struct gateway_firewall_fixture **owned) {
  struct gateway_firewall_fixture *owner;
  INetFwRule *existing = NULL;
  UUID id;
  RPC_WSTR id_text = NULL;
  LPWSTR package_text = NULL;
  DWORD length;
  wchar_t *expanded = NULL;
  wchar_t name[100];
  HRESULT result;
  DWORD status;
  if (sid == NULL || !IsValidSid(sid) || executable == NULL || port == 0 ||
      (family != AF_INET && family != AF_INET6) || owned == NULL || *owned != NULL)
    return ERROR_INVALID_PARAMETER;
  owner = calloc(1, sizeof(*owner));
  if (owner == NULL) return ERROR_OUTOFMEMORY;
  result = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  if (FAILED(result)) goto done;
  owner->initialized = 1;
  status = UuidCreate(&id);
  if (status != RPC_S_OK && status != RPC_S_UUID_LOCAL_ONLY) { result = HRESULT_FROM_WIN32(status); goto done; }
  status = UuidToStringW(&id, &id_text);
  if (status != RPC_S_OK) { result = HRESULT_FROM_WIN32(status); goto done; }
  if (!ConvertSidToStringSidW(sid, &package_text)) {
    result = HRESULT_FROM_WIN32(GetLastError()); goto done;
  }
  expanded = calloc(32768, sizeof(wchar_t));
  if (expanded == NULL) { result = E_OUTOFMEMORY; goto done; }
  length = GetLongPathNameW(executable, expanded, 32768);
  if (length == 0 || length >= 32768) {
    result = HRESULT_FROM_WIN32(length == 0 ? GetLastError() : ERROR_BUFFER_OVERFLOW); goto done;
  }
  if (_snwprintf_s(name, 100, _TRUNCATE, L"Keiko.Gateway.Inbound.Fixture.%ls", id_text) < 0) {
    result = E_INVALIDARG; goto done;
  }
  owner->name = SysAllocString(name);
  if (owner->name == NULL) {
    result = E_OUTOFMEMORY; goto done;
  }
  result = CoCreateInstance(&CLSID_NetFwPolicy2, NULL, CLSCTX_INPROC_SERVER, &IID_INetFwPolicy2,
                             (void **)&owner->policy);
  if (SUCCEEDED(result)) result = INetFwPolicy2_get_Rules(owner->policy, &owner->rules);
  if (SUCCEEDED(result)) {
    result = INetFwRules_Item(owner->rules, owner->name, &existing);
    if (result != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) { result = E_UNEXPECTED; goto done; }
    /* INetFwRules::Add excludes LocalAppPackageId. NetSecurity's documented Package parameter
     * creates the complete rule; COM is used only for exact-name absence checks and cleanup. */
    owner->installed = 1;
    status = install_package_rule(name, package_text, expanded, family, port);
    result = HRESULT_FROM_WIN32(status);
  }
done:
  if (existing != NULL) INetFwRule_Release(existing);
  if (id_text != NULL) RpcStringFreeW(&id_text);
  if (package_text != NULL) LocalFree(package_text);
  free(expanded);
  if (SUCCEEDED(result)) *owned = owner;
  else (void)gateway_firewall_close(owner);
  printf("socket-inbound-firewall: code=%lu\n", (DWORD)result);
  return (DWORD)result;
}
