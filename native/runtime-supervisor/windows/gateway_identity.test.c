/* Prove a fresh package identity is inherited and its temporary profile is removed after reaping.
 * No WFP/exemption/network calls. The only ACL change is to this temporary fixture executable. */
#include "gateway_wfp.h"
#include <userenv.h>
#include <aclapi.h>
#include <sddl.h>
#include <rpc.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

int gateway_firewall_user_tests(HANDLE process, PSID package);

DWORD gateway_test_grant_execute(wchar_t *path, PSID sid, PSECURITY_DESCRIPTOR *original);

int gateway_identity_leaf(const char *expected) {
  HANDLE token = NULL;
  BYTE storage[sizeof(TOKEN_APPCONTAINER_INFORMATION) + SECURITY_MAX_SID_SIZE];
  TOKEN_APPCONTAINER_INFORMATION *information = (TOKEN_APPCONTAINER_INFORMATION *)storage;
  PSID sid = NULL;
  DWORD bytes = 0, contained = 0;
  int ok = ConvertStringSidToSidA(expected, &sid) &&
           OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) &&
           GetTokenInformation(token, TokenIsAppContainer, &contained, sizeof(contained), &bytes) &&
           contained == 1 &&
           GetTokenInformation(token, TokenAppContainerSid, storage, sizeof(storage), &bytes) &&
           EqualSid(information->TokenAppContainer, sid);
  if (token != NULL) CloseHandle(token);
  if (sid != NULL) LocalFree(sid);
  return ok ? 0 : 51;
}

int gateway_identity_child(const char *expected) {
  wchar_t *executable = calloc(32768, sizeof(wchar_t));
  wchar_t *command = calloc(33000, sizeof(wchar_t));
  STARTUPINFOW startup = {0};
  PROCESS_INFORMATION process = {0};
  DWORD code = 99;
  int result = gateway_identity_leaf(expected);
  if (result != 0) goto done;
  if (executable == NULL || command == NULL || GetModuleFileNameW(NULL, executable, 32768) == 0 ||
      _snwprintf_s(command, 33000, _TRUNCATE, L"\"%ls\" --identity-leaf %hs", executable, expected) < 0) {
    result = 52; goto done;
  }
  startup.cb = sizeof(startup);
  if (!CreateProcessW(executable, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL,
                       &startup, &process) || WaitForSingleObject(process.hProcess, 5000) != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(process.hProcess, &code) || code != 0) result = 53;
done:
  if (process.hProcess != NULL) {
    if (WaitForSingleObject(process.hProcess, 0) != WAIT_OBJECT_0) {
      (void)TerminateProcess(process.hProcess, 53);
      (void)WaitForSingleObject(process.hProcess, 5000);
    }
    CloseHandle(process.hProcess);
  }
  if (process.hThread != NULL) CloseHandle(process.hThread);
  free(executable); free(command);
  return result;
}

int gateway_identity_tests(void) {
  wchar_t name[64];
  wchar_t *executable = calloc(32768, sizeof(wchar_t));
  wchar_t *command = calloc(33000, sizeof(wchar_t));
  UUID id;
  RPC_WSTR id_text = NULL;
  LPWSTR sid_text = NULL;
  PSID sid = NULL;
  PSECURITY_DESCRIPTOR original = NULL;
  STARTUPINFOEXW startup = {0};
  PROCESS_INFORMATION process = {0};
  SECURITY_CAPABILITIES capabilities = {0};
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  HANDLE job = NULL;
  SIZE_T size = 0;
  DWORD code = 99;
  int initialized = 0, ok = 0, stage = 0, profile_created = 0;
  if (executable == NULL || command == NULL || UuidCreate(&id) != RPC_S_OK ||
      UuidToStringW(&id, &id_text) != RPC_S_OK ||
      _snwprintf_s(name, 64, _TRUNCATE, L"Keiko.Identity.%ls", id_text) < 0) goto done;
  if (FAILED(CreateAppContainerProfile(name, name, L"Temporary Keiko identity fixture", NULL, 0, &sid)))
    goto done;
  profile_created = 1;
  if (!ConvertSidToStringSidW(sid, &sid_text) || GetModuleFileNameW(NULL, executable, 32768) == 0 ||
      gateway_test_grant_execute(executable, sid, &original) != ERROR_SUCCESS ||
      _snwprintf_s(command, 33000, _TRUNCATE, L"\"%ls\" --identity-child %ls", executable, sid_text) < 0)
    goto done;
  stage = 1;
  job = CreateJobObjectW(NULL, NULL);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job == NULL || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    goto done;
  (void)InitializeProcThreadAttributeList(NULL, 1, 0, &size);
  startup.lpAttributeList = calloc(1, size);
  if (startup.lpAttributeList == NULL || !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &size))
    goto done;
  initialized = 1;
  stage = 2;
  capabilities.AppContainerSid = sid;
  startup.StartupInfo.cb = sizeof(startup);
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                  &capabilities, sizeof(capabilities), NULL, NULL) ||
      !CreateProcessW(executable, command, NULL, NULL, FALSE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
        NULL, NULL, &startup.StartupInfo, &process) ||
      !AssignProcessToJobObject(job, process.hProcess) ||
      gateway_firewall_user_tests(process.hProcess, sid) != 0 || ResumeThread(process.hThread) == (DWORD)-1 ||
      WaitForSingleObject(process.hProcess, 10000) != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(process.hProcess, &code) || code != 0) goto done;
  ok = 1;
done:
  if (!ok) printf("gateway-profile-identity: stage=%d error=%lu child=%lu\n",
                   stage, (unsigned long)GetLastError(), (unsigned long)code);
  if (process.hProcess != NULL) {
    if (WaitForSingleObject(process.hProcess, 0) != WAIT_OBJECT_0) {
      (void)TerminateProcess(process.hProcess, 54);
      (void)WaitForSingleObject(process.hProcess, 5000);
    }
    CloseHandle(process.hProcess);
  }
  if (process.hThread != NULL) CloseHandle(process.hThread);
  if (job != NULL) CloseHandle(job);
  if (initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList);
  if (original != NULL) {
    PACL dacl = NULL;
    BOOL present = FALSE, defaulted = FALSE;
    if (!GetSecurityDescriptorDacl(original, &present, &dacl, &defaulted) || !present ||
        SetNamedSecurityInfoW(executable, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                              NULL, NULL, dacl, NULL) != ERROR_SUCCESS) ok = 0;
    LocalFree(original);
  }
  if (profile_created && FAILED(DeleteAppContainerProfile(name))) ok = 0;
  if (sid != NULL) FreeSid(sid);
  if (sid_text != NULL) LocalFree(sid_text);
  if (id_text != NULL) RpcStringFreeW(&id_text);
  free(executable); free(command);
  puts(ok ? "gateway-profile-identity: passed; root=matched descendant=matched profile=removed" :
            "gateway-profile-identity: failed");
  return ok ? 0 : 1;
}
