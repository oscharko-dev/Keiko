/* A checked execution copy delegates only to the digest-pinned executable of the
 * running SCM service. The installed helper subsequently authenticates the actual pipe. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <process.h>
#include <stdlib.h>
#include <wchar.h>
#include "../../portable-launcher/keiko-portable-sha256.h"

static BOOL digest_matches(HANDLE image, const wchar_t *pin) {
  BYTE bytes[4096], digest[32];
  char hex[65];
  DWORD count;
  keiko_sha256 hash;
  if (wcslen(pin) != 64 || !keiko_sha256_init(&hash)) return FALSE;
  do {
    if (!ReadFile(image, bytes, sizeof(bytes), &count, NULL) ||
        !keiko_sha256_update(&hash, bytes, count)) {
      keiko_sha256_clear(&hash);
      return FALSE;
    }
  } while (count);
  if (!keiko_sha256_final(&hash, digest)) return FALSE;
  keiko_sha256_hex(digest, hex);
  for (size_t i = 0; i < 64; i++) if (pin[i] != (wchar_t)hex[i]) return FALSE;
  return TRUE;
}

static BOOL running_image(wchar_t *path, DWORD length) {
  SC_HANDLE manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT);
  SC_HANDLE service = manager ? OpenServiceW(manager, L"KeikoRuntimeGateway", SERVICE_QUERY_STATUS) : NULL;
  SERVICE_STATUS_PROCESS status;
  DWORD bytes;
  BOOL ok = FALSE;
  if (service && QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, (BYTE *)&status,
      sizeof(status), &bytes) && status.dwServiceType == SERVICE_WIN32_OWN_PROCESS &&
      status.dwCurrentState == SERVICE_RUNNING) {
    HANDLE server = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, status.dwProcessId);
    if (server) {
      ok = QueryFullProcessImageNameW(server, 0, path, &length);
      CloseHandle(server);
    }
  }
  if (service) CloseServiceHandle(service);
  if (manager) CloseServiceHandle(manager);
  return ok;
}

int keiko_gateway_launch_installed(const wchar_t *pin) {
  wchar_t *path = calloc(32768, sizeof(*path));
  HANDLE locks[128];
  size_t locked = 0;
  HANDLE image = INVALID_HANDLE_VALUE;
  intptr_t child = -1;
  DWORD code = 1;
  const wchar_t *args[] = {L"keiko-runtime-supervisor", L"--gateway-supervised", NULL};
  if (!path || !running_image(path, 32768) || wcslen(path) < 4 ||
      path[1] != L':' || path[2] != L'\\' || GetDriveTypeW((wchar_t[]){path[0],L':',L'\\',0}) != DRIVE_FIXED)
    goto done;
  /* Lock each directory entry against replacement/reparse mutation until CreateProcess
   * returns. A digest check on an open leaf alone does not bind a later pathname launch. */
  for (wchar_t *end = path + 3; (end = wcschr(end, L'\\')) != NULL; ++end) {
    FILE_ATTRIBUTE_TAG_INFO info;
    if (locked == sizeof(locks)/sizeof(*locks)) goto done;
    *end = 0;
    HANDLE dir = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    *end = L'\\';
    if (dir == INVALID_HANDLE_VALUE) goto done;
    locks[locked++] = dir;
    if (!GetFileInformationByHandleEx(dir, FileAttributeTagInfo, &info, sizeof(info)) ||
        !(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
      goto done;
  }
  image = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                      FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  FILE_ATTRIBUTE_TAG_INFO info;
  if (image == INVALID_HANDLE_VALUE || !GetFileInformationByHandleEx(image, FileAttributeTagInfo,
      &info, sizeof(info)) || (info.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) ||
      !digest_matches(image, pin)) goto done;
  /* The CRT passes the numbered KRP control/response descriptors as well as stdio. */
  child = _wspawnv(_P_NOWAIT, path, args);
done:
  if (image != INVALID_HANDLE_VALUE) CloseHandle(image);
  for (size_t i = 0; i < locked; i++) CloseHandle(locks[i]);
  free(path);
  if (child != -1) {
    if (WaitForSingleObject((HANDLE)child, INFINITE) != WAIT_OBJECT_0 ||
        !GetExitCodeProcess((HANDLE)child, &code)) code = 1;
    CloseHandle((HANDLE)child);
  }
  return (int)code;
}
