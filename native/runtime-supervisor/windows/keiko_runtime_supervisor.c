/* KRP1/KRC1/KRS1 no-shell Windows Job Object runtime supervisor. */
#include "gateway_relay.h"
#include "gateway_environment.h"
#include "gateway_grants.h"
#include "gateway_install.h"
#include "gateway_service.h"
#include <shlobj.h>
#include <bcrypt.h>
#include <userenv.h>
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")
#include <fcntl.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define KRP_VERSION 1u
#define KRP_HEADER_BYTES 12u
#define KRP_MAX_PACKET (128u * 1024u)
#define KRP_MAX_ARGUMENTS 64u
#define KRP_MAX_ENVIRONMENT 64u
#define KRP_RECOVERY_HANDLE_BYTES 32u

enum response_kind { RESPONSE_LAUNCHED = 1, RESPONSE_REAPED = 2, RESPONSE_ERROR = 3 };
enum error_code {
  ERROR_PROTOCOL = 1,
  ERROR_JOB_CREATE = 2,
  ERROR_PROCESS_CREATE = 3,
  ERROR_JOB_ASSIGN = 4,
  ERROR_JOB_OBSERVE = 5,
  /* #4068: the confined tree's filesystem grants, by the step that refused them. */
  ERROR_GRANTS_FRAME = 6,
  ERROR_GRANTS_DIRECTORY = 7,
  ERROR_GRANTS_ACL = 8,
  ERROR_GRANTS_CAPABILITY = 9,
  /* The broker could not be reached or did not prove its SCM identity. */
  ERROR_GATEWAY_CONNECT = 10,
  /* The broker did not acknowledge the suspended tree: its filters, exemption or inbound
   * admission failed, or it answered too late. */
  ERROR_GATEWAY_ADMIT = 11,
  /* #4068 W1: the user environment key could not be closed to the tree (gateway_environment.h). */
  ERROR_ENVIRONMENT_GUARD = 12,
  /* #4068: a relayed launch's open frame was missing or malformed. */
  ERROR_RELAY_FRAME = 13,
  /* #4068: the relayed tree's AppContainer profile could not be created. */
  ERROR_RELAY_PROFILE = 14,
  /* #4068: the host side of the relay (its pipes or listener) could not be created. */
  ERROR_RELAY_START = 15
  /* #4496: 16 and 17 named the isolatedWin32 capabilities and the profile list entries of an
   * unreleased step design; both are unused. A step names its directories by drive letter. */
};

struct launch_request {
  char *storage;
  size_t storage_length;
  char *recovery_handle;
  char *executable;
  char *cwd;
  uint16_t argument_count;
  uint16_t environment_count;
  char **arguments;
  char **environment_names;
  char **environment_values;
};

static uint16_t read_u16(const unsigned char *value) {
  return (uint16_t)value[0] | ((uint16_t)value[1] << 8);
}

static uint32_t read_u32(const unsigned char *value) {
  return (uint32_t)value[0] | ((uint32_t)value[1] << 8) |
         ((uint32_t)value[2] << 16) | ((uint32_t)value[3] << 24);
}

static void write_u16(unsigned char *value, uint16_t number) {
  value[0] = (unsigned char)number;
  value[1] = (unsigned char)(number >> 8);
}

static void write_u32(unsigned char *value, uint32_t number) {
  value[0] = (unsigned char)number;
  value[1] = (unsigned char)(number >> 8);
  value[2] = (unsigned char)(number >> 16);
  value[3] = (unsigned char)(number >> 24);
}

static int read_exact(int descriptor, void *buffer, size_t length) {
  unsigned char *bytes = buffer;
  size_t offset = 0;
  while (offset < length) {
    int result = _read(descriptor, bytes + offset, (unsigned int)(length - offset));
    if (result <= 0) return 0;
    offset += (size_t)result;
  }
  return 1;
}

static int write_exact(int descriptor, const void *buffer, size_t length) {
  const unsigned char *bytes = buffer;
  size_t offset = 0;
  while (offset < length) {
    int result = _write(descriptor, bytes + offset, (unsigned int)(length - offset));
    if (result <= 0) return 0;
    offset += (size_t)result;
  }
  return 1;
}

static int send_response(uint16_t kind, const unsigned char *payload, uint32_t length) {
  unsigned char header[KRP_HEADER_BYTES] = {'K', 'R', 'S', '1', 0, 0, 0, 0, 0, 0, 0, 0};
  write_u16(header + 4, KRP_VERSION);
  write_u16(header + 6, kind);
  write_u32(header + 8, length);
  return write_exact(4, header, sizeof(header)) &&
         (length == 0 || write_exact(4, payload, length));
}

static int send_error(enum error_code code) {
  unsigned char payload[2];
  write_u16(payload, (uint16_t)code);
  return send_response(RESPONSE_ERROR, payload, sizeof(payload));
}

static int valid_utf8(const char *value) {
  int length = (int)strlen(value);
  return length == 0 || MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, length, NULL, 0) > 0;
}

static int valid_recovery_handle(const char *value) {
  size_t index;
  if (strlen(value) != KRP_RECOVERY_HANDLE_BYTES) return 0;
  for (index = 0; index < KRP_RECOVERY_HANDLE_BYTES; ++index) {
    char byte = value[index];
    if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) return 0;
  }
  return 1;
}

