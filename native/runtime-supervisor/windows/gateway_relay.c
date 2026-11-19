/* Pipe-relayed confinement without an installed broker (#4068). See gateway_relay.h. */
#include "gateway_relay.h"
#include <ws2tcpip.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define RELAY_BUFFER 65536u
#define RELAY_IDLE_INBOUND 4u
#define RELAY_PIPE_WAIT_MS 10000u
#define RELAY_OPEN_SIGNAL 0x4Fu
/* The runtime's startup line must arrive within this many bytes; after it, output passes raw. */
#define RELAY_SCAN_LIMIT 65536u
/* Overlapped sockets: a bridge receives and sends on one socket from two threads, which a
 * non-overlapped (synchronous) socket would serialize into a deadlock. Accepted sockets inherit. */
#define RELAY_SOCKET_FLAGS (WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT)

/* ------------------------------------------------------------------ plan grammar */

static int parse_port(const wchar_t **cursor, USHORT *port) {
  unsigned long value = 0;
  int digits = 0;
  while (**cursor >= L'0' && **cursor <= L'9') {
    if (++digits > 5) return 0;
    value = value * 10 + (unsigned long)(**cursor - L'0');
    ++*cursor;
  }
  if (digits == 0 || value == 0 || value > 65535) return 0;
  *port = (USHORT)value;
  return 1;
}

int keiko_relay_plan_parse(const wchar_t *text, struct keiko_relay_plan *plan) {
  const wchar_t *cursor = text;
  DWORD inbound = 0, index;
  memset(plan, 0, sizeof(*plan));
  for (index = 0; index < KEIKO_RELAY_PREFIX_CHARS; ++index) {
    wchar_t c = cursor[index];
    if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return 0;
    plan->prefix[index] = (char)c;
  }
  cursor += KEIKO_RELAY_PREFIX_CHARS;
  if (*cursor++ != L'/') return 0;
  for (;;) {
    struct keiko_relay_route *route;
    if (plan->route_count >= KEIKO_RELAY_MAX_ROUTES) return 0;
    route = &plan->routes[plan->route_count];
    if (*cursor == L'o') route->direction = KEIKO_RELAY_OUTBOUND;
    else if (*cursor == L'i') route->direction = KEIKO_RELAY_INBOUND;
    else return 0;
    ++cursor;
    if (!parse_port(&cursor, &route->host_port)) return 0;
    if (route->direction == KEIKO_RELAY_INBOUND && ++inbound > 1) return 0;
    for (index = 0; index < plan->route_count; ++index)
      if (plan->routes[index].host_port == route->host_port) return 0;
    ++plan->route_count;
    if (*cursor == L'\0') return 1;
    if (*cursor++ != L',') return 0;
  }
}

int keiko_relay_plan_format(const struct keiko_relay_plan *plan, wchar_t *output, size_t capacity) {
  size_t used;
  DWORD index;
  int written = _snwprintf_s(output, capacity, _TRUNCATE, L"%.32S/", plan->prefix);
  if (written < 0) return 0;
  used = (size_t)written;
  for (index = 0; index < plan->route_count; ++index) {
    const struct keiko_relay_route *route = &plan->routes[index];
    written = _snwprintf_s(output + used, capacity - used, _TRUNCATE, L"%s%c%u",
                           index == 0 ? L"" : L",",
                           route->direction == KEIKO_RELAY_INBOUND ? L'i' : L'o',
                           (unsigned)route->host_port);
    if (written < 0) return 0;
    used += (size_t)written;
  }
  return 1;
}

void keiko_relay_pipe_name(const struct keiko_relay_plan *plan, DWORD index, wchar_t name[96]) {
  (void)_snwprintf_s(name, 96, _TRUNCATE, L"\\\\.\\pipe\\KeikoRelay-%.32S-%lu", plan->prefix,
                     (unsigned long)index);
}

