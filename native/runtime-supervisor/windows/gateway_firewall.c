#include "gateway_firewall.h"
#include <sddl.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define FIREWALL_RULE_PREFIX L"Keiko.Runtime.Tree.Inbound."
#define FIREWALL_TIMEOUT_MS 60000

/* Fixed scripts. They contain no double quote, so the command line needs no escaping, and they read
 * every value from the environment. Exit codes: 0 done, 12 cmdlet failure, 13 readback mismatch. */
static const wchar_t ADMIT_SCRIPT[] =
    L"$ErrorActionPreference='Stop';$n=$env:KEIKO_GATEWAY_RULE;$k=$env:KEIKO_GATEWAY_PACKAGE;"
    L"$p=$env:KEIKO_GATEWAY_PROGRAM;try{$r=New-NetFirewallRule -Name $n -DisplayName "
    L"'Keiko runtime tree inbound control' -PolicyStore PersistentStore -Package $k -Program $p "
    L"-Owner $env:KEIKO_GATEWAY_OWNER -Direction Inbound -Action Allow -Enabled True -Profile Any "
    L"-Protocol TCP -LocalAddress 127.0.0.1 -RemoteAddress 127.0.0.1 -EdgeTraversalPolicy Block "
    L"-Authentication NotRequired -OverrideBlockRules $false;"
    L"$a=$r|Get-NetFirewallApplicationFilter;$t=$r|Get-NetFirewallPortFilter;"
    L"if($a.Package -ne $k -or $a.Program -ne $p -or ($t.Protocol -ne 'TCP' -and "
    L"$t.Protocol -ne '6')){exit 13};exit 0}catch{exit 12}";
static const wchar_t REVOKE_SCRIPT[] =
    L"$ErrorActionPreference='Stop';$n=$env:KEIKO_GATEWAY_RULE;try{Get-NetFirewallRule -Name $n "
    L"-PolicyStore PersistentStore -ErrorAction SilentlyContinue|Remove-NetFirewallRule;"
    L"if(Get-NetFirewallRule -Name $n -PolicyStore PersistentStore -ErrorAction SilentlyContinue)"
    L"{exit 13};exit 0}catch{exit 12}";
static const wchar_t PRUNE_SCRIPT[] =
    L"$ErrorActionPreference='Stop';try{Get-NetFirewallRule -Name 'Keiko.Runtime.Tree.Inbound.*' "
    L"-PolicyStore PersistentStore -ErrorAction SilentlyContinue|Remove-NetFirewallRule;exit 0}"
    L"catch{exit 12}";

static const wchar_t *const FIREWALL_VARIABLES[] = {
    L"KEIKO_GATEWAY_RULE", L"KEIKO_GATEWAY_PACKAGE", L"KEIKO_GATEWAY_OWNER",
    L"KEIKO_GATEWAY_PROGRAM"};

static int package_sid(PSID sid) {
  const SID_IDENTIFIER_AUTHORITY authority = SECURITY_APP_PACKAGE_AUTHORITY;
  return sid != NULL && IsValidSid(sid) &&
         memcmp(GetSidIdentifierAuthority(sid), &authority, sizeof(authority)) == 0 &&
         *GetSidSubAuthorityCount(sid) == SECURITY_APP_PACKAGE_RID_COUNT &&
         *GetSidSubAuthority(sid, 0) == SECURITY_APP_PACKAGE_BASE_RID;
}

DWORD keiko_gateway_firewall_name(PSID package, wchar_t name[KEIKO_GATEWAY_FIREWALL_NAME_CHARS]) {
  wchar_t *text = NULL;
  DWORD result = ERROR_SUCCESS;
  if (name == NULL || !package_sid(package)) return ERROR_INVALID_PARAMETER;
  if (!ConvertSidToStringSidW(package, &text)) return GetLastError();
  if (_snwprintf_s(name, KEIKO_GATEWAY_FIREWALL_NAME_CHARS, _TRUNCATE, L"%ls%ls",
                   FIREWALL_RULE_PREFIX, text) < 0)
    result = ERROR_BUFFER_OVERFLOW;
  LocalFree(text);
  return result;
}

static void clear_variables(void) {
  for (size_t i = 0; i < sizeof(FIREWALL_VARIABLES) / sizeof(FIREWALL_VARIABLES[0]); i++)
    (void)SetEnvironmentVariableW(FIREWALL_VARIABLES[i], NULL);
}

static DWORD powershell_command(const wchar_t *script, wchar_t *powershell, wchar_t **command) {
  UINT length = GetSystemDirectoryW(powershell, MAX_PATH);
  size_t chars;
  if (length == 0 || length >= MAX_PATH ||
      wcscat_s(powershell, MAX_PATH, L"\\WindowsPowerShell\\v1.0\\powershell.exe") != 0)
    return ERROR_BUFFER_OVERFLOW;
  chars = wcslen(powershell) + wcslen(script) + 128;
  *command = calloc(chars, sizeof(wchar_t));
  if (*command == NULL) return ERROR_OUTOFMEMORY;
  if (_snwprintf_s(*command, chars, _TRUNCATE,
                   L"\"%ls\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"%ls\"",
                   powershell, script) < 0)
    return ERROR_BUFFER_OVERFLOW;
  return ERROR_SUCCESS;
}