static char *take_string(unsigned char **cursor, size_t *remaining) {
  uint32_t length;
  char *value;
  if (*remaining < 4) return NULL;
  length = read_u32(*cursor);
  *cursor += 4;
  *remaining -= 4;
  if (length >= *remaining || memchr(*cursor, 0, length) != NULL || (*cursor)[length] != 0)
    return NULL;
  value = (char *)*cursor;
  value[length] = '\0';
  *cursor += (size_t)length + 1;
  *remaining -= (size_t)length + 1;
  return valid_utf8(value) ? value : NULL;
}

static int read_launch_request(struct launch_request *request) {
  unsigned char header[KRP_HEADER_BYTES], *cursor;
  uint32_t payload_length;
  size_t remaining, allocation_length, index;
  memset(request, 0, sizeof(*request));
  if (!read_exact(3, header, sizeof(header)) || memcmp(header, "KRP1", 4) != 0 ||
      read_u16(header + 4) != KRP_VERSION || read_u16(header + 6) != 1) return 0;
  payload_length = read_u32(header + 8);
  if (payload_length < 16 || payload_length > KRP_MAX_PACKET - KRP_HEADER_BYTES) return 0;
  allocation_length = (size_t)payload_length + 1;
  request->storage = calloc(allocation_length, 1);
  if (request->storage == NULL || !read_exact(3, request->storage, payload_length)) return 0;
  request->storage_length = allocation_length;
  cursor = (unsigned char *)request->storage;
  remaining = payload_length;
  request->argument_count = read_u16(cursor);
  request->environment_count = read_u16(cursor + 2);
  cursor += 4;
  remaining -= 4;
  if (request->argument_count > KRP_MAX_ARGUMENTS ||
      request->environment_count > KRP_MAX_ENVIRONMENT) return 0;
  request->arguments = calloc(request->argument_count, sizeof(char *));
  request->environment_names = calloc(request->environment_count, sizeof(char *));
  request->environment_values = calloc(request->environment_count, sizeof(char *));
  if ((request->argument_count != 0 && request->arguments == NULL) ||
      (request->environment_count != 0 &&
       (request->environment_names == NULL || request->environment_values == NULL))) return 0;
  request->recovery_handle = take_string(&cursor, &remaining);
  request->executable = take_string(&cursor, &remaining);
  request->cwd = take_string(&cursor, &remaining);
  for (index = 0; index < request->argument_count; ++index)
    request->arguments[index] = take_string(&cursor, &remaining);
  for (index = 0; index < request->environment_count; ++index) {
    request->environment_names[index] = take_string(&cursor, &remaining);
    request->environment_values[index] = take_string(&cursor, &remaining);
  }
  if (remaining != 0 || request->recovery_handle == NULL || request->executable == NULL ||
      request->cwd == NULL || !valid_recovery_handle(request->recovery_handle)) return 0;
  for (index = 0; index < request->argument_count; ++index)
    if (request->arguments[index] == NULL) return 0;
  for (index = 0; index < request->environment_count; ++index)
    if (request->environment_names[index] == NULL || request->environment_values[index] == NULL)
      return 0;
  return 1;
}

static void clear_request(struct launch_request *request) {
  if (request->storage != NULL) {
    SecureZeroMemory(request->storage, request->storage_length);
    free(request->storage);
  }
  free(request->arguments);
  free(request->environment_names);
  free(request->environment_values);
  memset(request, 0, sizeof(*request));
}

static wchar_t *wide_string(const char *value) {
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, NULL, 0);
  wchar_t *wide;
  if (length <= 0) return NULL;
  wide = calloc((size_t)length, sizeof(wchar_t));
  if (wide == NULL || MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, wide, length) != length) {
    free(wide);
    return NULL;
  }
  return wide;
}

static size_t quoted_length(const wchar_t *value) {
  size_t length = 2, backslashes = 0;
  const wchar_t *cursor;
  for (cursor = value; *cursor != L'\0'; ++cursor) {
    if (*cursor == L'\\') {
      ++backslashes;
    } else {
      length += backslashes + (*cursor == L'"' ? backslashes + 2 : 1);
      backslashes = 0;
    }
  }
  return length + backslashes * 2 + 1;
}

static wchar_t *append_quoted(wchar_t *output, const wchar_t *value) {
  size_t backslashes = 0;
  *output++ = L'"';
  while (*value != L'\0') {
    if (*value == L'\\') {
      ++backslashes;
    } else {
      if (*value == L'"') backslashes *= 2;
      while (backslashes-- != 0) *output++ = L'\\';
      backslashes = 0;
      if (*value == L'"') *output++ = L'\\';
      *output++ = *value;
    }
    ++value;
  }
  while (backslashes-- != 0) {
    *output++ = L'\\';
    *output++ = L'\\';
  }
  *output++ = L'"';
  return output;
}

/* `verbatim` (#4496): a verification step's arguments arrive already quoted for their image, as
 * Node.js passes `windowsVerbatimArguments`, so the hardened `cmd.exe /d /s /c "..."` line of a
 * command script reaches cmd.exe unchanged. Every other launch quotes each argument. */
