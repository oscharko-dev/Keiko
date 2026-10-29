/* Disposable-runner qualification only. Never invoked by the default local test. */
#include "gateway_wfp.h"
#include <ws2ipdef.h>
#include <userenv.h>
#include <networkisolation.h>
#include <aclapi.h>
#include <rpc.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

struct socket_target { SOCKADDR_STORAGE address; int size; SOCKET listener; UINT16 port; };
typedef DWORD (WINAPI *get_config_fn)(DWORD *, PSID_AND_ATTRIBUTES *);
typedef DWORD (WINAPI *set_config_fn)(DWORD, PSID_AND_ATTRIBUTES);
struct gateway_inbound_fixture;
DWORD gateway_inbound_start(PSID sid, UINT16 family, struct gateway_inbound_fixture **owned);
DWORD gateway_inbound_stop(struct gateway_inbound_fixture *fixture);
DWORD gateway_inbound_block(PSID sid, UINT16 family, HANDLE *owned);
struct gateway_diagnostics;
DWORD gateway_diagnostics_start(const wchar_t *executable, struct gateway_diagnostics **owned);
DWORD gateway_diagnostics_read(struct gateway_diagnostics *owner, PSID sid);
DWORD gateway_diagnostics_stop(struct gateway_diagnostics *owner);
struct gateway_firewall_fixture;
void gateway_firewall_diagnose(struct gateway_firewall_fixture *owner, HANDLE child);
DWORD gateway_firewall_open(PSID sid, const wchar_t *executable, UINT16 family, UINT16 port,
                             struct gateway_firewall_fixture **owned);
DWORD gateway_firewall_close(struct gateway_firewall_fixture *owner);

static int bind_target(int family, struct socket_target *target) {
  BOOL exclusive = TRUE;
  memset(target, 0, sizeof(*target));
  target->listener = socket(family, SOCK_STREAM, IPPROTO_TCP);
  if (target->listener == INVALID_SOCKET) return 0;
  if (setsockopt(target->listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
                  (const char *)&exclusive, sizeof(exclusive)) != 0) return 0;
  if (family == AF_INET) {
    SOCKADDR_IN *address = (SOCKADDR_IN *)&target->address;
    address->sin_family = AF_INET;
    address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    target->size = sizeof(*address);
  } else {
    SOCKADDR_IN6 *address = (SOCKADDR_IN6 *)&target->address;
    address->sin6_family = AF_INET6;
    address->sin6_addr.u.Byte[15] = 1;
    target->size = sizeof(*address);
  }
  if (bind(target->listener, (SOCKADDR *)&target->address, target->size) != 0 ||
      getsockname(target->listener, (SOCKADDR *)&target->address, &target->size) != 0) return 0;
  target->port = family == AF_INET ? ntohs(((SOCKADDR_IN *)&target->address)->sin_port)
                                  : ntohs(((SOCKADDR_IN6 *)&target->address)->sin6_port);
  return 1;
}

static int listen_target(int family, struct socket_target *target) {
  return bind_target(family, target) && listen(target->listener, 8) == 0;
}

static int tcp_accepted(SOCKET listener) {
  /* Each bounded probe finishes before this readback. Accept and close its connections so the
   * eight-slot backlog cannot impersonate a later policy denial. Excess traffic fails closed. */
  for (int count = 0; count < 16; count++) {
    fd_set ready;
    struct timeval timeout = {0, 0};
    SOCKET client;
    int selected;
    FD_ZERO(&ready); FD_SET(listener, &ready);
    selected = select(0, &ready, NULL, NULL, &timeout);
    if (selected == 0) return count;
    if (selected < 0) return -1;
    client = accept(listener, NULL, NULL);
    if (client == INVALID_SOCKET) return -1;
    if (closesocket(client) != 0) return -1;
  }
  return -1;
}

static int connect_target(int family, UINT16 port, int *failure) {
  SOCKADDR_STORAGE storage = {0};
  int length, result, error = 0, error_size = sizeof(error);
  SOCKET client = socket(family, SOCK_STREAM, IPPROTO_TCP);
  u_long nonblocking = 1;
  fd_set write_set, error_set;
  struct timeval timeout = {2, 0};
  if (client == INVALID_SOCKET) {
    if (failure != NULL) *failure = WSAGetLastError();
    return 0;
  }
  if (family == AF_INET) {
    SOCKADDR_IN *address = (SOCKADDR_IN *)&storage;
    address->sin_family = AF_INET;
    address->sin_port = htons(port);
    address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    length = sizeof(*address);
  } else {
    SOCKADDR_IN6 *address = (SOCKADDR_IN6 *)&storage;
    address->sin6_family = AF_INET6;
    address->sin6_port = htons(port);
    address->sin6_addr.u.Byte[15] = 1;
    length = sizeof(*address);
  }
  if (ioctlsocket(client, FIONBIO, &nonblocking) != 0) {
    error = WSAGetLastError();
  } else if (connect(client, (SOCKADDR *)&storage, length) != 0) {
    error = WSAGetLastError();
  }
  if (error == WSAEWOULDBLOCK) {
    FD_ZERO(&write_set); FD_ZERO(&error_set);
    FD_SET(client, &write_set); FD_SET(client, &error_set);
    result = select(0, NULL, &write_set, &error_set, &timeout);
    if (result == 0) error = WSAETIMEDOUT;
    else if (result < 0) error = WSAGetLastError();
    else if (getsockopt(client, SOL_SOCKET, SO_ERROR, (char *)&error, &error_size) != 0)
      error = WSAGetLastError();
  }
  closesocket(client);
  if (failure != NULL) *failure = error;
  return error == 0;
}