wchar_t *keiko_relay_rewrite_port(const wchar_t *value, USHORT from, USHORT to) {
  wchar_t needle[24], replacement[24];
  size_t needle_length, replacement_length, length = wcslen(value), count = 0;
  const wchar_t *cursor;
  wchar_t *output, *target;
  (void)_snwprintf_s(needle, 24, _TRUNCATE, L"127.0.0.1:%u", (unsigned)from);
  (void)_snwprintf_s(replacement, 24, _TRUNCATE, L"127.0.0.1:%u", (unsigned)to);
  needle_length = wcslen(needle);
  replacement_length = wcslen(replacement);
  for (cursor = wcsstr(value, needle); cursor; cursor = wcsstr(cursor + needle_length, needle))
    ++count;
  output = calloc(length + count * replacement_length + 1, sizeof(wchar_t));
  if (output == NULL) return NULL;
  target = output;
  for (cursor = value; *cursor;) {
    const wchar_t *after = cursor + needle_length;
    if (wcsncmp(cursor, needle, needle_length) == 0 && !(*after >= L'0' && *after <= L'9')) {
      memcpy(target, replacement, replacement_length * sizeof(wchar_t));
      target += replacement_length;
      cursor = after;
    } else {
      *target++ = *cursor++;
    }
  }
  *target = L'\0';
  return output;
}

/* ------------------------------------------------------------------ sockets */

static int winsock_ready(void) {
  static LONG started = 0;
  WSADATA data;
  if (InterlockedCompareExchange(&started, 1, 0) != 0) return 1;
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
    InterlockedExchange(&started, 0);
    return 0;
  }
  return 1;
}

static SOCKET loopback_listener(USHORT port, USHORT *bound) {
  struct sockaddr_in address;
  int length = sizeof(address);
  BOOL exclusive = TRUE;
  SOCKET listener =
      WSASocketW(AF_INET, SOCK_STREAM, IPPROTO_TCP, NULL, 0, RELAY_SOCKET_FLAGS);
  if (listener == INVALID_SOCKET) return INVALID_SOCKET;
  /* Nobody else may bind the same port beside the relay. */
  (void)setsockopt(listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&exclusive,
                   sizeof(exclusive));
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      listen(listener, SOMAXCONN) != 0 ||
      getsockname(listener, (struct sockaddr *)&address, &length) != 0) {
    closesocket(listener);
    return INVALID_SOCKET;
  }
  if (bound) *bound = ntohs(address.sin_port);
  return listener;
}

static SOCKET loopback_connect(USHORT port) {
  struct sockaddr_in address;
  BOOL nodelay = TRUE;
  SOCKET connection =
      WSASocketW(AF_INET, SOCK_STREAM, IPPROTO_TCP, NULL, 0, RELAY_SOCKET_FLAGS);
  if (connection == INVALID_SOCKET) return INVALID_SOCKET;
  (void)setsockopt(connection, IPPROTO_TCP, TCP_NODELAY, (const char *)&nodelay, sizeof(nodelay));
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(connection, (struct sockaddr *)&address, sizeof(address)) != 0) {
    closesocket(connection);
    return INVALID_SOCKET;
  }
  return connection;
}

static int start_thread(LPTHREAD_START_ROUTINE routine, void *parameter) {
  HANDLE thread = CreateThread(NULL, 0, routine, parameter, 0, NULL);
  if (thread == NULL) return 0;
  CloseHandle(thread);
  return 1;
}

/* ------------------------------------------------------------------ overlapped pipe I/O */

/* Reads and writes on one pipe run in two threads, so the pipe is overlapped: a synchronous handle
 * would serialize them and deadlock the bridge. */
static BOOL pipe_io(HANDLE pipe, void *data, DWORD size, BOOL write, DWORD *count) {
  OVERLAPPED o;
  BOOL ok;
  *count = 0;
  memset(&o, 0, sizeof(o));
  o.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (o.hEvent == NULL) return FALSE;
  ok = write ? WriteFile(pipe, data, size, NULL, &o) : ReadFile(pipe, data, size, NULL, &o);
  if (ok || GetLastError() == ERROR_IO_PENDING || GetLastError() == ERROR_MORE_DATA) {
    ok = GetOverlappedResult(pipe, &o, count, TRUE);
    /* A message longer than the buffer arrives in parts; each part is still data. */
    if (!ok && !write && GetLastError() == ERROR_MORE_DATA) ok = TRUE;
  }
  CloseHandle(o.hEvent);
  return ok;
}