static wchar_t *command_line(const struct launch_request *request, const wchar_t *executable,
                             int verbatim) {
  wchar_t **arguments = calloc(request->argument_count, sizeof(wchar_t *));
  wchar_t *line, *cursor;
  size_t length = quoted_length(executable), index;
  if (arguments == NULL && request->argument_count != 0) return NULL;
  for (index = 0; index < request->argument_count; ++index) {
    arguments[index] = wide_string(request->arguments[index]);
    if (arguments[index] == NULL) goto failure;
    length += 1 + (verbatim ? wcslen(arguments[index]) : quoted_length(arguments[index]));
  }
  line = calloc(length + 1, sizeof(wchar_t));
  if (line == NULL) goto failure;
  cursor = append_quoted(line, executable);
  for (index = 0; index < request->argument_count; ++index) {
    *cursor++ = L' ';
    if (!verbatim) {
      cursor = append_quoted(cursor, arguments[index]);
      continue;
    }
    memcpy(cursor, arguments[index], wcslen(arguments[index]) * sizeof(wchar_t));
    cursor += wcslen(arguments[index]);
  }
  *cursor = L'\0';
  for (index = 0; index < request->argument_count; ++index) free(arguments[index]);
  free(arguments);
  return line;
failure:
  for (index = 0; index < request->argument_count; ++index) free(arguments[index]);
  free(arguments);
  return NULL;
}

/* Variables the supervisor resolves itself; a launch request can never set them. */
static int environment_name_is_pinned(const char *name, const wchar_t *appdata) {
  return _stricmp(name, "SystemRoot") == 0 || (appdata && _stricmp(name, "LOCALAPPDATA") == 0);
}

static wchar_t *append_pinned_variable(wchar_t *cursor, const wchar_t *prefix, const wchar_t *value) {
  size_t prefix_length = wcslen(prefix), value_length = wcslen(value);
  memcpy(cursor, prefix, prefix_length * sizeof(*cursor));
  memcpy(cursor + prefix_length, value, (value_length + 1) * sizeof(*cursor));
  return cursor + prefix_length + value_length + 1;
}

static wchar_t *environment_block(const struct launch_request *request, const wchar_t *appdata) {
  wchar_t *block, *cursor;
  wchar_t system_root[MAX_PATH];
  size_t length = 1, index;
  const wchar_t prefix[] = L"LOCALAPPDATA=";
  const wchar_t system_root_prefix[] = L"SystemRoot=";
  /* Winsock loads its providers through SystemRoot: without it socket() fails with 10106 and a
   * confined root cannot reach even its attested gateway (#4068 W11). Ask the OS, not the packet. */
  UINT system_root_length = GetSystemWindowsDirectoryW(system_root, MAX_PATH);
  if (system_root_length == 0 || system_root_length >= MAX_PATH) return NULL;
  length += wcslen(system_root_prefix) + system_root_length + 1;
  if (appdata) length += wcslen(prefix) + wcslen(appdata) + 1;
  for (index = 0; index < request->environment_count; ++index) {
    if (environment_name_is_pinned(request->environment_names[index], appdata)) continue;
    int name = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                   request->environment_names[index], -1, NULL, 0);
    int value = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                    request->environment_values[index], -1, NULL, 0);
    if (name <= 1 || value <= 0 || strchr(request->environment_names[index], '=') != NULL) return NULL;
    length += (size_t)name + (size_t)value;
  }
  block = calloc(length + 1, sizeof(wchar_t));
  if (block == NULL) return NULL;
  cursor = append_pinned_variable(block, system_root_prefix, system_root);
  if (appdata) cursor = append_pinned_variable(cursor, prefix, appdata);
  for (index = 0; index < request->environment_count; ++index) {
    if (environment_name_is_pinned(request->environment_names[index], appdata)) continue;
    int name = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                   request->environment_names[index], -1, cursor,
                                   (int)(length - (size_t)(cursor - block)));
    cursor += name - 1;
    *cursor++ = L'=';
    cursor += MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                  request->environment_values[index], -1, cursor,
                                  (int)(length - (size_t)(cursor - block)));
  }
  *cursor = L'\0';
  return block;
}

static void job_name(const char *recovery_handle, wchar_t name[64]) {
  const wchar_t prefix[] = L"Local\\KeikoRuntime-";
  size_t prefix_length = wcslen(prefix), index;
  memcpy(name, prefix, sizeof(prefix));
  for (index = 0; index < KRP_RECOVERY_HANDLE_BYTES; ++index)
    name[prefix_length + index] = (wchar_t)recovery_handle[index];
  name[prefix_length + KRP_RECOVERY_HANDLE_BYTES] = L'\0';
}

static HANDLE configured_job(const char *recovery_handle, HANDLE *completion_port) {
  wchar_t name[64];
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association;
  HANDLE job;
  job_name(recovery_handle, name);
  job = CreateJobObjectW(NULL, name);
  if (job == NULL || GetLastError() == ERROR_ALREADY_EXISTS) {
    if (job != NULL) CloseHandle(job);
    return NULL;
  }
  memset(&limits, 0, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    CloseHandle(job);
    return NULL;
  }
  *completion_port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
  association.CompletionKey = job;
  association.CompletionPort = *completion_port;
  if (*completion_port == NULL || !SetInformationJobObject(
      job, JobObjectAssociateCompletionPortInformation, &association, sizeof(association))) {
    if (*completion_port != NULL) CloseHandle(*completion_port);
    CloseHandle(job);
    return NULL;
  }
  return job;
}

