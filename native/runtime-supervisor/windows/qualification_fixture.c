#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void write_u32(unsigned char *value, uint32_t number) {
  value[0] = (unsigned char)number;
  value[1] = (unsigned char)(number >> 8);
  value[2] = (unsigned char)(number >> 16);
  value[3] = (unsigned char)(number >> 24);
}

static int write_observation(DWORD root, DWORD descendant) {
  unsigned char observation[12] = {'K', 'R', 'Q', '1', 0, 0, 0, 0, 0, 0, 0, 0};
  DWORD written = 0;
  write_u32(observation + 4, root);
  write_u32(observation + 8, descendant);
  /* PID bytes are binary: CRT text mode inserts CR before any 0x0a byte in a process ID. */
  return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), observation, sizeof(observation), &written, NULL) &&
         written == sizeof(observation);
}

int wmain(int argc, wchar_t **argv) {
  PROCESS_INFORMATION child;
  STARTUPINFOW startup;
  /* Wide path buffers are heap-allocated: ~130 KiB of stack trips analyzer budgets (C6262). */
  wchar_t *executable, *command;
  DWORD length;
  DWORD creation_flags = 0;
  BOOL created;
  /* Deterministic wire check only; these values are never reported as live processes. */
  if (argc == 2 && wcscmp(argv[1], L"--observation-encoding") == 0)
    return write_observation(0x010a0d00u, 0x020a1a04u) ? 0 : 5;
  if (argc == 2 && wcscmp(argv[1], L"--descendant") == 0) {
    Sleep(INFINITE);
    return 0;
  }
  executable = calloc(32768, sizeof(*executable));
  command = calloc(32780, sizeof(*command));
  if (executable == NULL || command == NULL) {
    free(executable);
    free(command);
    return 2;
  }
  length = GetModuleFileNameW(NULL, executable, 32768);
  if (length == 0 || length >= 32768 ||
      _snwprintf_s(command, 32780, _TRUNCATE, L"\"%ls\" --descendant", executable) < 0) {
    free(executable);
    free(command);
    return 2;
  }
  memset(&startup, 0, sizeof(startup));
  memset(&child, 0, sizeof(child));
  startup.cb = sizeof(startup);
  /* Console detachment must never detach a descendant from its owning Job Object (#4068 W2). */
  if (argc == 3 && wcscmp(argv[1], L"--qualified-detached") == 0) {
    creation_flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
  }
  created = CreateProcessW(executable, command, NULL, NULL, FALSE, creation_flags, NULL, NULL,
                           &startup, &child);
  free(executable);
  free(command);
  if (!created) {
    return 3;
  }
  CloseHandle(child.hThread);
  if (!write_observation(GetCurrentProcessId(), child.dwProcessId)) {
    TerminateProcess(child.hProcess, 4);
    CloseHandle(child.hProcess);
    return 4;
  }
  CloseHandle(child.hProcess);
  Sleep(INFINITE);
  return 0;
}