int gateway_socket_client_tests(void) {
  WSADATA data;
  int ok = 1;
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return 1;
  for (int family = AF_INET; family <= AF_INET6; family += AF_INET6 - AF_INET) {
    struct socket_target server = {0}, refused = {0};
    int success_error = -1, refused_error = -1;
    server.listener = INVALID_SOCKET; refused.listener = INVALID_SOCKET;
    /* Reserve the negative control's port without listening so it cannot be reassigned. */
    if (!listen_target(family, &server) || !bind_target(family, &refused) ||
        !connect_target(family, server.port, &success_error) || success_error != 0 ||
        tcp_accepted(server.listener) != 1 ||
        connect_target(family, refused.port, &refused_error) ||
        (refused_error != WSAECONNREFUSED && refused_error != WSAETIMEDOUT)) ok = 0;
    {
      unsigned completed = 0;
      for (; completed < 16; completed++)
        if (!connect_target(family, server.port, &success_error) || tcp_accepted(server.listener) != 1) break;
      printf("gateway-host-listener-reuse: family=%d cycles=%u expected=16\n", family, completed);
      if (completed != 16) ok = 0;
    }
    if (server.listener != INVALID_SOCKET) closesocket(server.listener);
    if (refused.listener != INVALID_SOCKET) closesocket(refused.listener);
    printf("gateway-host-socket-client: family=%d accepted=%d refused=%d\n",
           family, success_error, refused_error);
  }
  WSACleanup();
  return ok ? 0 : 1;
}

static int udp_send(int family, UINT16 port) {
  SOCKADDR_STORAGE storage = {0};
  SOCKET client = socket(family, SOCK_DGRAM, IPPROTO_UDP);
  int length, result;
  if (client == INVALID_SOCKET) return 0;
  if (family == AF_INET) {
    SOCKADDR_IN *address = (SOCKADDR_IN *)&storage;
    address->sin_family = AF_INET;
    address->sin_port = htons(port);
    address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    length = sizeof(*address);
  } else {
    SOCKADDR_IN6 *address = (SOCKADDR_IN6 *)&storage;
    address->sin6_family = AF_INET6;
    address->sin6_port = htons(port);
    address->sin6_addr.u.Byte[15] = 1;
    length = sizeof(*address);
  }
  result = sendto(client, "K", 1, 0, (SOCKADDR *)&storage, length);
  closesocket(client);
  return result == 1;
}

static int appcontainer_member(void) {
  HANDLE token = NULL;
  DWORD contained = 0, returned = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
  if (!GetTokenInformation(token, TokenIsAppContainer, &contained, sizeof(contained), &returned)) {
    CloseHandle(token); return 0;
  }
  CloseHandle(token);
  return contained == 1;
}

int gateway_socket_leaf(int family, UINT16 gateway, UINT16 hostile) {
  WSADATA data;
  int result;
  if (!appcontainer_member() || WSAStartup(MAKEWORD(2, 2), &data) != 0) return 82;
  result = (connect_target(family, gateway, NULL) ? 1 : 0) | (connect_target(family, hostile, NULL) ? 2 : 0) |
           (udp_send(family, gateway) ? 4 : 0);
  WSACleanup();
  return result;
}

/* OpenCode is an HTTP server as well as a gateway client. Its host control route must be proven
 * separately from outbound TCP: a successful gateway request says nothing about inbound access. */
int gateway_socket_server(int family) {
  WSADATA data;
  struct socket_target server = {0};
  unsigned char announcement[8] = {'K', 'S', 'V', '1', 0, 0, 0, 0};
  DWORD written = 0;
  fd_set ready;
  /* The runner-only NetSecurity fixture may cold-start PowerShell after this port announcement.
   * This bounds setup only; the parent's actual network-connect deadline remains two seconds. */
  struct timeval timeout = {40, 0};
  SOCKET connection = INVALID_SOCKET;
  int result = 91, ready_count;
  if (!appcontainer_member() || WSAStartup(MAKEWORD(2, 2), &data) != 0) return result;
  server.listener = INVALID_SOCKET;
  if (!listen_target(family, &server)) goto done;
  announcement[4] = (unsigned char)server.port;
  announcement[5] = (unsigned char)(server.port >> 8);
  announcement[6] = (unsigned char)family;
  if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), announcement, sizeof(announcement), &written, NULL) ||
      written != sizeof(announcement)) goto done;
  FD_ZERO(&ready); FD_SET(server.listener, &ready);
  ready_count = select(0, &ready, NULL, NULL, &timeout);
  if (ready_count <= 0) {
    result = ready_count == 0 ? WSAETIMEDOUT : WSAGetLastError();
    goto done;
  }
  connection = accept(server.listener, NULL, NULL);
  result = connection != INVALID_SOCKET && send(connection, "K", 1, 0) == 1 ? 0 : WSAGetLastError();
done:
  if (connection != INVALID_SOCKET) closesocket(connection);
  if (server.listener != INVALID_SOCKET) closesocket(server.listener);
  WSACleanup();
  return result;
}

static DWORD read_server_port(HANDLE output, int family, UINT16 *port) {
  unsigned char bytes[8];
  DWORD available = 0, count = 0;
  ULONGLONG deadline = GetTickCount64() + 5000;
  while (GetTickCount64() < deadline) {
    if (!PeekNamedPipe(output, NULL, 0, NULL, &available, NULL)) return GetLastError();
    if (available >= sizeof(bytes)) {
      if (!ReadFile(output, bytes, sizeof(bytes), &count, NULL)) return GetLastError();
      if (count != sizeof(bytes) || memcmp(bytes, "KSV1", 4) != 0 ||
          bytes[6] != family || bytes[7] != 0) return ERROR_INVALID_DATA;
      *port = (UINT16)((UINT16)bytes[4] | ((UINT16)bytes[5] << 8));
      return *port != 0 ? ERROR_SUCCESS : ERROR_INVALID_DATA;
    }
    Sleep(10);
  }
  return ERROR_TIMEOUT;
}