static int initialize_startup_info(STARTUPINFOEXW *startup, HANDLE inherited[3], HANDLE *job,
                                   SECURITY_CAPABILITIES *capabilities) {
  SIZE_T attribute_size = 0;
  DWORD attributes = capabilities ? 3 : 2;
  memset(startup, 0, sizeof(*startup));
  startup->StartupInfo.cb = sizeof(*startup);
  startup->StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup->StartupInfo.hStdInput = inherited[0];
  startup->StartupInfo.hStdOutput = inherited[1];
  startup->StartupInfo.hStdError = inherited[2];
  InitializeProcThreadAttributeList(NULL, attributes, 0, &attribute_size);
  startup->lpAttributeList = calloc(1, attribute_size);
  if (startup->lpAttributeList == NULL) return 0;
  if (InitializeProcThreadAttributeList(startup->lpAttributeList, attributes, 0, &attribute_size)) {
    /* Bind the suspended child to its kill-on-close job in CreateProcessW itself. A
     * supervisor crash must never strand a process between creation and job assignment. */
    if (UpdateProcThreadAttribute(startup->lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                  job, sizeof(*job), NULL, NULL) &&
        UpdateProcThreadAttribute(startup->lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                  inherited, 3 * sizeof(HANDLE), NULL, NULL) &&
        (!capabilities || UpdateProcThreadAttribute(startup->lpAttributeList, 0,
          PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, capabilities, sizeof(*capabilities),
          NULL, NULL))) return 1;
    DeleteProcThreadAttributeList(startup->lpAttributeList);
  }
  free(startup->lpAttributeList);
  return 0;
}

static int admit_gateway(struct keiko_gateway_connection *gateway, HANDLE job,
                         const struct launch_request *request) {
  BYTE frame[KEIKO_GATEWAY_OPEN_BYTES];
  HANDLE control = (HANDLE)_get_osfhandle(3);
  ULONGLONG deadline = GetTickCount64() + 4000;
  DWORD available;
  while (PeekNamedPipe(control, NULL, 0, NULL, &available, NULL)) {
    if (available >= sizeof(frame))
      return read_exact(3, frame, sizeof(frame)) &&
             !memcmp(frame + 44, request->recovery_handle, KRP_RECOVERY_HANDLE_BYTES) &&
             keiko_gateway_confirm(gateway, job, frame);
    if (GetTickCount64() >= deadline) break;
    Sleep(10);
  }
  return 0;
}

/* #4068: the relay root's command line: this image, its plan, then the runtime's own line. */
static wchar_t *relay_command_line(const wchar_t *self, const wchar_t *plan, const wchar_t *runtime) {
  size_t length = quoted_length(self) + wcslen(L" --container-relay ") + wcslen(plan) + 1 +
                  wcslen(runtime) + 1;
  wchar_t *line = calloc(length, sizeof(wchar_t)), *cursor;
  if (line == NULL) return NULL;
  cursor = append_quoted(line, self);
  *cursor = L'\0';
  if (wcscat_s(line, length, L" --container-relay ") != 0 || wcscat_s(line, length, plan) != 0 ||
      wcscat_s(line, length, L" ") != 0 || wcscat_s(line, length, runtime) != 0) {
    free(line);
    return NULL;
  }
  return line;
}

/* The container a launch runs in: the broker's (with its loopback capability) or, for a relayed
 * launch, one this supervisor created without any network capability (#4068, ADR-0043 D21). */
struct confinement {
  PSID sid;
  /* NULL for a relayed launch: the tree holds no network capability at all. */
  PSID network_capability;
  struct keiko_gateway_connection *gateway;
  /* Non-NULL for a relayed launch: the relay root's plan argument. */
  const wchar_t *relay_plan;
  /* Non-zero for a verification step: its arguments are already quoted (command_line). */
  int verbatim_arguments;
};

