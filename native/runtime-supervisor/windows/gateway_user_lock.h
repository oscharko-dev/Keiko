/* A per-user lock shared by every logon session of one user (#4242, ADR-0043 D18).
 *
 * The supervisor edits state that belongs to the user, not to a logon session: the user's registry
 * hive and the DACLs of the user's directories. A `Local\` mutex lives in one session's namespace,
 * so a console and an RDP session of the same user would not exclude each other. A `Global\` mutex
 * would, but creating one needs SeCreateGlobalPrivilege, which a standard user does not hold. An
 * exclusive byte-range lock on a file under the user's own LocalAppData needs no privilege, spans
 * sessions, and is released by the system when the holder dies, so no abandoned state exists.
 *
 * The directory comes from the LocalAppData known folder of the caller's token, never from the
 * LOCALAPPDATA variable: the supervisor helper starts with an empty environment. The file is created
 * with a protected DACL that grants only the calling user's SID (not the owner, which an elevated
 * first creation would make Administrators) and SYSTEM, and the opened handle must be a regular
 * file, not a planted directory or reparse point. Included by
 * the translation units that take the lock; every function is file-local so each native test
 * executable keeps linking exactly the sources it did before. */
#ifndef KEIKO_GATEWAY_USER_LOCK_H
#define KEIKO_GATEWAY_USER_LOCK_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <sddl.h>
#include <shlobj.h>
#include <stdio.h>
#include <wchar.h>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "uuid.lib")

#define KEIKO_USER_LOCK_PATH_CHARS 512u
#define KEIKO_USER_LOCK_POLL_MS 20u

/* A leaf is a plain file name: no separator, drive or stream marker and no dot-only name. */
static int keiko_user_lock_leaf_valid(const wchar_t *leaf) {
  size_t length = leaf == NULL ? 0 : wcslen(leaf);
  if (length == 0 || length > 80 || leaf[0] == L'.') return 0;
  for (size_t i = 0; i < length; i++)
    if (leaf[i] == L'\\' || leaf[i] == L'/' || leaf[i] == L':' || leaf[i] < 0x20 ||
        leaf[i] == L'*' || leaf[i] == L'?' || leaf[i] == L'"' || leaf[i] == L'<' ||
        leaf[i] == L'>' || leaf[i] == L'|')
      return 0;
  return 1;
}

static DWORD keiko_user_lock_directory_under(const wchar_t *base, wchar_t *directory) {
  if (_snwprintf_s(directory, KEIKO_USER_LOCK_PATH_CHARS, _TRUNCATE, L"%ls\\Keiko", base) < 0)
    return ERROR_BUFFER_OVERFLOW;
  if (!CreateDirectoryW(directory, NULL) && GetLastError() != ERROR_ALREADY_EXISTS)
    return GetLastError();
  if (_snwprintf_s(directory, KEIKO_USER_LOCK_PATH_CHARS, _TRUNCATE, L"%ls\\Keiko\\RuntimeSupervisor",
                   base) < 0)
    return ERROR_BUFFER_OVERFLOW;
  if (!CreateDirectoryW(directory, NULL) && GetLastError() != ERROR_ALREADY_EXISTS)
    return GetLastError();
  return ERROR_SUCCESS;
}

static DWORD keiko_user_lock_directory(wchar_t *directory) {
  PWSTR base = NULL;
  DWORD result;
  if (FAILED(SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DEFAULT, NULL, &base)))
    return ERROR_PATH_NOT_FOUND;
  if (base == NULL || wcslen(base) >= MAX_PATH || base[0] == L'\0' || base[1] != L':' ||
      base[2] != L'\\')
    result = ERROR_PATH_NOT_FOUND;
  else
    result = keiko_user_lock_directory_under(base, directory);
  CoTaskMemFree(base);
  return result;
}