static HANDLE open_route_pipe(const wchar_t *name) {
  ULONGLONG deadline = GetTickCount64() + RELAY_PIPE_WAIT_MS;
  for (;;) {
    DWORD mode = PIPE_READMODE_MESSAGE;
    HANDLE pipe = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                              FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT |
                                  SECURITY_IDENTIFICATION,
                              NULL);
    if (pipe != INVALID_HANDLE_VALUE) {
      if (SetNamedPipeHandleState(pipe, &mode, NULL, NULL)) return pipe;
      CloseHandle(pipe);
      return INVALID_HANDLE_VALUE;
    }
    if (GetLastError() != ERROR_PIPE_BUSY || GetTickCount64() >= deadline)
      return INVALID_HANDLE_VALUE;
    (void)WaitNamedPipeW(name, 200);
  }
}

/* ------------------------------------------------------------------ bridge */

struct bridge {
  SOCKET socket;
  HANDLE pipe;
  LONG references;
};

static void bridge_release(struct bridge *b) {
  if (InterlockedDecrement(&b->references) != 0) return;
  closesocket(b->socket);
  CloseHandle(b->pipe);
  free(b);
}

/* A failed side ends both: the peer sees a reset rather than a hang. */
static void bridge_abort(struct bridge *b) {
  (void)shutdown(b->socket, SD_BOTH);
  (void)CancelIoEx(b->pipe, NULL);
  (void)DisconnectNamedPipe(b->pipe);
}

/* Socket to pipe. Socket end of stream becomes a zero-length message. */
static DWORD WINAPI socket_to_pipe(LPVOID parameter) {
  struct bridge *b = parameter;
  char *buffer = malloc(RELAY_BUFFER);
  DWORD written;
  int clean = 0;
  if (buffer != NULL) {
    for (;;) {
      int received = recv(b->socket, buffer, (int)RELAY_BUFFER, 0);
      if (received < 0 || !pipe_io(b->pipe, buffer, (DWORD)received, TRUE, &written) ||
          written != (DWORD)received) break;
      if (received == 0) {
        clean = 1;
        break;
      }
    }
    free(buffer);
  }
  if (!clean) bridge_abort(b);
  bridge_release(b);
  return 0;
}

/* Pipe to socket. A zero-length message half-closes the socket. */
static DWORD WINAPI pipe_to_socket(LPVOID parameter) {
  struct bridge *b = parameter;
  char *buffer = malloc(RELAY_BUFFER);
  DWORD count = 0;
  int clean = 0;
  if (buffer != NULL) {
    while (pipe_io(b->pipe, buffer, RELAY_BUFFER, FALSE, &count)) {
      DWORD sent = 0;
      if (count == 0) {
        (void)shutdown(b->socket, SD_SEND);
        clean = 1;
        break;
      }
      while (sent < count) {
        int part = send(b->socket, buffer + sent, (int)(count - sent), 0);
        if (part <= 0) break;
        sent += (DWORD)part;
      }
      if (sent < count) break;
    }
    free(buffer);
  }
  if (!clean) bridge_abort(b);
  bridge_release(b);
  return 0;
}

static void bridge_start(SOCKET socket, HANDLE pipe) {
  struct bridge *b = calloc(1, sizeof(*b));
  if (b == NULL) {
    closesocket(socket);
    CloseHandle(pipe);
    return;
  }
  b->socket = socket;
  b->pipe = pipe;
  b->references = 2;
  if (!start_thread(socket_to_pipe, b)) {
    b->references = 1;
    bridge_release(b);
    return;
  }
  if (!start_thread(pipe_to_socket, b)) {
    bridge_abort(b);
    bridge_release(b);
  }
}

/* ------------------------------------------------------------------ host side */