static int launch_in_job(const struct launch_request *request, HANDLE job,
                         PROCESS_INFORMATION *process, const struct confinement *confined,
                         struct keiko_gateway_grants *grants, int *admission_refused) {
  STARTUPINFOEXW startup;
  SECURITY_CAPABILITIES capabilities = {0};
  /* Retained through CreateProcessW, like the attribute list that points at it. */
  SID_AND_ATTRIBUTES held[KEIKO_GATEWAY_GRANTS_MAX + 1] = {0};
  wchar_t *appdata = NULL;
  wchar_t self[MAX_PATH + 1];
  struct keiko_gateway_connection *gateway = confined ? confined->gateway : NULL;
  if (confined) {
    capabilities.AppContainerSid = confined->sid;
    /* Inbound loopback for the host's control connection, then a managed worktree's capability,
     * granted read access before this spawn (#4068). A relayed tree holds no network capability. */
    if (confined->network_capability != NULL) {
      held[0].Sid = confined->network_capability;
      held[0].Attributes = SE_GROUP_ENABLED;
      capabilities.CapabilityCount = 1;
    }
    for (DWORD i = 0; grants != NULL && i < grants->capability_count &&
                      i < KEIKO_GATEWAY_GRANTS_MAX; i++)
      held[capabilities.CapabilityCount++] = grants->capabilities[i];
    /* CreateProcessW refuses a capability array of length zero (ERROR_INVALID_PARAMETER). */
    capabilities.Capabilities = capabilities.CapabilityCount != 0 ? held : NULL;
    /* AppContainer process creation needs LOCALAPPDATA even when the caller submits a
     * hermetic environment. Resolve it for this user; never trust a packet-supplied path. */
    if (FAILED(SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, NULL, &appdata))) return 0;
    if (!SetEnvironmentVariableW(L"LOCALAPPDATA", appdata)) { CoTaskMemFree(appdata); return 0; }
  }
  /* UpdateProcThreadAttribute retains this pointer through CreateProcessW. A callee-local array
   * expires when startup initialization returns, causing ERROR_INVALID_PARAMETER without inlining. */
  HANDLE inherited[3] = {GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE),
                         GetStdHandle(STD_ERROR_HANDLE)};
  wchar_t *executable = wide_string(request->executable);
  wchar_t *cwd = wide_string(request->cwd);
  wchar_t *line = executable == NULL
                      ? NULL
                      : command_line(request, executable, confined && confined->verbatim_arguments);
  wchar_t *environment = environment_block(request, appdata);
  const wchar_t *image = executable;
  CoTaskMemFree(appdata);
  /* A relayed tree's root is this image, which starts the runtime as its child. */
  if (confined && confined->relay_plan != NULL && line != NULL) {
    DWORD self_length = GetModuleFileNameW(NULL, self, MAX_PATH + 1);
    wchar_t *relayed = self_length == 0 || self_length > MAX_PATH
                           ? NULL
                           : relay_command_line(self, confined->relay_plan, line);
    SecureZeroMemory(line, wcslen(line) * sizeof(wchar_t));
    free(line);
    line = relayed;
    image = self;
  }
  DWORD flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP |
                EXTENDED_STARTUPINFO_PRESENT;
  BOOL created = FALSE;
  if (executable != NULL && cwd != NULL && line != NULL && environment != NULL &&
      initialize_startup_info(&startup, inherited, &job, confined ? &capabilities : NULL)) {
    created = CreateProcessW(image, line, NULL, NULL, TRUE, flags, environment, cwd,
                             &startup.StartupInfo, process);
    if (!created && confined)
      fprintf(stderr, "confined suspended spawn failed: %lu\n", GetLastError());
    if (created && gateway && !admit_gateway(gateway, job, request)) *admission_refused = 1;
    if (created && (*admission_refused || ResumeThread(process->hThread) == (DWORD)-1)) {
      TerminateJobObject(job, 127);
      created = FALSE;
    }
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    free(startup.lpAttributeList);
  }
  if (!created && process->hProcess != NULL) CloseHandle(process->hProcess);
  if (process->hThread != NULL) CloseHandle(process->hThread);
  free(executable);
  free(cwd);
  if (line != NULL) {
    SecureZeroMemory(line, wcslen(line) * sizeof(wchar_t));
    free(line);
  }
  if (environment != NULL) {
    SecureZeroMemory(environment, (wcslen(environment) + 2) * sizeof(wchar_t));
    free(environment);
  }
  return created != FALSE;
}

static int process_control(HANDLE job) {
  HANDLE control = (HANDLE)_get_osfhandle(3);
  DWORD available = 0;
  unsigned char header[KRP_HEADER_BYTES];
  if (!PeekNamedPipe(control, NULL, 0, NULL, &available, NULL)) {
    TerminateJobObject(job, 137);
    return 0;
  }
  if (available < sizeof(header)) return 1;
  if (!read_exact(3, header, sizeof(header)) || memcmp(header, "KRC1", 4) != 0 ||
      read_u16(header + 4) != KRP_VERSION || read_u32(header + 8) != 0 ||
      (read_u16(header + 6) != 2 && read_u16(header + 6) != 3)) {
    TerminateJobObject(job, 137);
    return 0;
  }
  TerminateJobObject(job, read_u16(header + 6) == 2 ? 130 : 137);
  return 1;
}

/*
 * KEIKO-0270: reports the OBSERVED active-process count through `observed` so wmain can put it in
 * the reap proof. It used to be discarded here and the proof hard-coded a literal 0, which made
 * the harness's "Job Object must report zero active processes" assertion read a constant the
 * producer wrote rather than anything the Job Object said — an assertion that could not fail.
 */
static int wait_for_zero_active(HANDLE job, HANDLE completion_port, uint32_t *observed) {
  *observed = UINT32_MAX;
  for (;;) {
    DWORD bytes = 0;
    ULONG_PTR key = 0;
    LPOVERLAPPED overlapped = NULL;
    BOOL dequeued = GetQueuedCompletionStatus(completion_port, &bytes, &key, &overlapped, 50);
    if (dequeued && key == (ULONG_PTR)job && bytes == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
      memset(&accounting, 0, sizeof(accounting));
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting,
                                     sizeof(accounting), NULL)) {
        return 0;
      }
      *observed = (uint32_t)accounting.ActiveProcesses;
      return accounting.ActiveProcesses == 0;
    }
    if (!process_control(job)) return 0;
  }
}