/* The lock file's protected DACL: the calling user's own SID and SYSTEM, nothing broader. */
static DWORD keiko_user_lock_descriptor(PSECURITY_DESCRIPTOR *descriptor) {
  union {
    TOKEN_USER user;
    BYTE bytes[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
  } info;
  HANDLE token = NULL;
  DWORD size = 0, error = ERROR_SUCCESS;
  LPWSTR sid = NULL;
  wchar_t sddl[256];
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return GetLastError();
  if (!GetTokenInformation(token, TokenUser, &info, sizeof(info), &size)) error = GetLastError();
  CloseHandle(token);
  if (error != ERROR_SUCCESS) return error;
  if (!ConvertSidToStringSidW(info.user.User.Sid, &sid)) return GetLastError();
  if (_snwprintf_s(sddl, 256, _TRUNCATE, L"D:P(A;;FA;;;%ls)(A;;FA;;;SY)", sid) < 0)
    error = ERROR_BUFFER_OVERFLOW;
  LocalFree(sid);
  if (error == ERROR_SUCCESS &&
      !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, descriptor, NULL))
    error = GetLastError();
  return error;
}

/* Only a regular file may carry the lock: never a directory or a reparse point planted there. */
static int keiko_user_lock_regular_file(HANDLE lock) {
  BY_HANDLE_FILE_INFORMATION information;
  return GetFileInformationByHandle(lock, &information) &&
         (information.dwFileAttributes &
          (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0;
}

/* The lock file's path for a leaf; creates the user's lock directory. */
static DWORD keiko_user_lock_path(const wchar_t *leaf, wchar_t *path) {
  wchar_t directory[KEIKO_USER_LOCK_PATH_CHARS];
  DWORD result;
  if (!keiko_user_lock_leaf_valid(leaf)) return ERROR_INVALID_NAME;
  result = keiko_user_lock_directory(directory);
  if (result != ERROR_SUCCESS) return result;
  return _snwprintf_s(path, KEIKO_USER_LOCK_PATH_CHARS, _TRUNCATE, L"%ls\\%ls", directory, leaf) < 0
             ? ERROR_BUFFER_OVERFLOW
             : ERROR_SUCCESS;
}

/* Takes the exclusive lock, waiting at most wait_ms. Returns NULL and sets *error on failure; a
 * timeout is ERROR_TIMEOUT. Closing the returned handle releases the lock. */
static HANDLE keiko_user_lock_take(const wchar_t *leaf, DWORD wait_ms, DWORD *error) {
  wchar_t path[KEIKO_USER_LOCK_PATH_CHARS];
  PSECURITY_DESCRIPTOR descriptor = NULL;
  SECURITY_ATTRIBUTES security = {sizeof(security), NULL, FALSE};
  HANDLE lock;
  ULONGLONG deadline = GetTickCount64() + wait_ms;
  *error = keiko_user_lock_path(leaf, path);
  if (*error != ERROR_SUCCESS) return NULL;
  *error = keiko_user_lock_descriptor(&descriptor);
  if (*error != ERROR_SUCCESS) return NULL;
  security.lpSecurityDescriptor = descriptor;
  lock = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                     &security, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                     NULL);
  *error = lock == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  LocalFree(descriptor);
  if (lock == INVALID_HANDLE_VALUE) return NULL;
  if (!keiko_user_lock_regular_file(lock)) {
    *error = ERROR_CANT_ACCESS_FILE;
    CloseHandle(lock);
    return NULL;
  }
  for (;;) {
    OVERLAPPED range = {0};
    if (LockFileEx(lock, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &range))
      return lock;
    *error = GetLastError();
    if (*error != ERROR_LOCK_VIOLATION && *error != ERROR_IO_PENDING) break;
    if (GetTickCount64() >= deadline) {
      *error = ERROR_TIMEOUT;
      break;
    }
    Sleep(KEIKO_USER_LOCK_POLL_MS);
  }
  CloseHandle(lock);
  return NULL;
}

static void keiko_user_lock_drop(HANDLE lock) {
  OVERLAPPED range = {0};
  (void)UnlockFileEx(lock, 0, 1, 0, &range);
  CloseHandle(lock);
}

#endif
