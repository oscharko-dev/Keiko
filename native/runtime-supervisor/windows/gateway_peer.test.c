/* Actual local named-pipe peers; no installed service, elevation, filter or exemption changes. */
#include "gateway_peer.h"
#include <rpc.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

int gateway_peer_client(const char *pipe_name, int anonymous) {
  HANDLE pipe;
  DWORD count = 0;
  char byte = 'K';
  pipe = CreateFileA(pipe_name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                     SECURITY_SQOS_PRESENT | (anonymous ? SECURITY_ANONYMOUS : SECURITY_IMPERSONATION), NULL);
  if (pipe == INVALID_HANDLE_VALUE) return 41;
  if (!WriteFile(pipe, &byte, 1, &count, NULL) || count != 1 ||
      !ReadFile(pipe, &byte, 1, &count, NULL) || count != 1 || byte != 'A') {
    CloseHandle(pipe); return 42;
  }
  CloseHandle(pipe);
  return 0;
}

static int finish_io(HANDLE pipe, OVERLAPPED *operation, BOOL started, DWORD expected) {
  DWORD transferred = 0, error = started ? ERROR_SUCCESS : GetLastError();
  if (error != ERROR_SUCCESS && error != ERROR_IO_PENDING) return 0;
  if (!started && WaitForSingleObject(operation->hEvent, 5000) != WAIT_OBJECT_0) {
    (void)CancelIoEx(pipe, operation);
    (void)GetOverlappedResult(pipe, operation, &transferred, TRUE);
    return 0;
  }
  return GetOverlappedResult(pipe, operation, &transferred, FALSE) && transferred == expected;
}

static int peer_case(const wchar_t *executable, HANDLE approved_image, int anonymous, int accepted) {
  wchar_t name[128];
  wchar_t *command = calloc(33000, sizeof(wchar_t));
  RPC_WSTR id_text = NULL;
  UUID id;
  HANDLE pipe = INVALID_HANDLE_VALUE;
  PROCESS_INFORMATION child = {0};
  STARTUPINFOW startup = {0};
  OVERLAPPED operation = {0};
  struct keiko_gateway_peer peer = {0};
  DWORD code = 99, authenticated = ERROR_INVALID_DATA;
  char byte = 0;
  int ok = 0;
  if (command == NULL || UuidCreate(&id) != RPC_S_OK || UuidToStringW(&id, &id_text) != RPC_S_OK)
    goto done;
  if (_snwprintf_s(name, 128, _TRUNCATE, L"\\\\.\\pipe\\KeikoGatewayFixture-%ls", id_text) < 0)
    goto done;
  pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
    PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
    1, 1024, 1024, 1000, NULL);
  operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (pipe == INVALID_HANDLE_VALUE || operation.hEvent == NULL ||
      _snwprintf_s(command, 33000, _TRUNCATE, L"\"%ls\" --peer-client %ls %d",
                    executable, name, anonymous) < 0) goto done;
  startup.cb = sizeof(startup);
  if (!CreateProcessW(executable, command, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                       NULL, NULL, &startup, &child)) goto done;
  {
    BOOL connected = ConnectNamedPipe(pipe, &operation);
    DWORD error = connected ? ERROR_SUCCESS : GetLastError();
    if (error != ERROR_PIPE_CONNECTED && !finish_io(pipe, &operation, connected, 0)) goto done;
  }
  ResetEvent(operation.hEvent);
  if (!finish_io(pipe, &operation, ReadFile(pipe, &byte, 1, NULL, &operation), 1) || byte != 'K') goto done;
  authenticated = keiko_gateway_peer_authenticate(pipe, approved_image, &peer);
  if (accepted) {
    ok = authenticated == ERROR_SUCCESS && peer.pid == child.dwProcessId &&
         peer.process != NULL && peer.token != NULL &&
         WaitForSingleObject(peer.process, 0) == WAIT_TIMEOUT &&
         keiko_gateway_peer_authenticate(pipe, approved_image, &peer) == ERROR_INVALID_PARAMETER;
  } else ok = authenticated != ERROR_SUCCESS && peer.process == NULL && peer.token == NULL;
  byte = 'A';
  ResetEvent(operation.hEvent);
  if (!finish_io(pipe, &operation, WriteFile(pipe, &byte, 1, NULL, &operation), 1)) ok = 0;
  if (WaitForSingleObject(child.hProcess, 5000) != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(child.hProcess, &code) || code != 0) ok = 0;
done:
  keiko_gateway_peer_close(&peer);
  if (child.hProcess != NULL) {
    if (WaitForSingleObject(child.hProcess, 0) != WAIT_OBJECT_0) {
      (void)TerminateProcess(child.hProcess, 43);
      (void)WaitForSingleObject(child.hProcess, 5000);
    }
    CloseHandle(child.hProcess);
  }
  if (child.hThread != NULL) CloseHandle(child.hThread);
  if (operation.hEvent != NULL) CloseHandle(operation.hEvent);
  if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
  if (id_text != NULL) RpcStringFreeW(&id_text);
  free(command);
  return ok;
}

int gateway_peer_tests(void) {
  wchar_t *executable = calloc(32768, sizeof(wchar_t));
  wchar_t system_image[MAX_PATH];
  HANDLE approved = INVALID_HANDLE_VALUE, other = INVALID_HANDLE_VALUE;
  int ok = 0;
  if (executable == NULL || GetModuleFileNameW(NULL, executable, 32768) == 0 ||
      GetSystemDirectoryW(system_image, MAX_PATH) == 0 ||
      wcscat_s(system_image, MAX_PATH, L"\\kernel32.dll") != 0) goto done;
  approved = CreateFileW(executable, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  other = CreateFileW(system_image, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (approved == INVALID_HANDLE_VALUE || other == INVALID_HANDLE_VALUE) goto done;
  ok = peer_case(executable, approved, 0, 1) && peer_case(executable, other, 0, 0) &&
       peer_case(executable, approved, 1, 0);
done:
  if (approved != INVALID_HANDLE_VALUE) CloseHandle(approved);
  if (other != INVALID_HANDLE_VALUE) CloseHandle(other);
  free(executable);
  puts(ok ? "gateway-local-peer-authentication: passed" : "gateway-local-peer-authentication: failed");
  return ok ? 0 : 1;
}
