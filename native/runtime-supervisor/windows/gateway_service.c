/* LocalSystem broker. The SCM image and supervisor are the same protected installed file. */
#include "gateway_service.h"
#include "gateway_peer.h"
#include "gateway_wfp.h"
#include <userenv.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#define SERVICE_NAME L"KeikoRuntimeGateway"
#define PIPE_NAME L"\\\\.\\pipe\\KeikoRuntimeGateway-v1"
#define IO_TIMEOUT_MS 5000
#define CHALLENGE_SIZE KEIKO_GATEWAY_CHALLENGE_BYTES

static HANDLE stopping;
static SERVICE_STATUS_HANDLE registration;

/* Message pipes keep the hello, challenge, open and acknowledgement distinct. A short or
 * oversized message, a stop, or a timeout is fatal. Drain cancelled I/O before releasing o. */
static BOOL transfer(HANDLE pipe, void *data, DWORD size, BOOL write, HANDLE stop) {
  OVERLAPPED o = {0};
  HANDLE waits[2];
  DWORD count = 0;
  BOOL ok;
  o.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!o.hEvent) return FALSE;
  waits[0] = o.hEvent;
  waits[1] = stop;
  ok = write ? WriteFile(pipe, data, size, NULL, &o) : ReadFile(pipe, data, size, NULL, &o);
  if (!ok && GetLastError() == ERROR_IO_PENDING) {
    ok = WaitForMultipleObjects(stop ? 2 : 1, waits, FALSE, IO_TIMEOUT_MS) == WAIT_OBJECT_0;
    if (!ok) (void)CancelIoEx(pipe, &o);
    BOOL completed = GetOverlappedResult(pipe, &o, &count, TRUE);
    ok = ok && completed;
  } else if (ok) ok = GetOverlappedResult(pipe, &o, &count, FALSE);
  CloseHandle(o.hEvent);
  return ok && count == size;
}

static BOOL tree_sid(const BYTE *nonce, PSID *sid) {
  static const wchar_t hex[] = L"0123456789abcdef";
  /* The AppContainer moniker is limited to 64 characters. 128 bits of the
   * service-generated nonce identify the package; the full challenge binds the ACK. */
  wchar_t name[48] = L"Keiko.Gateway.";
  size_t offset = wcslen(name);
  for (size_t i = 0; i < 16; i++) {
    name[offset++] = hex[nonce[i] >> 4];
    name[offset++] = hex[nonce[i] & 15];
  }
  return SUCCEEDED(DeriveAppContainerSidFromAppContainerName(name, sid));
}

/* Trust the system's running service PID, never an identity asserted by the pipe. Hold
 * the process through acknowledgement so Windows cannot recycle its PID. */
static HANDLE scm_peer(HANDLE pipe) {
  SC_HANDLE manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT);
  SC_HANDLE service = manager ? OpenServiceW(manager, SERVICE_NAME, SERVICE_QUERY_STATUS) : NULL;
  SERVICE_STATUS_PROCESS status;
  DWORD bytes, pid;
  HANDLE server = NULL;
  if (service && GetNamedPipeServerProcessId(pipe, &pid)) {
    server = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (server && (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, (BYTE *)&status,
        sizeof(status), &bytes) || status.dwServiceType != SERVICE_WIN32_OWN_PROCESS ||
        status.dwCurrentState != SERVICE_RUNNING || status.dwProcessId != pid ||
        WaitForSingleObject(server, 0) != WAIT_TIMEOUT)) {
      CloseHandle(server);
      server = NULL;
    }
  }
  if (service) CloseServiceHandle(service);
  if (manager) CloseServiceHandle(manager);
  return server;
}

int keiko_gateway_connect(struct keiko_gateway_connection *c) {
  BYTE hello[4] = {'K','G','H','1'};
  c->pipe = CreateFileW(PIPE_NAME, GENERIC_READ | FILE_WRITE_DATA, 0, NULL, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IMPERSONATION, NULL);
  if (c->pipe == INVALID_HANDLE_VALUE) {
    fprintf(stderr, "gateway pipe unavailable: %lu\n", GetLastError());
    return 0;
  }
  c->server = scm_peer(c->pipe);
  if (!c->server) { fputs("gateway SCM identity unavailable\n", stderr); return 0; }
  if (!transfer(c->pipe, hello, sizeof(hello), TRUE, NULL) ||
      !transfer(c->pipe, c->nonce, CHALLENGE_SIZE, FALSE, NULL)) {
    fputs("gateway peer challenge unavailable\n", stderr); return 0;
  }
  if (!tree_sid(c->nonce, &c->sid)) { fputs("gateway package SID unavailable\n", stderr); return 0; }
  return 1;
}