static int wide_recovery_handle(const wchar_t *wide, char output[KRP_RECOVERY_HANDLE_BYTES + 1]) {
  size_t index;
  if (wcslen(wide) != KRP_RECOVERY_HANDLE_BYTES) return 0;
  for (index = 0; index < KRP_RECOVERY_HANDLE_BYTES; ++index) {
    wchar_t byte = wide[index];
    if (!((byte >= L'0' && byte <= L'9') || (byte >= L'a' && byte <= L'f'))) return 0;
    output[index] = (char)byte;
  }
  output[KRP_RECOVERY_HANDLE_BYTES] = '\0';
  return 1;
}

static int reconcile_job(const wchar_t *wide_handle) {
  char recovery_handle[KRP_RECOVERY_HANDLE_BYTES + 1];
  wchar_t name[64];
  HANDLE job;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  unsigned char proof[8] = {0};
  DWORD attempt;
  if (!wide_recovery_handle(wide_handle, recovery_handle)) {
    (void)send_error(ERROR_PROTOCOL);
    return 1;
  }
  job_name(recovery_handle, name);
  job = OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, FALSE, name);
  if (job == NULL && GetLastError() == ERROR_FILE_NOT_FOUND)
    return send_response(RESPONSE_REAPED, proof, sizeof(proof)) ? 0 : 1;
  if (job == NULL || !TerminateJobObject(job, 137)) {
    if (job != NULL) CloseHandle(job);
    (void)send_error(ERROR_JOB_OBSERVE);
    return 1;
  }
  for (attempt = 0; attempt < 500; ++attempt) {
    memset(&accounting, 0, sizeof(accounting));
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting,
                                   sizeof(accounting), NULL)) break;
    if (accounting.ActiveProcesses == 0) {
      CloseHandle(job);
      return send_response(RESPONSE_REAPED, proof, sizeof(proof)) ? 0 : 1;
    }
    Sleep(20);
  }
  CloseHandle(job);
  (void)send_error(ERROR_JOB_OBSERVE);
  return 1;
}

/* MCP providers are operator-configured host programs, not Coding sandbox actions. */
static int mcp_stdio_owner(int argc, wchar_t **argv) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  STARTUPINFOEXW startup;
  HANDLE inherited[3] = {GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE),
                         GetStdHandle(STD_ERROR_HANDLE)};
  PROCESS_INFORMATION child;
  HANDLE job = NULL;
  wchar_t *line = NULL, *cursor;
  size_t length = 1;
  DWORD exit_code = 127;
  int index, result = 1;
  if (argc < 3) return 1;
  for (index = 2; index < argc; ++index) {
    size_t added = quoted_length(argv[index]) + 1;
    if (added > 32767 - length) return 1;
    length += added;
  }
  line = calloc(length, sizeof(wchar_t));
  if (line == NULL) return 1;
  cursor = line;
  for (index = 2; index < argc; ++index) {
    if (index != 2) *cursor++ = L' ';
    cursor = append_quoted(cursor, argv[index]);
  }
  *cursor = L'\0';
  memset(&limits, 0, sizeof(limits));
  memset(&startup, 0, sizeof(startup));
  memset(&child, 0, sizeof(child));
  /* No breakaway flags: grandchildren remain in this lifetime scope as well. */
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  job = CreateJobObjectW(NULL, NULL);
  if (job == NULL || !SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                             &limits, sizeof(limits))) goto cleanup;
  if (!initialize_startup_info(&startup, inherited, &job, NULL)) goto cleanup;
  BOOL created = CreateProcessW(argv[2], line, NULL, NULL, TRUE,
      CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, NULL, NULL, &startup.StartupInfo, &child);
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList);
  if (!created) goto cleanup;
  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(child.hProcess, &exit_code)) goto cleanup;
  result = (int)exit_code;
cleanup:
  if (job != NULL) {
    (void)TerminateJobObject(job, 127);
    CloseHandle(job);
  }
  if (child.hThread != NULL) CloseHandle(child.hThread);
  if (child.hProcess != NULL) CloseHandle(child.hProcess);
  free(line);
  return result;
}

/* #4068: a relayed launch reads the server's KGB1 open itself (no broker consumes it) and takes
 * only the gateway's IPv4 loopback port from it; the frame must name this run's recovery handle. */
static int read_relay_open(const struct launch_request *request, USHORT *gateway_port) {
  BYTE frame[KEIKO_GATEWAY_OPEN_BYTES];
  HANDLE control = (HANDLE)_get_osfhandle(3);
  ULONGLONG deadline = GetTickCount64() + 4000;
  DWORD available;
  while (PeekNamedPipe(control, NULL, 0, NULL, &available, NULL)) {
    if (available >= sizeof(frame)) {
      if (!read_exact(3, frame, sizeof(frame)) || memcmp(frame, "KGB1", 4) != 0 ||
          read_u16(frame + 4) != 1 || read_u16(frame + 6) != 1 ||
          read_u32(frame + 8) != sizeof(frame) - KRP_HEADER_BYTES ||
          memcmp(frame + 44, request->recovery_handle, KRP_RECOVERY_HANDLE_BYTES) != 0 ||
          read_u16(frame + 84) != 2 || read_u16(frame + 86) == 0)
        return 0;
      *gateway_port = read_u16(frame + 86);
      return 1;
    }
    if (GetTickCount64() >= deadline) break;
    Sleep(10);
  }
  return 0;
}