static DWORD control_route_probe(PSID sid, const wchar_t *executable, int family, const char *phase,
                                  PSID_AND_ATTRIBUTES network, PSID firewall_sid) {
  STARTUPINFOEXW startup = {0};
  PROCESS_INFORMATION child = {0};
  SECURITY_CAPABILITIES capabilities = {0};
  SECURITY_ATTRIBUTES inheritable = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  HANDLE output = NULL, inherited[3] = {NULL, NULL, NULL}, job = NULL;
  SIZE_T size = 0;
  wchar_t *command = calloc(33000, sizeof(wchar_t));
  DWORD result = ERROR_INVALID_DATA, code = 99;
  UINT16 port = 0;
  int initialized = 0, socket_error = 0;
  struct gateway_firewall_fixture *firewall = NULL;
  if (command == NULL) return ERROR_OUTOFMEMORY;
  if (!CreatePipe(&output, &inherited[1], &inheritable, 0) ||
      !SetHandleInformation(output, HANDLE_FLAG_INHERIT, 0)) { result = GetLastError(); goto done; }
  inherited[0] = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              &inheritable, OPEN_EXISTING, 0, NULL);
  inherited[2] = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              &inheritable, OPEN_EXISTING, 0, NULL);
  if (inherited[0] == INVALID_HANDLE_VALUE || inherited[2] == INVALID_HANDLE_VALUE) {
    result = GetLastError(); goto done;
  }
  (void)InitializeProcThreadAttributeList(NULL, 2, 0, &size);
  startup.lpAttributeList = calloc(1, size);
  if (startup.lpAttributeList == NULL || !InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &size)) {
    result = ERROR_OUTOFMEMORY; goto done;
  }
  initialized = 1;
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = inherited[0];
  startup.StartupInfo.hStdOutput = inherited[1];
  startup.StartupInfo.hStdError = inherited[2];
  capabilities.AppContainerSid = sid;
  capabilities.Capabilities = network;
  capabilities.CapabilityCount = network == NULL ? 0 : 1;
  job = CreateJobObjectW(NULL, NULL);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job == NULL || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                  inherited, sizeof(inherited), NULL, NULL) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                  &capabilities, sizeof(capabilities), NULL, NULL) ||
      _snwprintf_s(command, 33000, _TRUNCATE, L"\"%ls\" --socket-server %d", executable, family) < 0 ||
      !CreateProcessW(executable, command, NULL, NULL, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL,
        &startup.StartupInfo, &child) || !AssignProcessToJobObject(job, child.hProcess) ||
      ResumeThread(child.hThread) == (DWORD)-1) { result = GetLastError(); goto done; }
  CloseHandle(inherited[1]); inherited[1] = NULL;
  result = read_server_port(output, family, &port);
  if (result == ERROR_SUCCESS && firewall_sid != NULL)
    result = gateway_firewall_open(firewall_sid, executable, (UINT16)family, port, &firewall);
  if (result == ERROR_SUCCESS && !connect_target(family, port, &socket_error)) {
    gateway_firewall_diagnose(firewall, child.hProcess);
    result = ERROR_CONNECTION_REFUSED;
  }
  if (result == ERROR_SUCCESS && (WaitForSingleObject(child.hProcess, 5000) != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(child.hProcess, &code) || code != 0)) result = ERROR_INVALID_DATA;
done:
  if (child.hProcess != NULL) {
    /* Preserve whether the listener actually remained alive on a failed host connection. */
    (void)GetExitCodeProcess(child.hProcess, &code);
    if (WaitForSingleObject(child.hProcess, 0) != WAIT_OBJECT_0) {
      (void)TerminateProcess(child.hProcess, 92);
      (void)WaitForSingleObject(child.hProcess, 5000);
    }
    CloseHandle(child.hProcess);
  }
  if (child.hThread != NULL) CloseHandle(child.hThread);
  if (job != NULL) CloseHandle(job);
  if (initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList);
  if (output != NULL) CloseHandle(output);
  for (size_t index = 0; index < 3; index++)
    if (inherited[index] != NULL && inherited[index] != INVALID_HANDLE_VALUE) CloseHandle(inherited[index]);
  free(command);
  if (firewall != NULL) {
    DWORD closed = gateway_firewall_close(firewall);
    if (closed != ERROR_SUCCESS) result = closed;
  }
  printf("socket-host-control-route: phase=%s family=%d code=%lu child=%lu winsock=%d\n",
         phase, family, result, code, socket_error);
  return result;
}

static DWORD unfiltered_inbound_probe(PSID sid, const wchar_t *executable, int family,
                                       PSID_AND_ATTRIBUTES network) {
  struct gateway_inbound_fixture *owner = NULL;
  DWORD result = gateway_inbound_start(sid, (UINT16)family, &owner), closed;
  if (result == ERROR_SUCCESS)
    result = control_route_probe(sid, executable, family, "unfiltered-inbound-firewall", network, sid);
  closed = gateway_inbound_stop(owner);
  return closed == ERROR_SUCCESS ? result : closed;
}

static DWORD run_child(PSID sid, const wchar_t *executable, int family,
                       UINT16 gateway, UINT16 hostile, DWORD *observed, PSID_AND_ATTRIBUTES network);