struct host_route {
  wchar_t name[96];
  USHORT host_port;
  enum keiko_relay_direction direction;
  SECURITY_ATTRIBUTES attributes;
  PSECURITY_DESCRIPTOR descriptor;
  SOCKET listener;
  BOOL first_created;
  /* Inbound only: connected pipe instances waiting for a host connection. */
  CRITICAL_SECTION lock;
  CONDITION_VARIABLE available;
  HANDLE idle[RELAY_IDLE_INBOUND * 2];
  DWORD idle_count;
};

static struct host_route host_routes[KEIKO_RELAY_MAX_ROUTES];
static DWORD host_route_count;
static volatile LONG host_stopping;
static PSID host_container;

/* Owner and SYSTEM full control, the container read/write, nobody else; low mandatory label so the
 * container's low-integrity token may write to the pipe. */
static int route_descriptor(struct host_route *route, PSID container) {
  wchar_t *sid = NULL;
  wchar_t sddl[256];
  if (!ConvertSidToStringSidW(container, &sid)) return 0;
  (void)_snwprintf_s(sddl, 256, _TRUNCATE,
                     L"D:P(A;;GA;;;OW)(A;;GA;;;SY)(A;;GRGW;;;%s)S:(ML;;NW;;;LW)", sid);
  LocalFree(sid);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1,
                                                            &route->descriptor, NULL))
    return 0;
  route->attributes.nLength = sizeof(route->attributes);
  route->attributes.lpSecurityDescriptor = route->descriptor;
  route->attributes.bInheritHandle = FALSE;
  return 1;
}

/* The first instance claims the name: a squatter that created it first refuses the run. */
static HANDLE route_instance(struct host_route *route) {
  HANDLE pipe = CreateNamedPipeW(
      route->name,
      PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED |
          (route->first_created ? 0 : FILE_FLAG_FIRST_PIPE_INSTANCE),
      PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      PIPE_UNLIMITED_INSTANCES, RELAY_BUFFER, RELAY_BUFFER, 0, &route->attributes);
  if (pipe != INVALID_HANDLE_VALUE) route->first_created = TRUE;
  return pipe;
}

static BOOL await_client(HANDLE pipe) {
  OVERLAPPED o;
  DWORD ignored;
  BOOL ok;
  memset(&o, 0, sizeof(o));
  o.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (o.hEvent == NULL) return FALSE;
  ok = ConnectNamedPipe(pipe, &o);
  if (!ok && GetLastError() == ERROR_PIPE_CONNECTED) ok = TRUE;
  else if (!ok && GetLastError() == ERROR_IO_PENDING)
    ok = GetOverlappedResult(pipe, &o, &ignored, TRUE);
  CloseHandle(o.hEvent);
  return ok;
}

/* Only a process of this run's container may use a route. */
static int client_is_container(HANDLE pipe) {
  ULONG pid = 0;
  HANDLE process, token = NULL;
  BYTE buffer[sizeof(TOKEN_APPCONTAINER_INFORMATION) + SECURITY_MAX_SID_SIZE];
  DWORD size = 0;
  int result = 0;
  if (!GetNamedPipeClientProcessId(pipe, &pid)) return 0;
  process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == NULL) return 0;
  if (OpenProcessToken(process, TOKEN_QUERY, &token) &&
      GetTokenInformation(token, TokenAppContainerSid, buffer, sizeof(buffer), &size)) {
    const TOKEN_APPCONTAINER_INFORMATION *info = (const TOKEN_APPCONTAINER_INFORMATION *)buffer;
    result = info->TokenAppContainer != NULL && EqualSid(info->TokenAppContainer, host_container);
  }
  if (token != NULL) CloseHandle(token);
  CloseHandle(process);
  return result;
}

static HANDLE accept_container_instance(struct host_route *route) {
  while (!host_stopping) {
    HANDLE pipe = route_instance(route);
    if (pipe == INVALID_HANDLE_VALUE) return INVALID_HANDLE_VALUE;
    if (await_client(pipe) && !host_stopping) {
      if (client_is_container(pipe)) return pipe;
    }
    (void)DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
  }
  return INVALID_HANDLE_VALUE;
}

