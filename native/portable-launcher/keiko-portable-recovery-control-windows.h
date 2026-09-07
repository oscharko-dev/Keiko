#ifndef KEIKO_PORTABLE_RECOVERY_CONTROL_WINDOWS_H
#define KEIKO_PORTABLE_RECOVERY_CONTROL_WINDOWS_H

#if !defined(_WIN32)
#error "keiko-portable-recovery-control-windows.h requires Win32"
#endif

#include <windows.h>

#include <io.h>
#include <stddef.h>
#include <stdint.h>

static inline int keiko_recovery_read_control_windows(
    char content[KEIKO_RECOVERY_CONTROL_MAX_BYTES + 1u],
    uint64_t deadline_ms
) {
  HANDLE input = (HANDLE)_get_osfhandle(_fileno(stdin));
  size_t offset = 0;
  if (input == INVALID_HANDLE_VALUE || input == NULL) return 0;
  while (offset < KEIKO_RECOVERY_CONTROL_MAX_BYTES) {
    DWORD available = 0;
    int count;
    if (!PeekNamedPipe(input, NULL, 0, NULL, &available, NULL)) {
      DWORD error = GetLastError();
      if ((error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) && offset > 0u) {
        content[offset] = '\0';
        return 1;
      }
      return 0;
    }
    if (available == 0) {
      if (GetTickCount64() > deadline_ms) return 0;
      Sleep(10);
      continue;
    }
    if (available > KEIKO_RECOVERY_CONTROL_MAX_BYTES - offset)
      available = (DWORD)(KEIKO_RECOVERY_CONTROL_MAX_BYTES - offset);
    count = _read(_fileno(stdin), content + offset, available);
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return 0;
}

#endif