static int udp_received(SOCKET listener);

static DWORD foreign_principal_probe(PSID sid, PSID peer_sid, const wchar_t *executable,
                                       int family, PSID_AND_ATTRIBUTES network) {
  struct gateway_inbound_fixture *owner = NULL;
  DWORD result = gateway_inbound_start(peer_sid, (UINT16)family, &owner), closed;
  /* First prove this peer can receive with its own rule; its subsequent refusal must be about
   * the wrong package rule, not an unavailable peer listener or missing isolation permit. */
  if (result == ERROR_SUCCESS)
    result = control_route_probe(peer_sid, executable, family, "foreign-baseline", network, peer_sid);
  if (result == ERROR_SUCCESS &&
      control_route_probe(peer_sid, executable, family, "foreign-principal", network, sid) !=
        ERROR_CONNECTION_REFUSED) result = ERROR_INVALID_DATA;
  closed = gateway_inbound_stop(owner);
  return closed == ERROR_SUCCESS ? result : closed;
}

/* Keep ownership orchestration testable without changing this host's network policy. */
enum inbound_pair_step { PAIR_START, PAIR_PRIMARY, PAIR_PEER, PAIR_STOP, PAIR_SURVIVOR, PAIR_REVOKED };
typedef DWORD (*inbound_pair_step_fn)(void *, enum inbound_pair_step);

static DWORD inbound_pair_lifetime(void *context, inbound_pair_step_fn step) {
  DWORD result = step(context, PAIR_START), closed;
  if (result == ERROR_SUCCESS) result = step(context, PAIR_PRIMARY);
  if (result == ERROR_SUCCESS) result = step(context, PAIR_PEER);
  /* Always reap the second owner, including partial startup and failed socket controls. */
  closed = step(context, PAIR_STOP);
  if (closed != ERROR_SUCCESS) return closed;
  if (result == ERROR_SUCCESS) result = step(context, PAIR_SURVIVOR);
  if (result == ERROR_SUCCESS) result = step(context, PAIR_REVOKED);
  return result;
}

struct inbound_pair_control {
  PSID primary, peer;
  UINT16 family;
  const wchar_t *executable;
  PSID_AND_ATTRIBUTES network;
  struct gateway_inbound_fixture *owner;
};

static DWORD inbound_pair_control_step(void *context, enum inbound_pair_step step) {
  struct inbound_pair_control *control = context;
  DWORD result;
  PSID sid = step == PAIR_PEER || step == PAIR_REVOKED ? control->peer : control->primary;
  const char *phase = step == PAIR_PEER ? "concurrent-peer" :
    step == PAIR_SURVIVOR ? "concurrent-survivor" :
    step == PAIR_REVOKED ? "concurrent-peer-reaped" : "concurrent-primary";
  if (step == PAIR_START) return gateway_inbound_start(control->peer, control->family, &control->owner);
  if (step == PAIR_STOP) {
    result = gateway_inbound_stop(control->owner);
    control->owner = NULL;
    return result;
  }
  result = control_route_probe(sid, control->executable, control->family, phase, control->network, sid);
  if (step != PAIR_REVOKED) return result;
  return result == ERROR_CONNECTION_REFUSED ? ERROR_SUCCESS :
    result == ERROR_SUCCESS ? ERROR_INVALID_DATA : result;
}

struct inbound_pair_model { int alive; unsigned seen; enum inbound_pair_step failure; };
static DWORD inbound_pair_model_step(void *context, enum inbound_pair_step step) {
  struct inbound_pair_model *model = context;
  model->seen |= 1u << step;
  if (step == PAIR_START) model->alive = 1;
  if (step == PAIR_STOP) model->alive = 0;
  if (step == model->failure) return ERROR_ACCESS_DENIED;
  if ((step == PAIR_PRIMARY || step == PAIR_PEER) && !model->alive) return ERROR_INVALID_STATE;
  if ((step == PAIR_SURVIVOR || step == PAIR_REVOKED) && model->alive) return ERROR_INVALID_STATE;
  return ERROR_SUCCESS;
}

int gateway_inbound_concurrency_tests(void) {
  struct inbound_pair_model model = {0, 0, (enum inbound_pair_step)-1};
  int ok = inbound_pair_lifetime(&model, inbound_pair_model_step) == ERROR_SUCCESS &&
           !model.alive && model.seen == 63u;
  for (int failure = PAIR_START; failure <= PAIR_REVOKED; failure++) {
    model.alive = 0; model.seen = 0; model.failure = (enum inbound_pair_step)failure;
    if (inbound_pair_lifetime(&model, inbound_pair_model_step) == ERROR_SUCCESS || model.alive ||
        (model.seen & (1u << PAIR_STOP)) == 0) ok = 0;
  }
  puts(ok ? "gateway-inbound-concurrency-oracle: passed" : "gateway-inbound-concurrency-oracle: failed");
  return ok ? 0 : 1;
}