static DWORD WINAPI host_outbound_serve(LPVOID parameter) {
  struct host_route *route = parameter;
  for (;;) {
    HANDLE pipe = accept_container_instance(route);
    SOCKET upstream;
    if (pipe == INVALID_HANDLE_VALUE) return 1;
    upstream = loopback_connect(route->host_port);
    if (upstream == INVALID_SOCKET) {
      (void)DisconnectNamedPipe(pipe);
      CloseHandle(pipe);
      continue;
    }
    bridge_start(upstream, pipe);
  }
}

/* Keeps connected inbound instances ready for host connections. */
static DWORD WINAPI host_inbound_pool(LPVOID parameter) {
  struct host_route *route = parameter;
  for (;;) {
    HANDLE pipe = accept_container_instance(route);
    if (pipe == INVALID_HANDLE_VALUE) return 1;
    EnterCriticalSection(&route->lock);
    while (route->idle_count >= RELAY_IDLE_INBOUND * 2 && !host_stopping)
      (void)SleepConditionVariableCS(&route->available, &route->lock, 200);
    if (route->idle_count < RELAY_IDLE_INBOUND * 2) {
      route->idle[route->idle_count++] = pipe;
      pipe = INVALID_HANDLE_VALUE;
    }
    WakeAllConditionVariable(&route->available);
    LeaveCriticalSection(&route->lock);
    if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
  }
}

static HANDLE take_idle(struct host_route *route) {
  HANDLE pipe = INVALID_HANDLE_VALUE;
  ULONGLONG deadline = GetTickCount64() + RELAY_PIPE_WAIT_MS;
  EnterCriticalSection(&route->lock);
  while (route->idle_count == 0 && !host_stopping && GetTickCount64() < deadline)
    (void)SleepConditionVariableCS(&route->available, &route->lock, 200);
  if (route->idle_count > 0) {
    pipe = route->idle[0];
    memmove(route->idle, route->idle + 1, (route->idle_count - 1) * sizeof(HANDLE));
    --route->idle_count;
    WakeAllConditionVariable(&route->available);
  }
  LeaveCriticalSection(&route->lock);
  return pipe;
}

static DWORD WINAPI host_inbound_accept(LPVOID parameter) {
  struct host_route *route = parameter;
  while (!host_stopping) {
    SOCKET client = accept(route->listener, NULL, NULL);
    BYTE open = RELAY_OPEN_SIGNAL;
    DWORD written = 0;
    HANDLE pipe;
    if (client == INVALID_SOCKET) continue;
    pipe = take_idle(route);
    if (pipe == INVALID_HANDLE_VALUE || !pipe_io(pipe, &open, 1, TRUE, &written) ||
        written != 1) {
      if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
      closesocket(client);
      continue;
    }
    bridge_start(client, pipe);
  }
  return 0;
}

int keiko_relay_host_start(struct keiko_relay_plan *plan, PSID container) {
  DWORD index;
  if (!winsock_ready() || plan->route_count == 0 || plan->route_count > KEIKO_RELAY_MAX_ROUTES)
    return 0;
  host_stopping = 0;
  host_container = container;
  for (index = 0; index < plan->route_count; ++index) {
    struct host_route *route = &host_routes[index];
    HANDLE claim;
    memset(route, 0, sizeof(*route));
    route->listener = INVALID_SOCKET;
    route->direction = plan->routes[index].direction;
    keiko_relay_pipe_name(plan, index, route->name);
    InitializeCriticalSection(&route->lock);
    InitializeConditionVariable(&route->available);
    host_route_count = index + 1;
    if (!route_descriptor(route, container)) goto refused;
    if (route->direction == KEIKO_RELAY_INBOUND) {
      route->listener = loopback_listener(0, &plan->routes[index].host_port);
      if (route->listener == INVALID_SOCKET) goto refused;
    }
    route->host_port = plan->routes[index].host_port;
    /* Claim the name now, so a squatter refuses the run before the tree exists. */
    claim = route_instance(route);
    if (claim == INVALID_HANDLE_VALUE) goto refused;
    CloseHandle(claim);
  }
  for (index = 0; index < plan->route_count; ++index) {
    struct host_route *route = &host_routes[index];
    if (route->direction == KEIKO_RELAY_OUTBOUND) {
      if (!start_thread(host_outbound_serve, route)) goto refused;
    } else if (!start_thread(host_inbound_pool, route) ||
               !start_thread(host_inbound_accept, route)) {
      goto refused;
    }
  }
  return 1;
refused:
  keiko_relay_host_stop();
  return 0;
}