struct relay_container {
  wchar_t profile[64];
  PSID sid;
};

/* A fresh per-run AppContainer with no capability at all; a standard user may create it. */
static int relay_profile_create(struct relay_container *container, const wchar_t *prefix) {
  static const wchar_t hex[] = L"0123456789abcdef";
  BYTE random[16];
  size_t offset;
  HRESULT result;
  if (BCryptGenRandom(NULL, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) return 0;
  wcscpy_s(container->profile, 64, prefix);
  offset = wcslen(container->profile);
  for (size_t i = 0; i < sizeof(random); i++) {
    container->profile[offset++] = hex[random[i] >> 4];
    container->profile[offset++] = hex[random[i] & 15];
  }
  container->profile[offset] = 0;
  result = CreateAppContainerProfile(container->profile, container->profile,
                                     L"Keiko supervised runtime", NULL, 0, &container->sid);
  if (FAILED(result)) {
    fprintf(stderr, "relay profile creation failed: %08lx\n", (unsigned long)result);
    container->sid = NULL;
    return 0;
  }
  return 1;
}

static void relay_profile_delete(struct relay_container *container) {
  if (container->sid == NULL) return;
  HRESULT deleted = DeleteAppContainerProfile(container->profile);
  if (FAILED(deleted))
    fprintf(stderr, "relay profile cleanup failed: %08lx\n", (unsigned long)deleted);
  FreeSid(container->sid);
  container->sid = NULL;
}

int wmain(int argc, wchar_t **argv) {
  struct keiko_gateway_connection gateway = {0};
  struct keiko_gateway_grants grants = {0};
  struct keiko_environment_holder holder;
  struct keiko_gateway_sweep sweep = {0};
  unsigned char launched[8];
  int environment_closed = 0;
  int brokered = argc == 2 && wcscmp(argv[1], L"--gateway-supervised") == 0;
  /* #4068 (ADR-0043 D21): the same confinement without an installed broker or elevation. */
  int relayed = argc == 2 && wcscmp(argv[1], L"--relay-supervised") == 0;
  /* #4496: one verification step as the tree's root, with no relay and no network at all. */
  int stepped = argc == 2 && wcscmp(argv[1], L"--step-supervised") == 0;
  int confined = brokered || relayed || stepped;
  struct relay_container relay = {0};
  struct keiko_relay_plan plan = {0};
  wchar_t plan_text[KEIKO_RELAY_PLAN_CHARS];
  struct confinement confinement = {0};
  PSID tree_sid = NULL;
  struct launch_request request;
  PROCESS_INFORMATION process;
  HANDLE job = NULL, completion_port = NULL;
  DWORD exit_code = 127;
  unsigned char proof[8];
  uint32_t active_processes = UINT32_MAX;
  int result = 1;
  /*
   * The supervisor is staged beneath a developer checkout.  Its implicit imports are constrained
   * before wmain by /MT and /DEPENDENTLOADFLAG:0x800 in build-runtime-supervisor.mjs; these calls
   * close the remaining search-path surface for any later LoadLibrary-style dependency.
   */
  if (!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) || !SetDllDirectoryW(L"")) return 1;
  if (argc == 2 && wcscmp(argv[1], L"--gateway-service") == 0) return keiko_gateway_dispatch();
  if (argc == 3 && wcscmp(argv[1], L"--gateway-installed") == 0)
    return keiko_gateway_launch_installed(argv[2]);
  if (argc == 3 && wcscmp(argv[1], L"--gateway-service-status") == 0)
    return keiko_gateway_service_status(argv[2]);
  if (argc == 3 && wcscmp(argv[1], L"--gateway-service-install") == 0)
    return keiko_gateway_service_install(argv[2]);
  if (argc == 2 && wcscmp(argv[1], L"--gateway-service-uninstall") == 0)
    return keiko_gateway_service_uninstall();
  if (argc == 2 && wcscmp(argv[1], L"--probe-stdio-owner") == 0) {
    puts("{\"schemaVersion\":1,\"ownedStdio\":\"windows-job\"}");
    return 0;
  }
  if (argc >= 2 && wcscmp(argv[1], L"--stdio-owner") == 0) return mcp_stdio_owner(argc, argv);
  /* Inside the relayed tree's AppContainer: this image is the tree's root (gateway_relay.h). */
  if (argc >= 4 && wcscmp(argv[1], L"--container-relay") == 0)
    return keiko_relay_container_main(argc, argv);
  memset(&process, 0, sizeof(process));
  if (argc == 3 && wcscmp(argv[1], L"--reconcile") == 0) return reconcile_job(argv[2]);
  if (argc != 1 && !confined) {
    (void)send_error(ERROR_PROTOCOL);
    return 1;
  }
  if (_setmode(3, _O_BINARY) == -1 || _setmode(4, _O_BINARY) == -1 || !read_launch_request(&request)) {
    send_error(ERROR_PROTOCOL);
    return 1;
  }
  if (brokered && !keiko_gateway_connect(&gateway)) {
    send_error(ERROR_GATEWAY_CONNECT);
    goto cleanup;
  }
  if ((relayed || stepped) &&
      !relay_profile_create(&relay, stepped ? L"Keiko.Step." : L"Keiko.Relay.")) {
    send_error(ERROR_RELAY_PROFILE);
    goto cleanup;
  }
  tree_sid = brokered ? gateway.sid : relay.sid;
  /* #4068: the tree's filesystem grants follow the launch packet. They need the tree's SID and
   * must exist before the suspended root does; a refused grant refuses the launch. */
  if (confined && !keiko_gateway_grants_read(3, &grants)) {
    send_error(ERROR_GRANTS_FRAME);
    goto cleanup;
  }
  if (relayed) {
    USHORT gateway_port = 0;
    if (!read_relay_open(&request, &gateway_port)) {
      send_error(ERROR_RELAY_FRAME);
      goto cleanup;
    }
    memcpy(plan.prefix, request.recovery_handle, KRP_RECOVERY_HANDLE_BYTES);
    plan.route_count = 2;
    plan.routes[0].direction = KEIKO_RELAY_OUTBOUND;
    plan.routes[0].host_port = gateway_port;
    plan.routes[1].direction = KEIKO_RELAY_INBOUND;
    /* The host side binds the runtime's host-facing port and writes it back into the plan. */
    if (!keiko_relay_host_start(&plan, relay.sid) ||
        !keiko_relay_plan_format(&plan, plan_text, KEIKO_RELAY_PLAN_CHARS)) {
      send_error(ERROR_RELAY_START);
      goto cleanup;
    }
    confinement.relay_plan = plan_text;
  }
  confinement.sid = tree_sid;
  confinement.verbatim_arguments = stepped;
  confinement.network_capability = brokered ? (PSID)gateway.network_capability : NULL;
  confinement.gateway = brokered ? &gateway : NULL;
  if (confined) {
    int refused;
    sweep.grants = &grants;
    /* Before the suspended root exists: a value stored with setx stays out of the tree. The run
     * becomes a recorded holder before it grants anything, so a run that finds no live holder may
     * remove the tree entries a crashed supervisor left (#4068, ADR-0043 D18). */
    if (!keiko_environment_holder_self(&holder) ||
        keiko_environment_close_alone(&KEIKO_ENVIRONMENT_USER, &holder,
                                      keiko_gateway_grants_sweep, &sweep) != ERROR_SUCCESS) {
      send_error(ERROR_ENVIRONMENT_GUARD);
      goto cleanup;
    }
    environment_closed = 1;
    refused = keiko_gateway_grants_apply(&grants, tree_sid);
    if (refused != KEIKO_GRANTS_APPLIED) {
      send_error(refused == KEIKO_GRANTS_REFUSED_DIRECTORY    ? ERROR_GRANTS_DIRECTORY
                 : refused == KEIKO_GRANTS_REFUSED_CAPABILITY ? ERROR_GRANTS_CAPABILITY
                                                              : ERROR_GRANTS_ACL);
      goto cleanup;
    }
  }
  job = configured_job(request.recovery_handle, &completion_port);
  if (job == NULL) {
    send_error(ERROR_JOB_CREATE);
    goto cleanup;
  }
  int admission_refused = 0;
  if (!launch_in_job(&request, job, &process, confined ? &confinement : NULL,
                     confined ? &grants : NULL, &admission_refused)) {
    send_error(admission_refused ? ERROR_GATEWAY_ADMIT : ERROR_PROCESS_CREATE);
    goto cleanup;
  }
  /* A confined launch reports its sweep as two counts: stale tree entries removed, and directories
   * or entries the sweep could not clean (#4068). An unconfined launch keeps the empty response. */
  write_u32(launched, sweep.removed);
  write_u32(launched + 4, sweep.failed);
  if (!send_response(RESPONSE_LAUNCHED, confined ? launched : NULL, confined ? sizeof(launched) : 0))
    goto cleanup;
  if (!wait_for_zero_active(job, completion_port, &active_processes)) {
    send_error(ERROR_JOB_OBSERVE);
    goto cleanup;
  }
  if (!GetExitCodeProcess(process.hProcess, &exit_code)) exit_code = 127;
  write_u32(proof, exit_code);
  /* KEIKO-0270: the observed count, not a literal 0 — see wait_for_zero_active. */
  write_u32(proof + 4, active_processes);
  result = send_response(RESPONSE_REAPED, proof, sizeof(proof)) ? 0 : 1;
cleanup:
  if (result != 0 && job != NULL) TerminateJobObject(job, 137);
  if (process.hProcess != NULL) CloseHandle(process.hProcess);
  if (completion_port != NULL) CloseHandle(completion_port);
  if (job != NULL) CloseHandle(job);
  if (relayed) keiko_relay_host_stop();
  /* The tree is reaped or never started; its own grants go before its profile does. */
  if (tree_sid != NULL) keiko_gateway_grants_revoke(&grants, tree_sid);
  /* The last run to end restores the key; a failure keeps it closed and the next run retries. */
  if (environment_closed &&
      keiko_environment_reopen(&KEIKO_ENVIRONMENT_USER, &holder) != ERROR_SUCCESS)
    fputs("gateway environment reopen failed\n", stderr);
  keiko_gateway_grants_clear(&grants);
  keiko_gateway_disconnect(&gateway);
  relay_profile_delete(&relay);
  clear_request(&request);
  return result;
}