static DWORD scoped_inbound_probe(PSID sid, PSID peer_sid, const wchar_t *executable, int family, int control_family,
                                  UINT16 gateway, UINT16 hostile, SOCKET udp, SOCKET gateway_listener,
                                  PSID_AND_ATTRIBUTES network) {
  struct gateway_inbound_fixture *owner = NULL;
  struct inbound_pair_control pair = {sid, peer_sid, (UINT16)control_family, executable, network, NULL};
  struct gateway_diagnostics *diagnostics = NULL;
  HANDLE deny = NULL;
  DWORD result = gateway_diagnostics_start(executable, &diagnostics), closed;
  DWORD observed = 99, concurrent_result = ERROR_SUCCESS;
  printf("socket-control-composition: gateway-family=%d control-family=%d\n", family, control_family);
  /* Establish a real blocked-flow control inside the diagnostic interval, even if the inbound
   * route subsequently fails. Zero recorded drops then means an unqualified diagnostic. */
  if (result == ERROR_SUCCESS) {
    result = run_child(sid, executable, family, gateway, hostile, &observed, network);
    printf("socket-diagnostic-control: family=%d code=%lu observations=%lu expected-tcp-mask=1\n",
           family, result, observed);
    if (result == ERROR_SUCCESS &&
        (observed > 7 || (observed & 3) != 1 || udp_received(udp) != 0 ||
         tcp_accepted(gateway_listener) != 2)) result = ERROR_INVALID_DATA;
  }
  if (result == ERROR_SUCCESS)
    result = foreign_principal_probe(sid, peer_sid, executable, control_family, network);
  if (result == ERROR_SUCCESS) result = gateway_inbound_start(sid, (UINT16)control_family, &owner);
  if (result == ERROR_SUCCESS)
    result = control_route_probe(sid, executable, control_family, "inbound-firewall", network, sid);
  if (result == ERROR_SUCCESS) {
    concurrent_result = inbound_pair_lifetime(&pair, inbound_pair_control_step);
    printf("socket-inbound-concurrent-owner: code=%lu\n", concurrent_result);
  }
  if (result == ERROR_SUCCESS) {
    result = run_child(sid, executable, family, gateway, hostile, &observed, network);
    printf("socket-inbound-egress: family=%d code=%lu observations=%lu expected-tcp-mask=1\n",
           family, result, observed);
    if (result == ERROR_SUCCESS &&
        (observed > 7 || (observed & 3) != 1 || udp_received(udp) != 0 ||
         tcp_accepted(gateway_listener) != 2)) result = ERROR_INVALID_DATA;
  }
  if (result == ERROR_SUCCESS) result = gateway_inbound_block(sid, (UINT16)control_family, &deny);
  if (result == ERROR_SUCCESS &&
      control_route_probe(sid, executable, control_family, "independent-deny", network, sid) != ERROR_CONNECTION_REFUSED)
    result = ERROR_INVALID_DATA;
  if (deny != NULL) {
    closed = FwpmEngineClose0(deny);
    if (closed != ERROR_SUCCESS) result = closed;
  }
  if (result == ERROR_SUCCESS)
    result = control_route_probe(sid, executable, control_family, "deny-removed", network, sid);
  closed = gateway_inbound_stop(owner);
  if (closed != ERROR_SUCCESS) result = closed;
  if (result == ERROR_SUCCESS &&
      control_route_probe(sid, executable, control_family, "inbound-owner-reaped", network, sid) != ERROR_CONNECTION_REFUSED)
    result = ERROR_INVALID_DATA;
  /* A separate peer baseline does not qualify concurrent owner lifetimes. Preserve that failure,
   * but collect independent deny, egress and owner-reaping evidence before reporting it. */
  if (result == ERROR_SUCCESS) result = concurrent_result;
  if (diagnostics != NULL) {
    closed = gateway_diagnostics_read(diagnostics, sid);
    if (closed != ERROR_SUCCESS) result = closed;
    closed = gateway_diagnostics_stop(diagnostics);
    if (closed != ERROR_SUCCESS) result = closed;
  }
  printf("socket-inbound-experiment: family=%d code=%lu\n", family, result);
  return result;
}

int gateway_socket_child(int family, UINT16 gateway, UINT16 hostile) {
  STARTUPINFOW startup = {0};
  PROCESS_INFORMATION process = {0};
  wchar_t *executable = calloc(32768, sizeof(wchar_t));
  wchar_t *command = calloc(32768, sizeof(wchar_t));
  DWORD descendant = 99;
  int result = gateway_socket_leaf(family, gateway, hostile);
  if (executable == NULL || command == NULL) { result = 83; goto done; }
  if (GetModuleFileNameW(NULL, executable, 32768) == 0 ||
      _snwprintf_s(command, 32768, _TRUNCATE, L"\"%ls\" --socket-leaf %d %u %u",
          executable, family, (unsigned)gateway, (unsigned)hostile) < 0) { result = 84; goto done; }
  startup.cb = sizeof(startup);
  /* No explicit security attributes: verify a normal descendant inherits the same restriction. */
  if (!CreateProcessW(executable, command, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                      NULL, NULL, &startup, &process)) { result = 85; goto done; }
  if (WaitForSingleObject(process.hProcess, 10000) != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(process.hProcess, &descendant)) {
    (void)TerminateProcess(process.hProcess, 86);
    (void)WaitForSingleObject(process.hProcess, INFINITE);
    result = 86;
  } else if (descendant != (DWORD)result) result = 87;
done:
  if (process.hThread != NULL) CloseHandle(process.hThread);
  if (process.hProcess != NULL) CloseHandle(process.hProcess);
  free(executable); free(command);
  return result;
}

static int udp_received(SOCKET listener) {
  fd_set read_set;
  struct timeval timeout = {0, 200000};
  char bytes[8];
  int count;
  FD_ZERO(&read_set); FD_SET(listener, &read_set);
  count = select(0, &read_set, NULL, NULL, &timeout);
  if (count < 0) return -1;
  if (count == 0) return 0;
  return recv(listener, bytes, sizeof(bytes), 0) == 1 && bytes[0] == 'K' ? 1 : -1;
}