void keiko_relay_host_stop(void) {
  DWORD index;
  host_stopping = 1;
  for (index = 0; index < host_route_count; ++index) {
    struct host_route *route = &host_routes[index];
    if (route->listener != INVALID_SOCKET) {
      closesocket(route->listener);
      route->listener = INVALID_SOCKET;
    }
  }
  /* The supervisor exits right after; pipe instances and descriptors go with it. */
}

/* ------------------------------------------------------------------ container side */

struct container_route {
  wchar_t name[96];
  USHORT host_port;
  USHORT inner_port;
  SOCKET listener;
};

static struct container_route container_routes[KEIKO_RELAY_MAX_ROUTES];
/* The runtime's own server port inside the container, learned from its startup line. */
static volatile LONG runtime_port;

static DWORD WINAPI container_outbound(LPVOID parameter) {
  struct container_route *route = parameter;
  for (;;) {
    SOCKET client = accept(route->listener, NULL, NULL);
    HANDLE pipe;
    if (client == INVALID_SOCKET) continue;
    pipe = open_route_pipe(route->name);
    if (pipe == INVALID_HANDLE_VALUE) {
      closesocket(client);
      continue;
    }
    bridge_start(client, pipe);
  }
}

/* One idle instance: waits for the host's open signal, then connects to the runtime's server. */
static DWORD WINAPI container_inbound_one(LPVOID parameter) {
  struct container_route *route = parameter;
  for (;;) {
    HANDLE pipe = open_route_pipe(route->name);
    BYTE signal = 0;
    DWORD count = 0;
    SOCKET runtime;
    if (pipe == INVALID_HANDLE_VALUE) {
      Sleep(200);
      continue;
    }
    if (!pipe_io(pipe, &signal, 1, FALSE, &count) || count != 1 || signal != RELAY_OPEN_SIGNAL ||
        runtime_port == 0) {
      CloseHandle(pipe);
      continue;
    }
    runtime = loopback_connect((USHORT)runtime_port);
    if (runtime == INVALID_SOCKET) {
      CloseHandle(pipe);
      continue;
    }
    bridge_start(runtime, pipe);
  }
}

struct output_scan {
  HANDLE source;
  HANDLE target;
  USHORT host_port;
};

static int write_all(HANDLE target, const char *data, DWORD length) {
  while (length > 0) {
    DWORD written = 0;
    if (!WriteFile(target, data, length, &written, NULL) || written == 0) return 0;
    data += written;
    length -= written;
  }
  return 1;
}

/* Finds "http://127.0.0.1:<port>" in a line; returns the port and where its digits lie. */
static USHORT listening_port(const char *line, size_t length, size_t *start, size_t *end) {
  static const char marker[] = "http://127.0.0.1:";
  size_t marker_length = sizeof(marker) - 1, index;
  for (index = 0; index + marker_length < length; ++index) {
    size_t cursor = index + marker_length;
    unsigned long value = 0;
    if (memcmp(line + index, marker, marker_length) != 0) continue;
    while (cursor < length && line[cursor] >= '0' && line[cursor] <= '9' && cursor - index < 30) {
      value = value * 10 + (unsigned long)(line[cursor] - '0');
      ++cursor;
    }
    if (cursor == index + marker_length || value == 0 || value > 65535) continue;
    *start = index + marker_length;
    *end = cursor;
    return (USHORT)value;
  }
  return 0;
}

/* Passes the runtime's standard output through, rewriting the port in its first listening line
 * to the host side's port; after that line everything passes unchanged. */