/* The child runs in a kill-on-close job with null standard handles and a bounded wait. */
static DWORD start_in_job(wchar_t *powershell, wchar_t *command, HANDLE null_io, HANDLE job,
                          PROCESS_INFORMATION *process) {
  STARTUPINFOEXW startup = {0};
  SIZE_T bytes = 0;
  DWORD result = ERROR_SUCCESS;
  (void)InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  startup.lpAttributeList = calloc(1, bytes);
  if (startup.lpAttributeList == NULL) return ERROR_OUTOFMEMORY;
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) {
    result = GetLastError();
    free(startup.lpAttributeList);
    return result;
  }
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = null_io;
  startup.StartupInfo.hStdOutput = null_io;
  startup.StartupInfo.hStdError = null_io;
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 &null_io, sizeof(null_io), NULL, NULL) ||
      !CreateProcessW(powershell, command, NULL, NULL, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL,
                      NULL, &startup.StartupInfo, process) ||
      !AssignProcessToJobObject(job, process->hProcess) ||
      ResumeThread(process->hThread) == (DWORD)-1) {
    result = GetLastError();
    /* A suspended child that never joined the job, or never ran, must not outlive the call. */
    if (process->hProcess != NULL) (void)TerminateProcess(process->hProcess, 1);
  }
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList);
  return result;
}

static DWORD await_exit(HANDLE process) {
  DWORD code = 1;
  if (WaitForSingleObject(process, FIREWALL_TIMEOUT_MS) != WAIT_OBJECT_0) return ERROR_TIMEOUT;
  if (!GetExitCodeProcess(process, &code)) return GetLastError();
  return code == 0 ? ERROR_SUCCESS : code == 13 ? ERROR_INVALID_DATA : ERROR_FUNCTION_FAILED;
}

static DWORD run_netsecurity(const wchar_t *script) {
  SECURITY_ATTRIBUTES inheritable = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  PROCESS_INFORMATION process = {0};
  wchar_t powershell[MAX_PATH];
  wchar_t *command = NULL;
  HANDLE job = NULL, null_io;
  DWORD result = powershell_command(script, powershell, &command);
  null_io = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                        &inheritable, OPEN_EXISTING, 0, NULL);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (result == ERROR_SUCCESS && null_io == INVALID_HANDLE_VALUE) result = GetLastError();
  if (result == ERROR_SUCCESS) {
    job = CreateJobObjectW(NULL, NULL);
    if (job == NULL ||
        !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
      result = GetLastError();
  }
  if (result == ERROR_SUCCESS) result = start_in_job(powershell, command, null_io, job, &process);
  if (result == ERROR_SUCCESS) result = await_exit(process.hProcess);
  if (process.hProcess != NULL) CloseHandle(process.hProcess);
  if (process.hThread != NULL) CloseHandle(process.hThread);
  /* Closing the kill-on-close job ends a child that outlived its wait. */
  if (job != NULL) CloseHandle(job);
  if (null_io != INVALID_HANDLE_VALUE) CloseHandle(null_io);
  free(command);
  return result;
}

static DWORD set_sid_variable(const wchar_t *variable, PSID sid) {
  wchar_t *text = NULL;
  DWORD result = ERROR_SUCCESS;
  if (!ConvertSidToStringSidW(sid, &text)) return GetLastError();
  if (!SetEnvironmentVariableW(variable, text)) result = GetLastError();
  LocalFree(text);
  return result;
}

DWORD keiko_gateway_firewall_admit(PSID package, PSID owner, const wchar_t *program,
                                   struct keiko_gateway_firewall_rule *rule) {
  DWORD result;
  if (rule == NULL || rule->installed || owner == NULL || !IsValidSid(owner) || program == NULL ||
      wcslen(program) < 3 || program[1] != L':' || program[2] != L'\\')
    return ERROR_INVALID_PARAMETER;
  result = keiko_gateway_firewall_name(package, rule->name);
  if (result == ERROR_SUCCESS && !SetEnvironmentVariableW(L"KEIKO_GATEWAY_RULE", rule->name))
    result = GetLastError();
  if (result == ERROR_SUCCESS) result = set_sid_variable(L"KEIKO_GATEWAY_PACKAGE", package);
  if (result == ERROR_SUCCESS) result = set_sid_variable(L"KEIKO_GATEWAY_OWNER", owner);
  if (result == ERROR_SUCCESS && !SetEnvironmentVariableW(L"KEIKO_GATEWAY_PROGRAM", program))
    result = GetLastError();
  /* A failed creation can still leave a rule behind, so the caller always revokes. */
  rule->installed = result == ERROR_SUCCESS;
  if (result == ERROR_SUCCESS) result = run_netsecurity(ADMIT_SCRIPT);
  clear_variables();
  return result;
}

DWORD keiko_gateway_firewall_revoke(struct keiko_gateway_firewall_rule *rule) {
  DWORD result = ERROR_SUCCESS;
  if (rule == NULL || !rule->installed) return ERROR_SUCCESS;
  if (!SetEnvironmentVariableW(L"KEIKO_GATEWAY_RULE", rule->name)) result = GetLastError();
  if (result == ERROR_SUCCESS) result = run_netsecurity(REVOKE_SCRIPT);
  clear_variables();
  if (result == ERROR_SUCCESS) rule->installed = 0;
  return result;
}

DWORD keiko_gateway_firewall_prune(void) {
  return run_netsecurity(PRUNE_SCRIPT);
}
