/* KRP1/KRC1/KRS1 no-shell Windows Job Object runtime supervisor. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <stdint.h>
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
  ERROR_JOB_OBSERVE = 5
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

static wchar_t *command_line(const struct launch_request *request, const wchar_t *executable) {
  wchar_t **arguments = calloc(request->argument_count, sizeof(wchar_t *));
  wchar_t *line, *cursor;
  size_t length = quoted_length(executable), index;
  if (arguments == NULL && request->argument_count != 0) return NULL;
  for (index = 0; index < request->argument_count; ++index) {
    arguments[index] = wide_string(request->arguments[index]);
    if (arguments[index] == NULL) goto failure;
    length += 1 + quoted_length(arguments[index]);
  }
  line = calloc(length + 1, sizeof(wchar_t));
  if (line == NULL) goto failure;
  cursor = append_quoted(line, executable);
  for (index = 0; index < request->argument_count; ++index) {
    *cursor++ = L' ';
    cursor = append_quoted(cursor, arguments[index]);
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

static wchar_t *environment_block(const struct launch_request *request) {
  wchar_t *block, *cursor;
  size_t length = 1, index;
  for (index = 0; index < request->environment_count; ++index) {
    int name = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                   request->environment_names[index], -1, NULL, 0);
    int value = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                    request->environment_values[index], -1, NULL, 0);
    if (name <= 1 || value <= 0 || strchr(request->environment_names[index], '=') != NULL) return NULL;
    length += (size_t)name + (size_t)value;
  }
  block = calloc(length + 1, sizeof(wchar_t));
  if (block == NULL) return NULL;
  cursor = block;
  for (index = 0; index < request->environment_count; ++index) {
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

static int initialize_startup_info(STARTUPINFOEXW *startup, SIZE_T *attribute_size) {
  HANDLE inherited[3] = {GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE),
                         GetStdHandle(STD_ERROR_HANDLE)};
  memset(startup, 0, sizeof(*startup));
  startup->StartupInfo.cb = sizeof(*startup);
  startup->StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup->StartupInfo.hStdInput = inherited[0];
  startup->StartupInfo.hStdOutput = inherited[1];
  startup->StartupInfo.hStdError = inherited[2];
  InitializeProcThreadAttributeList(NULL, 1, 0, attribute_size);
  startup->lpAttributeList = calloc(1, *attribute_size);
  return startup->lpAttributeList != NULL &&
         InitializeProcThreadAttributeList(startup->lpAttributeList, 1, 0, attribute_size) &&
         UpdateProcThreadAttribute(startup->lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                   inherited, sizeof(inherited), NULL, NULL);
}

static int launch_in_job(const struct launch_request *request, HANDLE job,
                         PROCESS_INFORMATION *process) {
  STARTUPINFOEXW startup;
  SIZE_T attribute_size = 0;
  wchar_t *executable = wide_string(request->executable);
  wchar_t *cwd = wide_string(request->cwd);
  wchar_t *line = executable == NULL ? NULL : command_line(request, executable);
  wchar_t *environment = environment_block(request);
  DWORD flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP |
                EXTENDED_STARTUPINFO_PRESENT;
  BOOL created = FALSE;
  if (executable != NULL && cwd != NULL && line != NULL && environment != NULL &&
      initialize_startup_info(&startup, &attribute_size)) {
    created = CreateProcessW(executable, line, NULL, NULL, TRUE, flags, environment, cwd,
                             &startup.StartupInfo, process);
    if (created && !AssignProcessToJobObject(job, process->hProcess)) {
      TerminateProcess(process->hProcess, 127);
      created = FALSE;
    }
    if (created && ResumeThread(process->hThread) == (DWORD)-1) {
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

int wmain(int argc, wchar_t **argv) {
  struct launch_request request;
  PROCESS_INFORMATION process;
  HANDLE job = NULL, completion_port = NULL;
  DWORD exit_code = 127;
  unsigned char proof[8];
  uint32_t active_processes = UINT32_MAX;
  int result = 1;
  memset(&process, 0, sizeof(process));
  if (argc == 3 && wcscmp(argv[1], L"--reconcile") == 0) return reconcile_job(argv[2]);
  if (argc != 1) {
    (void)send_error(ERROR_PROTOCOL);
    return 1;
  }
  if (_setmode(3, _O_BINARY) == -1 || _setmode(4, _O_BINARY) == -1 || !read_launch_request(&request)) {
    send_error(ERROR_PROTOCOL);
    return 1;
  }
  job = configured_job(request.recovery_handle, &completion_port);
  if (job == NULL) {
    send_error(ERROR_JOB_CREATE);
    goto cleanup;
  }
  if (!launch_in_job(&request, job, &process)) {
    send_error(ERROR_PROCESS_CREATE);
    goto cleanup;
  }
  if (!send_response(RESPONSE_LAUNCHED, NULL, 0)) goto cleanup;
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
  clear_request(&request);
  return result;
}