static DWORD WINAPI output_relay(LPVOID parameter) {
  struct output_scan *scan = parameter;
  char *line = malloc(RELAY_SCAN_LIMIT), buffer[4096];
  size_t used = 0;
  int found = 0;
  DWORD count;
  while (ReadFile(scan->source, buffer, sizeof(buffer), &count, NULL) && count > 0) {
    DWORD index;
    if (found || line == NULL) {
      if (!write_all(scan->target, buffer, count)) break;
      continue;
    }
    for (index = 0; index < count; ++index) {
      line[used++] = buffer[index];
      if (buffer[index] != '\n' && used < RELAY_SCAN_LIMIT) continue;
      if (!found) {
        size_t start = 0, end = 0;
        USHORT port = listening_port(line, used, &start, &end);
        if (port != 0) {
          char digits[8];
          int digit_count = sprintf_s(digits, sizeof(digits), "%u", (unsigned)scan->host_port);
          InterlockedExchange(&runtime_port, (LONG)port);
          found = write_all(scan->target, line, (DWORD)start) &&
                  write_all(scan->target, digits, (DWORD)digit_count) &&
                  write_all(scan->target, line + end, (DWORD)(used - end));
          used = 0;
          if (!found) goto done;
          if (index + 1 < count &&
              !write_all(scan->target, buffer + index + 1, count - index - 1)) goto done;
          break;
        }
      }
      if (!write_all(scan->target, line, (DWORD)used)) goto done;
      used = 0;
    }
  }
  if (used > 0) (void)write_all(scan->target, line, (DWORD)used);
done:
  free(line);
  CloseHandle(scan->source);
  return 0;
}

static wchar_t *child_command_line(int argc, wchar_t **argv) {
  size_t length = 1;
  int index;
  wchar_t *line, *cursor;
  for (index = 3; index < argc; ++index) length += wcslen(argv[index]) * 2 + 3;
  line = calloc(length, sizeof(wchar_t));
  if (line == NULL) return NULL;
  cursor = line;
  for (index = 3; index < argc; ++index) {
    const wchar_t *source = argv[index];
    size_t slashes = 0;
    if (index != 3) *cursor++ = L' ';
    *cursor++ = L'"';
    for (; *source; ++source) {
      if (*source == L'\\') {
        ++slashes;
      } else {
        if (*source == L'"') {
          while (slashes > 0) {
            *cursor++ = L'\\';
            --slashes;
          }
          *cursor++ = L'\\';
        }
        slashes = 0;
      }
      *cursor++ = *source;
    }
    while (slashes > 0) {
      *cursor++ = L'\\';
      --slashes;
    }
    *cursor++ = L'"';
  }
  *cursor = L'\0';
  return line;
}

/* This process's environment with every outbound host port rewritten to its inner port. */
static wchar_t *child_environment(const struct keiko_relay_plan *plan) {
  wchar_t *strings = GetEnvironmentStringsW(), *cursor, *block = NULL, *target;
  size_t capacity = 1, used = 0;
  if (strings == NULL) return NULL;
  for (cursor = strings; *cursor; cursor += wcslen(cursor) + 1) capacity += wcslen(cursor) * 2 + 16;
  block = calloc(capacity, sizeof(wchar_t));
  if (block == NULL) goto done;
  target = block;
  for (cursor = strings; *cursor; cursor += wcslen(cursor) + 1) {
    wchar_t *value = _wcsdup(cursor);
    DWORD index;
    size_t length;
    for (index = 0; value != NULL && index < plan->route_count; ++index) {
      wchar_t *rewritten;
      if (plan->routes[index].direction != KEIKO_RELAY_OUTBOUND) continue;
      rewritten = keiko_relay_rewrite_port(value, container_routes[index].host_port,
                                           container_routes[index].inner_port);
      free(value);
      value = rewritten;
    }
    if (value == NULL || (length = wcslen(value)) + 1 > capacity - used - 1) {
      free(value);
      free(block);
      block = NULL;
      goto done;
    }
    memcpy(target, value, (length + 1) * sizeof(wchar_t));
    target += length + 1;
    used += length + 1;
    free(value);
  }
  *target = L'\0';
done:
  FreeEnvironmentStringsW(strings);
  return block;
}

