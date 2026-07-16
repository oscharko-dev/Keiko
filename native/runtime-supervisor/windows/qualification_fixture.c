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

int wmain(int argc, wchar_t **argv) {
  PROCESS_INFORMATION child;
  STARTUPINFOW startup;
  /* Wide path buffers are heap-allocated: ~130 KiB of stack trips analyzer budgets (C6262). */
  wchar_t *executable, *command;
  unsigned char observation[12] = {'K', 'R', 'Q', '1', 0, 0, 0, 0, 0, 0, 0, 0};
  DWORD length;
  BOOL created;
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
  created = CreateProcessW(executable, command, NULL, NULL, FALSE, 0, NULL, NULL, &startup, &child);
  free(executable);
  free(command);
  if (!created) {
    return 3;
  }
  CloseHandle(child.hThread);
  write_u32(observation + 4, GetCurrentProcessId());
  write_u32(observation + 8, child.dwProcessId);
  if (fwrite(observation, 1, sizeof(observation), stdout) != sizeof(observation) ||
      fflush(stdout) != 0) {
    TerminateProcess(child.hProcess, 4);
    CloseHandle(child.hProcess);
    return 4;
  }
  CloseHandle(child.hProcess);
  Sleep(INFINITE);
  return 0;
}
