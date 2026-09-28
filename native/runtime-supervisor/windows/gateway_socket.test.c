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

static int listen_target(int family, struct socket_target *target) {
  memset(target, 0, sizeof(*target));
  target->listener = socket(family, SOCK_STREAM, IPPROTO_TCP);
  if (target->listener == INVALID_SOCKET) return 0;
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
      listen(target->listener, 8) != 0 ||
      getsockname(target->listener, (SOCKADDR *)&target->address, &target->size) != 0) return 0;
  target->port = family == AF_INET ? ntohs(((SOCKADDR_IN *)&target->address)->sin_port)
                                  : ntohs(((SOCKADDR_IN6 *)&target->address)->sin6_port);
  return 1;
}

static int connect_target(int family, UINT16 port) {
  SOCKADDR_STORAGE storage = {0};
  int length, result, error = 0, error_size = sizeof(error);
  SOCKET client = socket(family, SOCK_STREAM, IPPROTO_TCP);
  u_long nonblocking = 1;
  fd_set write_set, error_set;
  struct timeval timeout = {2, 0};
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
  if (ioctlsocket(client, FIONBIO, &nonblocking) != 0) { closesocket(client); return 0; }
  result = connect(client, (SOCKADDR *)&storage, length);
  if (result != 0 && WSAGetLastError() == WSAEWOULDBLOCK) {
    FD_ZERO(&write_set); FD_ZERO(&error_set);
    FD_SET(client, &write_set); FD_SET(client, &error_set);
    result = select(0, NULL, &write_set, &error_set, &timeout);
    result = result > 0 && FD_ISSET(client, &write_set) &&
      getsockopt(client, SOL_SOCKET, SO_ERROR, (char *)&error, &error_size) == 0 && error == 0 ? 0 : -1;
  }
  closesocket(client);
  return result == 0;
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

int gateway_socket_leaf(int family, UINT16 gateway, UINT16 hostile) {
  WSADATA data;
  HANDLE token = NULL;
  DWORD contained = 0, returned = 0;
  int result;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 80;
  if (!GetTokenInformation(token, TokenIsAppContainer, &contained, sizeof(contained), &returned)) {
    CloseHandle(token); return 81;
  }
  CloseHandle(token);
  if (!contained || WSAStartup(MAKEWORD(2, 2), &data) != 0) return 82;
  result = (connect_target(family, gateway) ? 1 : 0) | (connect_target(family, hostile) ? 2 : 0) |
           (udp_send(family, gateway) ? 4 : 0);
  WSACleanup();
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
                       UINT16 gateway, UINT16 hostile, DWORD *observed) {
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

static DWORD grant_execute(wchar_t *path, PSID sid, PSECURITY_DESCRIPTOR *original) {
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

static DWORD restore_access(wchar_t *path, PSECURITY_DESCRIPTOR original) {
  PACL acl = NULL;
  BOOL present = FALSE, defaulted = FALSE;
  if (original == NULL) return ERROR_SUCCESS;
  if (!GetSecurityDescriptorDacl(original, &present, &acl, &defaulted)) return GetLastError();
  return SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, acl, NULL);
}

int gateway_socket_proof(void) {
  HMODULE firewall = NULL;
  union { FARPROC address; get_config_fn call; } get_config = {0};
  union { FARPROC address; set_config_fn call; } set_config = {0};
  WSADATA data;
  UUID uuid;
  RPC_WSTR uuid_text = NULL;
  wchar_t profile[80] = {0};
  wchar_t *executable = calloc(32768, sizeof(wchar_t));
  PSID sid = NULL;
  PSID_AND_ATTRIBUTES previous = NULL, configured = NULL;
  PSECURITY_DESCRIPTOR original = NULL;
  DWORD count = 0, result = ERROR_SUCCESS, index;
  int exemption_changed = 0, profile_created = 0, sockets_started = 0, family;
  if (executable == NULL) return 1;
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
  result = (DWORD)CreateAppContainerProfile(profile, profile, L"Disposable Keiko socket test", NULL, 0, &sid);
  if (FAILED((HRESULT)result)) goto done;
  profile_created = 1;
  result = grant_execute(executable, sid, &original);
  if (result != ERROR_SUCCESS) goto done;
  /* Test-only scoped loopback exemption. Preserve and restore the existing configuration.
   * This debug API plus dynamic WFP is NOT a crash-safe production service design. */
  result = get_config.call(&count, &previous);
  if (result != ERROR_SUCCESS) goto done;
  configured = calloc((size_t)count + 1, sizeof(*configured));
  if (configured == NULL) { result = ERROR_OUTOFMEMORY; goto done; }
  for (index = 0; index < count; index++) configured[index] = previous[index];
  configured[count].Sid = sid;
  result = set_config.call(count + 1, configured);
  if (result != ERROR_SUCCESS) goto done;
  exemption_changed = 1;
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) { result = ERROR_NOT_READY; goto done; }
  sockets_started = 1;
  for (family = AF_INET; family <= AF_INET6; family += AF_INET6 - AF_INET) {
    struct socket_target gateway = {0}, hostile = {0};
    struct keiko_gateway_filters filters = {0};
    SOCKET udp = INVALID_SOCKET;
    DWORD observed = 99, closed;
    gateway.listener = INVALID_SOCKET; hostile.listener = INVALID_SOCKET;
    if (!listen_target(family, &gateway) || !listen_target(family, &hostile)) {
      result = ERROR_NOT_READY;
    } else {
      udp = socket(family, SOCK_DGRAM, IPPROTO_UDP);
      if (udp == INVALID_SOCKET || bind(udp, (SOCKADDR *)&gateway.address, gateway.size) != 0) {
        result = ERROR_NOT_READY;
      }
      if (result == ERROR_SUCCESS)
      result = run_child(sid, executable, family, gateway.port, hostile.port, &observed);
      printf("socket-baseline: family=%d code=%lu connections=%lu expected=7 descendant=same\n", family, result, observed);
      if (result == ERROR_SUCCESS && (observed != 7 || udp_received(udp) != 1 || udp_received(udp) != 1))
        result = ERROR_INVALID_DATA;
      if (result == ERROR_SUCCESS)
        result = keiko_gateway_filters_open(sid, (UINT16)family, gateway.port, &filters);
      if (result == ERROR_SUCCESS) {
        observed = 99;
        result = run_child(sid, executable, family, gateway.port, hostile.port, &observed);
        printf("socket-filtered: family=%d code=%lu connections=%lu expected=1 descendant=same\n", family, result, observed);
        if (result == ERROR_SUCCESS && (observed != 1 || udp_received(udp) != 0)) result = ERROR_INVALID_DATA;
      }
    }
    closed = keiko_gateway_filters_close(&filters);
    if (closed != ERROR_SUCCESS) result = closed;
    if (gateway.listener != INVALID_SOCKET) closesocket(gateway.listener);
    if (hostile.listener != INVALID_SOCKET) closesocket(hostile.listener);
    if (udp != INVALID_SOCKET) closesocket(udp);
    if (result != ERROR_SUCCESS) break;
  }
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
  if (original != NULL) LocalFree(original);
  if (sid != NULL) FreeSid(sid);
  for (index = 0; index < count; index++) HeapFree(GetProcessHeap(), 0, previous[index].Sid);
  if (previous != NULL) HeapFree(GetProcessHeap(), 0, previous);
  free(configured); free(executable);
  if (uuid_text != NULL) RpcStringFreeW(&uuid_text);
  if (sockets_started) WSACleanup();
  if (firewall != NULL) FreeLibrary(firewall);
  printf("gateway-socket-proof: %s; code=%lu\n", result == ERROR_SUCCESS ? "passed" : "failed", result);
  return result == ERROR_SUCCESS ? 0 : 1;
}