static int start_routes(const struct keiko_relay_plan *plan, USHORT *inbound_host_port) {
  DWORD index, idle;
  *inbound_host_port = 0;
  for (index = 0; index < plan->route_count; ++index) {
    struct container_route *route = &container_routes[index];
    route->host_port = plan->routes[index].host_port;
    route->listener = INVALID_SOCKET;
    keiko_relay_pipe_name(plan, index, route->name);
    if (plan->routes[index].direction == KEIKO_RELAY_INBOUND) {
      *inbound_host_port = route->host_port;
      for (idle = 0; idle < RELAY_IDLE_INBOUND; ++idle)
        if (!start_thread(container_inbound_one, route)) return 0;
      continue;
    }
    route->listener = loopback_listener(0, &route->inner_port);
    if (route->listener == INVALID_SOCKET) {
      fprintf(stderr, "relay listener unavailable: %d\n", WSAGetLastError());
      return 0;
    }
    if (!start_thread(container_outbound, route)) return 0;
  }
  return 1;
}

int keiko_relay_container_main(int argc, wchar_t **argv) {
  struct keiko_relay_plan plan;
  static struct output_scan scan;
  STARTUPINFOEXW startup;
  PROCESS_INFORMATION child;
  SECURITY_ATTRIBUTES inheritable = {sizeof(inheritable), NULL, TRUE};
  HANDLE output_read = NULL, output_write = NULL, inherited[3];
  SIZE_T attribute_size = 0;
  wchar_t *line = NULL, *environment = NULL;
  USHORT inbound_host_port = 0;
  DWORD exit_code = 126;
  BOOL created = FALSE;
  memset(&startup, 0, sizeof(startup));
  memset(&child, 0, sizeof(child));
  if (argc < 4 || !keiko_relay_plan_parse(argv[2], &plan) || !winsock_ready()) return 126;
  if (!start_routes(&plan, &inbound_host_port)) return 126;
  line = child_command_line(argc, argv);
  environment = child_environment(&plan);
  if (line == NULL || environment == NULL || !CreatePipe(&output_read, &output_write, &inheritable, 0) ||
      !SetHandleInformation(output_read, HANDLE_FLAG_INHERIT, 0)) goto done;
  inherited[0] = GetStdHandle(STD_INPUT_HANDLE);
  inherited[1] = inbound_host_port != 0 ? output_write : GetStdHandle(STD_OUTPUT_HANDLE);
  inherited[2] = GetStdHandle(STD_ERROR_HANDLE);
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = inherited[0];
  startup.StartupInfo.hStdOutput = inherited[1];
  startup.StartupInfo.hStdError = inherited[2];
  InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_size);
  startup.lpAttributeList = calloc(1, attribute_size);
  /* Exactly the three standard handles reach the runtime; listeners and pipes stay here. */
  if (startup.lpAttributeList == NULL ||
      !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attribute_size) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 inherited, sizeof(inherited), NULL, NULL)) goto done;
  /* The runtime inherits this process's container and job. */
  created = CreateProcessW(argv[3], line, NULL, NULL, TRUE,
                           CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, environment,
                           NULL, &startup.StartupInfo, &child);
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (!created) {
    fprintf(stderr, "relay runtime spawn failed: %lu\n", GetLastError());
    goto done;
  }
  CloseHandle(child.hThread);
  CloseHandle(output_write);
  output_write = NULL;
  if (inbound_host_port != 0) {
    scan.source = output_read;
    scan.target = GetStdHandle(STD_OUTPUT_HANDLE);
    scan.host_port = inbound_host_port;
    output_read = NULL;
    if (!start_thread(output_relay, &scan)) {
      TerminateProcess(child.hProcess, 126);
    }
  }
  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(child.hProcess, &exit_code)) exit_code = 126;
  CloseHandle(child.hProcess);
done:
  free(startup.lpAttributeList);
  if (output_read != NULL) CloseHandle(output_read);
  if (output_write != NULL) CloseHandle(output_write);
  free(line);
  if (environment != NULL) {
    /* The block carries the runtime's server password; clear it before release. */
    wchar_t *end = environment;
    while (*end) end += wcslen(end) + 1;
    SecureZeroMemory(environment, (size_t)(end - environment + 1) * sizeof(wchar_t));
    free(environment);
  }
  return (int)exit_code;
}