static DWORD run_child(PSID sid, const wchar_t *executable, int family,
                       UINT16 gateway, UINT16 hostile, DWORD *observed, PSID_AND_ATTRIBUTES network) {
  STARTUPINFOEXW startup = {0};
  PROCESS_INFORMATION process = {0};
  SECURITY_CAPABILITIES capabilities = {0};
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  SIZE_T bytes = 0;
  HANDLE job = NULL;
  wchar_t *command = calloc(32768, sizeof(wchar_t));
  DWORD result = ERROR_SUCCESS;
  int attributes_ready = 0;
  if (command == NULL) return ERROR_OUTOFMEMORY;
  if (_snwprintf_s(command, 32768, _TRUNCATE, L"\"%ls\" --socket-child %d %u %u",
      executable, family, (unsigned)gateway, (unsigned)hostile) < 0) {
    result = ERROR_BUFFER_OVERFLOW; goto done;
  }
  capabilities.AppContainerSid = sid;
  capabilities.Capabilities = network;
  capabilities.CapabilityCount = network == NULL ? 0 : 1;
  startup.StartupInfo.cb = sizeof(startup);
  (void)InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  startup.lpAttributeList = HeapAlloc(GetProcessHeap(), 0, bytes);
  if (startup.lpAttributeList == NULL) { result = ERROR_OUTOFMEMORY; goto done; }
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) {
    result = GetLastError(); goto done;
  }
  attributes_ready = 1;
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0,
      PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities), NULL, NULL)) {
    result = GetLastError(); goto done;
  }
  job = CreateJobObjectW(NULL, NULL);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job == NULL || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    result = GetLastError(); goto done;
  }
  if (!CreateProcessW(executable, command, NULL, NULL, FALSE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL,
      &startup.StartupInfo, &process)) { result = GetLastError(); goto done; }
  if (!AssignProcessToJobObject(job, process.hProcess) || ResumeThread(process.hThread) == (DWORD)-1) {
    result = GetLastError(); goto done;
  }
  if (WaitForSingleObject(process.hProcess, 15000) != WAIT_OBJECT_0) {
    result = ERROR_TIMEOUT; goto done;
  }
  if (!GetExitCodeProcess(process.hProcess, observed)) result = GetLastError();
done:
  /* Reap even the suspended/unassigned failure path before the caller removes filters. */
  if (process.hProcess != NULL) {
    if (WaitForSingleObject(process.hProcess, 0) != WAIT_OBJECT_0) {
      (void)TerminateProcess(process.hProcess, 90);
      (void)WaitForSingleObject(process.hProcess, INFINITE);
    }
    CloseHandle(process.hProcess);
  }
  if (process.hThread != NULL) CloseHandle(process.hThread);
  if (job != NULL) CloseHandle(job);
  if (attributes_ready) DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (startup.lpAttributeList != NULL) HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
  free(command);
  return result;
}

DWORD gateway_test_grant_execute(wchar_t *path, PSID sid, PSECURITY_DESCRIPTOR *original) {
  PACL before = NULL, after = NULL;
  EXPLICIT_ACCESSW entry = {0};
  DWORD result = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                       NULL, NULL, &before, NULL, original);
  if (result != ERROR_SUCCESS) return result;
  entry.grfAccessPermissions = GENERIC_READ | GENERIC_EXECUTE;
  entry.grfAccessMode = GRANT_ACCESS;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.ptstrName = sid;
  result = SetEntriesInAclW(1, &entry, before, &after);
  if (result == ERROR_SUCCESS) result = SetNamedSecurityInfoW(path, SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION, NULL, NULL, after, NULL);
  if (after != NULL) LocalFree(after);
  return result;
}

struct concurrent_probe {
  PSID sid;
  const wchar_t *executable;
  int family;
  UINT16 gateway, hostile;
  DWORD result, observed;
  PSID_AND_ATTRIBUTES network;
};

static DWORD WINAPI concurrent_child(void *context) {
  struct concurrent_probe *probe = context;
  probe->result = run_child(probe->sid, probe->executable, probe->family,
                            probe->gateway, probe->hostile, &probe->observed, probe->network);
  return 0;
}

static DWORD restore_access(wchar_t *path, PSECURITY_DESCRIPTOR original) {
  PACL acl = NULL;
  BOOL present = FALSE, defaulted = FALSE;
  if (original == NULL) return ERROR_SUCCESS;
  if (!GetSecurityDescriptorDacl(original, &present, &acl, &defaulted)) return GetLastError();
  return SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, acl, NULL);
}