int keiko_gateway_confirm(struct keiko_gateway_connection *c, HANDLE job, BYTE *frame) {
  BYTE acknowledgement[4 + CHALLENGE_SIZE];
  UINT64 value = (UINT64)(ULONG_PTR)job;
  memcpy(frame + 12, c->nonce, CHALLENGE_SIZE);
  memcpy(frame + 76, &value, sizeof(value));
  return transfer(c->pipe, frame, KEIKO_GATEWAY_OPEN_BYTES, TRUE, NULL) &&
      transfer(c->pipe, acknowledgement, sizeof(acknowledgement), FALSE, NULL) &&
      !memcmp(acknowledgement, "KGA1", 4) &&
      !memcmp(acknowledgement + 4, c->nonce, CHALLENGE_SIZE) &&
      WaitForSingleObject(c->server, 0) == WAIT_TIMEOUT;
}

void keiko_gateway_disconnect(struct keiko_gateway_connection *c) {
  if (c->pipe && c->pipe != INVALID_HANDLE_VALUE) CloseHandle(c->pipe);
  if (c->server) CloseHandle(c->server);
  if (c->sid) FreeSid(c->sid);
  SecureZeroMemory(c, sizeof(*c));
}

/* Only the single root in the supervisor's job can be admitted. Derive its package SID
 * from the actual token and require the service's fresh per-connection identity. */
static BOOL tree_matches(HANDLE job, PSID expected_sid) {
  JOBOBJECT_BASIC_PROCESS_ID_LIST ids = {0};
  BOOL member = FALSE, ok = FALSE;
  HANDLE process = NULL, token = NULL;
  BYTE info[sizeof(TOKEN_APPCONTAINER_INFORMATION) + SECURITY_MAX_SID_SIZE];
  DWORD bytes;
  if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, &ids, sizeof(ids), NULL) ||
      ids.NumberOfAssignedProcesses != 1 || ids.NumberOfProcessIdsInList != 1) return FALSE;
  process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)ids.ProcessIdList[0]);
  if (process && IsProcessInJob(process, job, &member) && member &&
      OpenProcessToken(process, TOKEN_QUERY, &token) &&
      GetTokenInformation(token, TokenAppContainerSid, info, sizeof(info), &bytes)) {
    PSID sid = ((TOKEN_APPCONTAINER_INFORMATION *)info)->TokenAppContainer;
    ok = sid && IsValidSid(sid) && EqualSid(sid, expected_sid);
  }
  if (token) CloseHandle(token);
  if (process) CloseHandle(process);
  return ok;
}

static DWORD serve(HANDLE pipe, HANDLE image) {
  BYTE hello[4], frame[KEIKO_GATEWAY_OPEN_BYTES], nonce[CHALLENGE_SIZE];
  BYTE ack[4 + CHALLENGE_SIZE] = {'K','G','A','1'};
  struct keiko_gateway_peer peer = {0};
  struct keiko_gateway_challenge challenge = {0};
  struct keiko_gateway_request request = {0};
  struct keiko_gateway_filters filters = {0};
  HANDLE source = NULL, job = NULL;
  PSID sid = NULL;
  BOOL owned = FALSE;
  DWORD cleanup = ERROR_SUCCESS;
  if (!transfer(pipe, hello, sizeof(hello), FALSE, stopping) || memcmp(hello, "KGH1", 4) ||
      keiko_gateway_peer_authenticate(pipe, image, &peer) != ERROR_SUCCESS ||
      keiko_gateway_challenge_issue(&challenge) != ERROR_SUCCESS) goto done;
  memcpy(nonce, challenge.nonce, sizeof(nonce));
  if (!transfer(pipe, nonce, sizeof(nonce), TRUE, stopping) ||
      !transfer(pipe, frame, sizeof(frame), FALSE, stopping) ||
      keiko_gateway_request_admit(&challenge, frame, sizeof(frame), &request) != ERROR_SUCCESS ||
      !tree_sid(nonce, &sid)) goto done;
  source = OpenProcess(PROCESS_DUP_HANDLE, FALSE, peer.pid);
  HANDLE remote_job = (HANDLE)(ULONG_PTR)request.job_handle;
  if (!source || !remote_job || !DuplicateHandle(source, remote_job,
      GetCurrentProcess(), &job, JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, FALSE, 0) ||
      !tree_matches(job, sid)) goto done;
  owned = TRUE;
  memcpy(ack + 4, nonce, CHALLENGE_SIZE);
  if (keiko_gateway_filters_open_guarded(sid, request.family, request.port, job, &filters) !=
      ERROR_SUCCESS || !transfer(pipe, ack, sizeof(ack), TRUE, stopping)) goto done;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    HANDLE waits[2] = {stopping, peer.process};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting,
        sizeof(accounting), NULL) || accounting.ActiveProcesses == 0 ||
        WaitForMultipleObjects(2, waits, FALSE, 100) != WAIT_TIMEOUT) break;
  }
