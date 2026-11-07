/* #4068 W1 (proposal C): the per-run closure of the user environment key. Needs no administrator
 * rights and never touches the real HKCU\Environment: every key, record and lock is a fresh fixture
 * of this test under HKCU\Software\Keiko\Test, deleted at the end. */
#include "gateway_environment.h"

#include <aclapi.h>
#include <sddl.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#define NAME_CHARS 192
#define REGISTRY_READ                                                                              \
  L"S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-"    \
  L"3456934681"

static wchar_t base[NAME_CHARS], key_path[NAME_CHARS], record_path[NAME_CHARS];
static wchar_t parent_path[NAME_CHARS], child_path[NAME_CHARS], lock_name[NAME_CHARS];
/* The same keys as security object names, the form the guard edits. */
static wchar_t key_object[NAME_CHARS], child_object[NAME_CHARS], missing_object[NAME_CHARS];
static wchar_t user_sid[SECURITY_MAX_SID_STRING_CHARACTERS];

static struct keiko_environment_target target(const wchar_t *object) {
  struct keiko_environment_target value = {HKEY_CURRENT_USER, object, record_path, lock_name};
  return value;
}

static int current_user_sid(void) {
  BYTE buffer[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
  DWORD size = 0;
  HANDLE token = NULL;
  wchar_t *text = NULL;
  int ok = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
  if (GetTokenInformation(token, TokenUser, buffer, sizeof(buffer), &size) &&
      ConvertSidToStringSidW(((TOKEN_USER *)buffer)->User.Sid, &text))
    ok = wcscpy_s(user_sid, ARRAYSIZE(user_sid), text) == 0;
  if (text != NULL) LocalFree(text);
  CloseHandle(token);
  return ok;
}

static int create_key(const wchar_t *path, const wchar_t *sddl) {
  SECURITY_ATTRIBUTES attributes = {sizeof(attributes), NULL, FALSE};
  HKEY key = NULL;
  int ok;
  if (sddl != NULL && !ConvertStringSecurityDescriptorToSecurityDescriptorW(
                          sddl, SDDL_REVISION_1, &attributes.lpSecurityDescriptor, NULL))
    return 0;
  ok = RegCreateKeyExW(HKEY_CURRENT_USER, path, 0, NULL, REG_OPTION_NON_VOLATILE, KEY_READ,
                       sddl == NULL ? NULL : &attributes, &key, NULL) == ERROR_SUCCESS;
  if (key != NULL) RegCloseKey(key);
  if (attributes.lpSecurityDescriptor != NULL) LocalFree(attributes.lpSecurityDescriptor);
  return ok;
}

/* The key the way Windows 11 ships HKCU\Environment, with the test's own user as full owner. */
static int create_environment(void) {
  wchar_t sddl[512];
  (void)RegDeleteTreeW(HKEY_CURRENT_USER, key_path);
  return _snwprintf_s(sddl, ARRAYSIZE(sddl), _TRUNCATE,
                      L"D:PAI(A;OICI;KR;;;RC)(A;OICI;KA;;;SY)(A;OICI;KA;;;%ls)(A;OICI;KR;;;AC)"
                      L"(A;OICI;KR;;;" REGISTRY_READ L")",
                      user_sid) >= 0 &&
         create_key(key_path, sddl);
}

/* The key's DACL as SDDL, or an empty string when it cannot be read. */
static void dacl_text(const wchar_t *object, wchar_t *out, size_t chars) {
  PSECURITY_DESCRIPTOR descriptor = NULL;
  wchar_t *text = NULL;
  out[0] = L'\0';
  if (GetNamedSecurityInfoW(object, SE_REGISTRY_KEY, DACL_SECURITY_INFORMATION, NULL, NULL, NULL,
                            NULL, &descriptor) == ERROR_SUCCESS &&
      ConvertSecurityDescriptorToStringSecurityDescriptorW(
          descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &text, NULL))
    (void)wcsncpy_s(out, chars, text, _TRUNCATE);
  if (text != NULL) LocalFree(text);
  if (descriptor != NULL) LocalFree(descriptor);
}

/* The same entries in the same order, and still protected. Windows adds the auto-inherited flag
 * (`AI`) to any DACL it sets; the real key already carries it, a freshly created fixture does not. */
static int same_entries(const wchar_t *before, const wchar_t *after) {
  const wchar_t *left = wcschr(before, L'('), *right = wcschr(after, L'(');
  return left != NULL && right != NULL && wcscmp(left, right) == 0 &&
         wcsncmp(before, L"D:P", 3) == 0 && wcsncmp(after, L"D:P", 3) == 0;
}

static int closed(const wchar_t *text) {
  return text[0] != L'\0' && wcsstr(text, L";;;AC)") == NULL &&
         wcsstr(text, REGISTRY_READ) == NULL && wcsstr(text, user_sid) != NULL;
}

static int record_present(void) {
  DWORD size = 0;
  return RegGetValueW(HKEY_CURRENT_USER, record_path, L"State", RRF_RT_ANY, NULL, NULL, &size) ==
         ERROR_SUCCESS;
}

static int check(int condition, const char *name) {
  if (!condition) printf("FAIL %s\n", name);
  return condition ? 0 : 1;
}

static int single_holder(const struct keiko_environment_holder *self) {
  struct keiko_environment_target guard = target(key_object);
  wchar_t before[1024], during[1024], after[1024];
  int failures = 0;
  if (!create_environment()) return check(0, "single: fixture");
  dacl_text(key_object, before, ARRAYSIZE(before));
  failures += check(keiko_environment_close(&guard, self) == ERROR_SUCCESS, "single: close");
  dacl_text(key_object, during, ARRAYSIZE(during));
  failures += check(closed(during) && record_present(), "single: closed and recorded");
  /* A repeated close by the same holder is one holder, not two. */
  failures += check(keiko_environment_close(&guard, self) == ERROR_SUCCESS, "single: close again");
  failures += check(keiko_environment_reopen(&guard, self) == ERROR_SUCCESS, "single: reopen");
  dacl_text(key_object, after, ARRAYSIZE(after));
  failures += check(same_entries(before, after), "single: restored exactly");
  failures += check(!record_present(), "single: record deleted");
  return failures;
}

static int start_suspended(PROCESS_INFORMATION *process, struct keiko_environment_holder *holder) {
  wchar_t command[] = L"cmd.exe /c exit 0";
  STARTUPINFOW startup = {sizeof(startup)};
  FILETIME exited, kernel, user;
  memset(process, 0, sizeof(*process));
  if (!CreateProcessW(NULL, command, NULL, NULL, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL,
                      NULL, &startup, process))
    return 0;
  holder->pid = process->dwProcessId;
  return GetProcessTimes(process->hProcess, &holder->created, &exited, &kernel, &user);
}

static void stop(PROCESS_INFORMATION *process) {
  if (process->hProcess == NULL) return;
  (void)TerminateProcess(process->hProcess, 0);
  (void)WaitForSingleObject(process->hProcess, 5000);
  CloseHandle(process->hThread);
  CloseHandle(process->hProcess);
  memset(process, 0, sizeof(*process));
}

/* Two live runs: the first to end leaves the key closed, the last one restores it. */
static int two_holders(const struct keiko_environment_holder *self) {
  struct keiko_environment_target guard = target(key_object);
  struct keiko_environment_holder other;
  PROCESS_INFORMATION process;
  wchar_t before[1024], during[1024], after[1024];
  int failures = 0;
  if (!create_environment() || !start_suspended(&process, &other)) {
    stop(&process);
    return check(0, "two: fixture");
  }
  dacl_text(key_object, before, ARRAYSIZE(before));
  failures += check(keiko_environment_close(&guard, self) == ERROR_SUCCESS, "two: close first");
  failures += check(keiko_environment_close(&guard, &other) == ERROR_SUCCESS, "two: close second");
  failures += check(keiko_environment_reopen(&guard, self) == ERROR_SUCCESS, "two: reopen first");
  dacl_text(key_object, during, ARRAYSIZE(during));
  failures += check(closed(during) && record_present(), "two: still closed for the second");
  failures += check(keiko_environment_reopen(&guard, &other) == ERROR_SUCCESS, "two: reopen last");
  dacl_text(key_object, after, ARRAYSIZE(after));
  failures += check(same_entries(before, after) && !record_present(), "two: restored by the last");
  stop(&process);
  return failures;
}

/* A run that died without reopening is pruned: the next run's close and reopen restore the key. */
static int crashed_holder(const struct keiko_environment_holder *self) {
  struct keiko_environment_target guard = target(key_object);
  struct keiko_environment_holder other;
  PROCESS_INFORMATION process;
  wchar_t before[1024], during[1024], after[1024];
  int failures = 0;
  if (!create_environment() || !start_suspended(&process, &other)) {
    stop(&process);
    return check(0, "crashed: fixture");
  }
  dacl_text(key_object, before, ARRAYSIZE(before));
  failures += check(keiko_environment_close(&guard, &other) == ERROR_SUCCESS, "crashed: close");
  stop(&process);
  dacl_text(key_object, during, ARRAYSIZE(during));
  failures += check(closed(during), "crashed: left closed");
  failures += check(keiko_environment_close(&guard, self) == ERROR_SUCCESS, "crashed: next close");
  failures += check(keiko_environment_reopen(&guard, self) == ERROR_SUCCESS, "crashed: reopen");
  dacl_text(key_object, after, ARRAYSIZE(after));
  failures += check(same_entries(before, after) && !record_present(), "crashed: restored");
  return failures;
}

static int record_bytes(BYTE *bytes, DWORD *size, int write) {
  if (write)
    return RegSetKeyValueW(HKEY_CURRENT_USER, record_path, L"State", REG_BINARY, bytes, *size) ==
           ERROR_SUCCESS;
  return RegGetValueW(HKEY_CURRENT_USER, record_path, L"State", RRF_RT_REG_BINARY, NULL, bytes,
                      size) == ERROR_SUCCESS;
}

/* A record that would put back more than read is refused, and the key stays closed. */
static int tampered_record(const struct keiko_environment_holder *self) {
  struct keiko_environment_target guard = target(key_object);
  BYTE saved[2048], tampered[2048];
  DWORD size = sizeof(saved);
  wchar_t before[1024], during[1024], after[1024];
  int failures = 0;
  if (!create_environment()) return check(0, "tampered: fixture");
  dacl_text(key_object, before, ARRAYSIZE(before));
  failures += check(keiko_environment_close(&guard, self) == ERROR_SUCCESS, "tampered: close");
  if (!record_bytes(saved, &size, 0) || size < 16) return failures + check(0, "tampered: read");
  memcpy(tampered, saved, size);
  /* The first removed entry's access mask becomes GENERIC_ALL. */
  tampered[8] = 0;
  tampered[9] = 0;
  tampered[10] = 0;
  tampered[11] = 0x10;
  if (!record_bytes(tampered, &size, 1)) return failures + check(0, "tampered: write");
  failures += check(keiko_environment_reopen(&guard, self) == ERROR_INVALID_DATA,
                    "tampered: reopen refused");
  dacl_text(key_object, during, ARRAYSIZE(during));
  failures += check(closed(during), "tampered: still closed");
  failures += check(keiko_environment_close(&guard, self) == ERROR_INVALID_DATA,
                    "tampered: close refused");
  if (!record_bytes(saved, &size, 1)) return failures + check(0, "tampered: repair");
  failures += check(keiko_environment_reopen(&guard, self) == ERROR_SUCCESS, "tampered: repaired");
  dacl_text(key_object, after, ARRAYSIZE(after));
  failures += check(same_entries(before, after), "tampered: restored after repair");
  return failures;
}

/* An inherited read entry cannot be removed on the key itself: the close is refused, untouched. */
static int inherited_entry(const struct keiko_environment_holder *self) {
  struct keiko_environment_target guard = target(child_object);
  wchar_t sddl[512], before[1024], after[1024];
  int failures = 0;
  if (_snwprintf_s(sddl, ARRAYSIZE(sddl), _TRUNCATE,
                   L"D:PAI(A;OICI;KA;;;SY)(A;OICI;KA;;;%ls)(A;OICI;KR;;;AC)", user_sid) < 0 ||
      !create_key(parent_path, sddl) || !create_key(child_path, NULL))
    return check(0, "inherited: fixture");
  dacl_text(child_object, before, ARRAYSIZE(before));
  failures += check(keiko_environment_close(&guard, self) == ERROR_NOT_SUPPORTED,
                    "inherited: close refused");
  dacl_text(child_object, after, ARRAYSIZE(after));
  failures += check(before[0] != L'\0' && wcscmp(before, after) == 0 && !record_present(),
                    "inherited: untouched");
  return failures;
}

/* A profile without the key has nothing to close; the record does not outlive the run. */
static int absent_key(const struct keiko_environment_holder *self) {
  struct keiko_environment_target guard = target(missing_object);
  int failures = 0;
  failures += check(keiko_environment_close(&guard, self) == ERROR_SUCCESS, "absent: close");
  failures += check(keiko_environment_reopen(&guard, self) == ERROR_SUCCESS, "absent: reopen");
  failures += check(!record_present(), "absent: record deleted");
  return failures;
}

static int fixture_names(void) {
  DWORD pid = GetCurrentProcessId();
  return _snwprintf_s(base, NAME_CHARS, _TRUNCATE, L"Software\\Keiko\\Test\\EnvironmentGuard-%lu",
                      pid) >= 0 &&
         _snwprintf_s(key_path, NAME_CHARS, _TRUNCATE, L"%ls\\Environment", base) >= 0 &&
         _snwprintf_s(record_path, NAME_CHARS, _TRUNCATE, L"%ls\\Record", base) >= 0 &&
         _snwprintf_s(parent_path, NAME_CHARS, _TRUNCATE, L"%ls\\Parent", base) >= 0 &&
         _snwprintf_s(child_path, NAME_CHARS, _TRUNCATE, L"%ls\\Parent\\Child", base) >= 0 &&
         _snwprintf_s(key_object, NAME_CHARS, _TRUNCATE, L"CURRENT_USER\\%ls", key_path) >= 0 &&
         _snwprintf_s(child_object, NAME_CHARS, _TRUNCATE, L"CURRENT_USER\\%ls", child_path) >= 0 &&
         _snwprintf_s(missing_object, NAME_CHARS, _TRUNCATE, L"CURRENT_USER\\%ls\\Missing", base) >=
             0 &&
         _snwprintf_s(lock_name, NAME_CHARS, _TRUNCATE, L"Local\\KeikoEnvironmentGuardTest-%lu",
                      pid) >= 0 &&
         current_user_sid();
}

int main(void) {
  struct keiko_environment_holder self;
  int failures = 0;
  if (!fixture_names() || !keiko_environment_holder_self(&self)) {
    puts("gateway-environment: fixture failed");
    return 1;
  }
  failures += single_holder(&self);
  failures += two_holders(&self);
  failures += crashed_holder(&self);
  failures += tampered_record(&self);
  failures += inherited_entry(&self);
  failures += absent_key(&self);
  (void)RegDeleteTreeW(HKEY_CURRENT_USER, base);
  puts(failures == 0 ? "gateway-environment-rules: passed" : "gateway-environment-rules: failed");
  return failures == 0 ? 0 : 1;
}