int gateway_socket_proof(int ipv4_control) {
  HMODULE firewall = NULL;
  union { FARPROC address; get_config_fn call; } get_config = {0};
  union { FARPROC address; set_config_fn call; } set_config = {0};
  WSADATA data;
  UUID uuid;
  RPC_WSTR uuid_text = NULL;
  wchar_t profile[80] = {0}, peer_profile[88] = {0};
  wchar_t *executable = calloc(32768, sizeof(wchar_t));
  PSID sid = NULL, peer_sid = NULL;
  PSID_AND_ATTRIBUTES previous = NULL, configured = NULL;
  PSECURITY_DESCRIPTOR original = NULL, intermediate = NULL;
  DWORD count = 0, result = ERROR_SUCCESS, control_result = ERROR_SUCCESS, index;
  union { SID alignment; BYTE bytes[SECURITY_MAX_SID_SIZE]; } network_sid;
  DWORD network_size = sizeof(network_sid);
  SID_AND_ATTRIBUTES network = {0};
  PSID_AND_ATTRIBUTES network_pointer = NULL;
  int exemption_changed = 0, profile_created = 0, peer_created = 0, sockets_started = 0, family;
  if (executable == NULL) return 1;
  /* Both disposable proofs require an actual inbound route. Keep the same capability-bearing
   * token for every baseline, confined outbound probe and descendant control. */
  {
    if (!CreateWellKnownSid(WinCapabilityPrivateNetworkClientServerSid, NULL,
                            network_sid.bytes, &network_size)) { result = GetLastError(); goto done; }
    network.Sid = network_sid.bytes;
    network.Attributes = SE_GROUP_ENABLED;
    network_pointer = &network;
  }
  firewall = LoadLibraryExW(L"FirewallAPI.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (firewall == NULL) { result = GetLastError(); goto done; }
  get_config.address = GetProcAddress(firewall, "NetworkIsolationGetAppContainerConfig");
  set_config.address = GetProcAddress(firewall, "NetworkIsolationSetAppContainerConfig");
  if (get_config.address == NULL || set_config.address == NULL) { result = ERROR_PROC_NOT_FOUND; goto done; }
  if (GetModuleFileNameW(NULL, executable, 32768) == 0) { result = GetLastError(); goto done; }
  result = UuidCreate(&uuid);
  if (result != RPC_S_OK && result != RPC_S_UUID_LOCAL_ONLY) goto done;
  result = UuidToStringW(&uuid, &uuid_text);
  if (result != RPC_S_OK) goto done;
  if (_snwprintf_s(profile, 80, _TRUNCATE, L"Keiko.SocketProof.%ls", uuid_text) < 0) {
    result = ERROR_BUFFER_OVERFLOW; goto done;
  }
  result = (DWORD)CreateAppContainerProfile(profile, profile, L"Disposable Keiko socket test",
                                            network_pointer, network_pointer == NULL ? 0 : 1, &sid);
  if (FAILED((HRESULT)result)) goto done;
  profile_created = 1;
  if (_snwprintf_s(peer_profile, 88, _TRUNCATE, L"%ls.Peer", profile) < 0) {
    result = ERROR_BUFFER_OVERFLOW; goto done;
  }
  result = (DWORD)CreateAppContainerProfile(peer_profile, peer_profile, L"Disposable peer test",
                                            network_pointer, network_pointer == NULL ? 0 : 1, &peer_sid);
  if (FAILED((HRESULT)result)) goto done;
  peer_created = 1;
  result = gateway_test_grant_execute(executable, sid, &original);
  if (result != ERROR_SUCCESS) goto done;
  result = gateway_test_grant_execute(executable, peer_sid, &intermediate);
  if (result != ERROR_SUCCESS) goto done;
  /* Test-only scoped loopback exemption. Preserve and restore the existing configuration.
   * This debug API plus dynamic WFP is NOT a crash-safe production service design. */
  result = get_config.call(&count, &previous);
  if (result != ERROR_SUCCESS) goto done;
  configured = calloc((size_t)count + 2, sizeof(*configured));
  if (configured == NULL) { result = ERROR_OUTOFMEMORY; goto done; }
  for (index = 0; index < count; index++) configured[index] = previous[index];
  configured[count].Sid = sid;
  configured[count + 1].Sid = peer_sid;
  result = set_config.call(count + 2, configured);
  if (result != ERROR_SUCCESS) goto done;
  exemption_changed = 1;
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) { result = ERROR_NOT_READY; goto done; }
  sockets_started = 1;
  for (family = AF_INET; family <= AF_INET6; family += AF_INET6 - AF_INET) {
    /* The OpenCode composition uses IPv4 control for either gateway family; the original
     * socket proof additionally qualifies same-family IPv6 inbound access. */
    const int control_family = ipv4_control ? AF_INET : family;
    struct socket_target gateway = {0}, hostile = {0};
    struct keiko_gateway_filters filters = {0}, peer_filters = {0};
    SOCKET udp = INVALID_SOCKET, peer_udp = INVALID_SOCKET;
    DWORD observed = 99, closed;
    gateway.listener = INVALID_SOCKET; hostile.listener = INVALID_SOCKET;
    if (!listen_target(family, &gateway) || !listen_target(family, &hostile)) {
      result = ERROR_NOT_READY;
    } else {
      udp = socket(family, SOCK_DGRAM, IPPROTO_UDP);
      peer_udp = socket(family, SOCK_DGRAM, IPPROTO_UDP);
      if (udp == INVALID_SOCKET || peer_udp == INVALID_SOCKET ||
          bind(udp, (SOCKADDR *)&gateway.address, gateway.size) != 0 ||
          bind(peer_udp, (SOCKADDR *)&hostile.address, hostile.size) != 0) {
        result = ERROR_NOT_READY;
      }
      if (result == ERROR_SUCCESS)
      result = run_child(sid, executable, family, gateway.port, hostile.port, &observed, network_pointer);
      printf("socket-baseline: family=%d code=%lu connections=%lu expected=7 descendant=same\n", family, result, observed);
      if (result == ERROR_SUCCESS && (observed != 7 || udp_received(udp) != 1 || udp_received(udp) != 1 ||
          tcp_accepted(gateway.listener) != 2 || tcp_accepted(hostile.listener) != 2))
        result = ERROR_INVALID_DATA;
      if (result == ERROR_SUCCESS) {
        result = run_child(peer_sid, executable, family, hostile.port, gateway.port, &observed, network_pointer);
        printf("socket-peer-baseline: family=%d code=%lu connections=%lu expected=7 descendant=same\n", family, result, observed);
        if (result == ERROR_SUCCESS &&
            (observed != 7 || udp_received(peer_udp) != 1 || udp_received(peer_udp) != 1 ||
             tcp_accepted(gateway.listener) != 2 || tcp_accepted(hostile.listener) != 2))
          result = ERROR_INVALID_DATA;
      }
      if (result == ERROR_SUCCESS) {
        DWORD route = control_route_probe(sid, executable, control_family, "unfiltered", network_pointer, NULL);
        DWORD expected = ERROR_CONNECTION_REFUSED;
        if (route != expected) control_result = ERROR_INVALID_DATA;
        {
          route = unfiltered_inbound_probe(sid, executable, control_family, network_pointer);
          if (route != ERROR_SUCCESS) control_result = route;
        }
      }
      if (result == ERROR_SUCCESS)
        result = keiko_gateway_filters_open(sid, (UINT16)family, gateway.port, &filters);
      if (result == ERROR_SUCCESS)
        result = keiko_gateway_filters_open(peer_sid, (UINT16)family, hostile.port, &peer_filters);
      if (result == ERROR_SUCCESS) {
        struct concurrent_probe probes[2] = {
          {sid, executable, family, gateway.port, hostile.port, ERROR_NOT_READY, 99, network_pointer},
          {peer_sid, executable, family, hostile.port, gateway.port, ERROR_NOT_READY, 99, network_pointer}
        };
        HANDLE threads[2] = {NULL, NULL};
        size_t probe_index;
        for (probe_index = 0; probe_index < 2; probe_index++) {
          threads[probe_index] = CreateThread(NULL, 0, concurrent_child, &probes[probe_index], 0, NULL);
          if (threads[probe_index] == NULL) result = GetLastError();
        }
        for (probe_index = 0; probe_index < 2; probe_index++) {
          if (threads[probe_index] != NULL) {
            (void)WaitForSingleObject(threads[probe_index], INFINITE);
            CloseHandle(threads[probe_index]);
          }
          printf("socket-filtered: family=%d tree=%zu code=%lu observations=%lu expected-tcp-mask=1 descendant=same\n",
                  family, probe_index, probes[probe_index].result, probes[probe_index].observed);
          /* UDP send completion only means locally accepted; reception is the enforcement oracle. */
          if (probes[probe_index].result != ERROR_SUCCESS || probes[probe_index].observed > 7 ||
              (probes[probe_index].observed & 3) != 1)
            result = ERROR_INVALID_DATA;
        }
        {
          int received = udp_received(udp), peer_received = udp_received(peer_udp);
          int accepted = tcp_accepted(gateway.listener), peer_accepted = tcp_accepted(hostile.listener);
          printf("socket-udp-reception: family=%d first=%d peer=%d expected=0\n", family, received, peer_received);
          printf("socket-tcp-acceptance: family=%d first=%d peer=%d expected=2\n", family, accepted, peer_accepted);
          if (received != 0 || peer_received != 0 || accepted != 2 || peer_accepted != 2) result = ERROR_INVALID_DATA;
        }
        if (result == ERROR_SUCCESS) {
          DWORD route = control_route_probe(sid, executable, control_family, "filtered", network_pointer, NULL);
          DWORD expected = ERROR_CONNECTION_REFUSED;
          if (route != expected) control_result = ERROR_INVALID_DATA;
          {
            route = scoped_inbound_probe(sid, peer_sid, executable, family, control_family, gateway.port, hostile.port,
                                          udp, gateway.listener, network_pointer);
            if (route != ERROR_SUCCESS) control_result = route;
          }
        }
      }
    }
    closed = keiko_gateway_filters_close(&filters);
    if (closed != ERROR_SUCCESS) result = closed;
    closed = keiko_gateway_filters_close(&peer_filters);
    if (closed != ERROR_SUCCESS) result = closed;
    if (gateway.listener != INVALID_SOCKET) closesocket(gateway.listener);
    if (hostile.listener != INVALID_SOCKET) closesocket(hostile.listener);
    if (udp != INVALID_SOCKET) closesocket(udp);
    if (peer_udp != INVALID_SOCKET) closesocket(peer_udp);
    if (result != ERROR_SUCCESS) break;
  }
  /* Collect both families' evidence, but never convert an unavailable control route to success. */
  if (result == ERROR_SUCCESS) result = control_result;
done:
  if (exemption_changed) {
    DWORD restored = set_config.call(count, previous);
    if (restored != ERROR_SUCCESS) result = restored;
  }
  {
    DWORD restored = restore_access(executable, original);
    if (restored != ERROR_SUCCESS) result = restored;
  }
  if (profile_created) {
    HRESULT deleted = DeleteAppContainerProfile(profile);
    if (FAILED(deleted)) result = (DWORD)deleted;
  }
  if (peer_created) {
    HRESULT deleted = DeleteAppContainerProfile(peer_profile);
    if (FAILED(deleted)) result = (DWORD)deleted;
  }
  if (original != NULL) LocalFree(original);
  if (intermediate != NULL) LocalFree(intermediate);
  if (sid != NULL) FreeSid(sid);
  if (peer_sid != NULL) FreeSid(peer_sid);
  for (index = 0; index < count; index++) HeapFree(GetProcessHeap(), 0, previous[index].Sid);
  if (previous != NULL) HeapFree(GetProcessHeap(), 0, previous);
  free(configured); free(executable);
  if (uuid_text != NULL) RpcStringFreeW(&uuid_text);
  if (sockets_started) WSACleanup();
  if (firewall != NULL) FreeLibrary(firewall);
  printf("gateway-socket-proof: %s; code=%lu\n", result == ERROR_SUCCESS ? "passed" : "failed", result);
  return result == ERROR_SUCCESS ? 0 : 1;
}