done:
  if (owned) {
    (void)TerminateJobObject(job, 137);
    /* Retain durable denies if termination cannot be verified within the shutdown budget. */
    for (unsigned i = 0; i < 100; i++) {
      cleanup = keiko_gateway_filters_close(&filters);
      if (cleanup != ERROR_BUSY) break;
      Sleep(20);
    }
  }
  if (job) CloseHandle(job);
  if (source) CloseHandle(source);
  if (sid) FreeSid(sid);
  keiko_gateway_peer_close(&peer);
  return cleanup;
}

static BOOL accept_client(HANDLE pipe) {
  OVERLAPPED o = {0};
  DWORD count;
  BOOL ok;
  o.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!o.hEvent) return FALSE;
  ok = ConnectNamedPipe(pipe, &o);
  if (!ok) {
    DWORD error = GetLastError();
    if (error == ERROR_PIPE_CONNECTED) ok = TRUE;
    else if (error == ERROR_IO_PENDING) {
      HANDLE waits[2] = {o.hEvent, stopping};
      if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0)
        (void)CancelIoEx(pipe, &o);
      ok = GetOverlappedResult(pipe, &o, &count, TRUE);
    }
  }
  CloseHandle(o.hEvent);
  return ok;
}

static void report(DWORD state, DWORD error) {
  SERVICE_STATUS status = {0};
  status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  status.dwCurrentState = state;
  status.dwControlsAccepted = state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP : 0;
  status.dwWin32ExitCode = error;
  if (state == SERVICE_STOP_PENDING || state == SERVICE_START_PENDING) {
    status.dwCheckPoint = 1;
    status.dwWaitHint = 10000;
  }
  SetServiceStatus(registration, &status);
}

static DWORD WINAPI control(DWORD code, DWORD type, LPVOID data, LPVOID context) {
  (void)type; (void)data; (void)context;
  if (code == SERVICE_CONTROL_STOP) {
    report(SERVICE_STOP_PENDING, ERROR_SUCCESS);
    SetEvent(stopping);
  }
  return ERROR_SUCCESS;
}

static void WINAPI service_main(DWORD argc, LPWSTR *argv) {
  wchar_t *path;
  HANDLE image = INVALID_HANDLE_VALUE, pipe = INVALID_HANDLE_VALUE;
  DWORD error = ERROR_SUCCESS;
  (void)argc; (void)argv;
  registration = RegisterServiceCtrlHandlerExW(SERVICE_NAME, control, NULL);
  if (!registration) return;
  report(SERVICE_START_PENDING, ERROR_SUCCESS);
  path = calloc(32768, sizeof(wchar_t));
  if (!path) { report(SERVICE_STOPPED, ERROR_OUTOFMEMORY); return; }
  stopping = CreateEventW(NULL, TRUE, FALSE, NULL);
  DWORD length = GetModuleFileNameW(NULL, path, 32768);
  if (!stopping || !length || length >= 32768) { error = ERROR_INVALID_DATA; goto done; }
  image = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                      FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (image == INVALID_HANDLE_VALUE) { error = GetLastError(); goto done; }
  pipe = keiko_gateway_service_pipe(PIPE_NAME);
  if (pipe == INVALID_HANDLE_VALUE) { error = GetLastError(); goto done; }
  report(SERVICE_RUNNING, ERROR_SUCCESS);
  while (WaitForSingleObject(stopping, 0) == WAIT_TIMEOUT && accept_client(pipe)) {
    error = serve(pipe, image);
    DisconnectNamedPipe(pipe);
    if (error != ERROR_SUCCESS) break;
  }
  if (error == ERROR_SUCCESS && WaitForSingleObject(stopping, 0) != WAIT_OBJECT_0)
    error = ERROR_BROKEN_PIPE;
done:
  free(path);
  if (pipe && pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
  if (image != INVALID_HANDLE_VALUE) CloseHandle(image);
  report(SERVICE_STOPPED, error);
  if (stopping) CloseHandle(stopping);
}

int keiko_gateway_dispatch(void) {
  SERVICE_TABLE_ENTRYW services[] = {{SERVICE_NAME, service_main}, {NULL, NULL}};
  return StartServiceCtrlDispatcherW(services) ? 0 : 1;
}
