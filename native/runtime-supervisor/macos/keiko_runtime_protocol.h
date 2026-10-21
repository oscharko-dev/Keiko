#ifndef KEIKO_RUNTIME_PROTOCOL_H
#define KEIKO_RUNTIME_PROTOCOL_H

/* Shared POSIX codec. Keep it in the legacy macOS attested source tree so existing
 * installed candidate validators continue to bind every macOS compiled dependency. */

#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// KEIKO-0967: read_exact and write_exact were duplicated verbatim across
// keiko_runtime_monitor.m and keiko_system_extension_manager.m. Both files already include this
// header; keeping one definition here removes the drift class. `static inline` is the standard
// C shape for header-hosted helpers that must not create multiple external symbols.
static inline int keiko_read_exact(int descriptor, void *buffer, size_t length) {
  unsigned char *bytes = (unsigned char *)buffer;
  size_t offset = 0;
  while (offset < length) {
    ssize_t result = read(descriptor, bytes + offset, length - offset);
    if (result <= 0) return 0;
    offset += (size_t)result;
  }
  return 1;
}

static inline int keiko_write_exact(int descriptor, const void *buffer, size_t length) {
  const unsigned char *bytes = (const unsigned char *)buffer;
  size_t offset = 0;
  while (offset < length) {
    ssize_t result = write(descriptor, bytes + offset, length - offset);
    if (result <= 0) return 0;
    offset += (size_t)result;
  }
  return 1;
}

#if defined(__linux__)
#include <poll.h>
#include <signal.h>
#include <sys/prctl.h>

static inline int keiko_parent_death_is_armed(void) {
  int signal_number = 0;
  return prctl(PR_GET_PDEATHSIG, &signal_number, 0, 0, 0) == 0 && signal_number == SIGKILL;
}

static inline int keiko_bind_parent_death(int owner_handle) {
  struct pollfd held = {owner_handle, POLLIN, 0};
  return owner_handle >= 0 && prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) == 0 &&
         keiko_parent_death_is_armed() && poll(&held, 1, 0) == 0;
}
#endif

// Legacy aliases: the two files historically named the helpers `read_exact` / `write_exact`.
// Keep the names available so unrelated call sites do not have to move in the same change.
#define read_exact keiko_read_exact
#define write_exact keiko_write_exact

#define KRP_VERSION 1u
#define KRP_HEADER_BYTES 12u
#define KRP_MAX_PACKET (128u * 1024u)
#define KRP_MAX_ARGUMENTS 64u
#define KRP_MAX_ENVIRONMENT 64u
#define KRP_RECOVERY_HANDLE_BYTES 32u

enum response_kind { RESPONSE_LAUNCHED = 1, RESPONSE_REAPED = 2, RESPONSE_ERROR = 3 };
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

static inline uint16_t read_u16(const unsigned char *value) {
  return (uint16_t)value[0] | ((uint16_t)value[1] << 8);
}

static inline uint32_t read_u32(const unsigned char *value) {
  return (uint32_t)value[0] | ((uint32_t)value[1] << 8) |
         ((uint32_t)value[2] << 16) | ((uint32_t)value[3] << 24);
}

static inline void write_u16(unsigned char *value, uint16_t number) {
  value[0] = (unsigned char)number;
  value[1] = (unsigned char)(number >> 8);
}

static inline void write_u32(unsigned char *value, uint32_t number) {
  value[0] = (unsigned char)number;
  value[1] = (unsigned char)(number >> 8);
  value[2] = (unsigned char)(number >> 16);
  value[3] = (unsigned char)(number >> 24);
}

static inline int send_response(uint16_t kind, const unsigned char *payload, uint32_t length) {
  unsigned char header[KRP_HEADER_BYTES] = {'K', 'R', 'S', '1', 0, 0, 0, 0, 0, 0, 0, 0};
  write_u16(header + 4, KRP_VERSION);
  write_u16(header + 6, kind);
  write_u32(header + 8, length);
  return write_exact(4, header, sizeof(header)) &&
         (length == 0 || write_exact(4, payload, length));
}

static inline int send_error(uint16_t code) {
  unsigned char payload[2];
  write_u16(payload, (uint16_t)code);
  return send_response(RESPONSE_ERROR, payload, sizeof(payload));
}

static inline int valid_recovery_handle(const char *value) {
  size_t index;
  if (strlen(value) != KRP_RECOVERY_HANDLE_BYTES) return 0;
  for (index = 0; index < KRP_RECOVERY_HANDLE_BYTES; ++index) {
    char byte = value[index];
    if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) return 0;
  }
  return 1;
}

static inline char *take_string(unsigned char **cursor, size_t *remaining) {
  uint32_t length;
  char *value;
  if (*remaining < 4) return NULL;
  length = read_u32(*cursor);
  *cursor += 4;
  *remaining -= 4;
  if (length >= *remaining || memchr(*cursor, 0, length) != NULL || (*cursor)[length] != 0)
    return NULL;
  value = (char *)*cursor;
  *cursor += (size_t)length + 1;
  *remaining -= (size_t)length + 1;
  return value;
}

typedef int (*krp_read_callback)(int, void *, size_t, void *);

static inline int read_launch_request_with_reader(struct launch_request *request,
                                                  krp_read_callback reader, void *context) {
  unsigned char header[KRP_HEADER_BYTES], *cursor;
  uint32_t payload_length;
  size_t remaining, index;
  memset(request, 0, sizeof(*request));
  if (!reader(3, header, sizeof(header), context) || memcmp(header, "KRP1", 4) != 0 ||
      read_u16(header + 4) != KRP_VERSION || read_u16(header + 6) != 1)
    return 0;
  payload_length = read_u32(header + 8);
  if (payload_length < 16 || payload_length > KRP_MAX_PACKET - KRP_HEADER_BYTES) return 0;
  request->storage = calloc((size_t)payload_length + 1, 1);
  if (request->storage == NULL || !reader(3, request->storage, payload_length, context)) return 0;
  request->storage_length = (size_t)payload_length + 1;
  cursor = (unsigned char *)request->storage;
  remaining = payload_length;
  request->argument_count = read_u16(cursor);
  request->environment_count = read_u16(cursor + 2);
  cursor += 4;
  remaining -= 4;
  if (request->argument_count > KRP_MAX_ARGUMENTS ||
      request->environment_count > KRP_MAX_ENVIRONMENT)
    return 0;
  request->arguments = calloc((size_t)request->argument_count + 1, sizeof(char *));
  request->environment_names = calloc((size_t)request->environment_count + 1, sizeof(char *));
  request->environment_values = calloc((size_t)request->environment_count + 1, sizeof(char *));
  if (request->arguments == NULL || request->environment_names == NULL ||
      request->environment_values == NULL)
    return 0;
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
      request->cwd == NULL || !valid_recovery_handle(request->recovery_handle))
    return 0;
  for (index = 0; index < request->argument_count; ++index)
    if (request->arguments[index] == NULL) return 0;
  for (index = 0; index < request->environment_count; ++index)
    if (request->environment_names[index] == NULL || request->environment_values[index] == NULL ||
        strchr(request->environment_names[index], '=') != NULL)
      return 0;
  return 1;
}

static inline int krp_default_reader(int descriptor, void *bytes, size_t length, void *context) {
  (void)context;
  return read_exact(descriptor, bytes, length);
}

static inline int read_launch_request(struct launch_request *request) {
  return read_launch_request_with_reader(request, krp_default_reader, NULL);
}

static inline void clear_request(struct launch_request *request) {
  if (request->storage != NULL) {
    memset(request->storage, 0, request->storage_length);
    free(request->storage);
  }
  free(request->arguments);
  free(request->environment_names);
  free(request->environment_values);
  memset(request, 0, sizeof(*request));
}

static inline char **spawn_arguments(const struct launch_request *request) {
  size_t index;
  char **values = calloc((size_t)request->argument_count + 2, sizeof(char *));
  if (values == NULL) return NULL;
  values[0] = request->executable;
  for (index = 0; index < request->argument_count; ++index) values[index + 1] = request->arguments[index];
  return values;
}

static inline void clear_environment(char **values, uint16_t count);

static inline char **spawn_environment(const struct launch_request *request) {
  size_t index;
  char **values = calloc((size_t)request->environment_count + 1, sizeof(char *));
  if (values == NULL) return NULL;
  for (index = 0; index < request->environment_count; ++index) {
    size_t name = strlen(request->environment_names[index]);
    size_t value = strlen(request->environment_values[index]);
    values[index] = calloc(name + value + 2, 1);
    if (values[index] == NULL) {
      clear_environment(values, (uint16_t)index);
      return NULL;
    }
    memcpy(values[index], request->environment_names[index], name);
    values[index][name] = '=';
    memcpy(values[index] + name + 1, request->environment_values[index], value);
  }
  return values;
}

static inline void clear_environment(char **values, uint16_t count) {
  size_t index;
  if (values == NULL) return;
  for (index = 0; index < count; ++index) {
    if (values[index] != NULL) {
      memset(values[index], 0, strlen(values[index]));
      free(values[index]);
    }
  }
  free(values);
}

#if defined(__linux__)
#include <errno.h>

/* App environment is data on the private control channel, never a native loader environment. */
#define KAE_MAX_ENTRIES 4096u
struct app_environment_packet {
  char *storage;
  size_t storage_length;
  uint16_t count;
  char **values;
};

static inline int read_app_environment(struct app_environment_packet *packet,
                                        krp_read_callback reader, void *context) {
  unsigned char header[12];
  if (!reader(3, header, sizeof(header), context) || memcmp(header, "KAE1", 4) != 0 ||
      read_u16(header + 4) != 1 || read_u16(header + 6) != 1) return 0;
  uint32_t length = read_u32(header + 8);
  if (length < 4 || length > KRP_MAX_PACKET - sizeof(header)) return 0;
  packet->storage = calloc((size_t)length + 1u, 1);
  packet->storage_length = (size_t)length + 1u;
  if (packet->storage == NULL || !reader(3, packet->storage, length, context)) return 0;
  unsigned char *cursor = (unsigned char *)packet->storage;
  size_t remaining = length - 4u;
  packet->count = read_u16(cursor + 2);
  if (read_u16(cursor) != 0 || packet->count > KAE_MAX_ENTRIES) return 0;
  cursor += 4;
  packet->values = calloc((size_t)packet->count + 1u, sizeof(char *));
  if (packet->values == NULL) return 0;
  for (uint16_t i = 0; i < packet->count; ++i) {
    char *value = take_string(&cursor, &remaining);
    const char *separator = value == NULL ? NULL : strchr(value, '=');
    if (separator == NULL || separator == value || (size_t)(separator - value) > 128u ||
        strlen(separator + 1) > 16u * 1024u) return 0;
    packet->values[i] = value;
  }
  return remaining == 0;
}

static inline void clear_app_environment(struct app_environment_packet *packet) {
  if (packet->storage != NULL) {
    memset(packet->storage, 0, packet->storage_length);
    free(packet->storage);
  }
  free(packet->values);
  memset(packet, 0, sizeof(*packet));
}

static inline int keiko_positive_u64(const char *value, uint64_t maximum, uint64_t *output) {
  if (value == NULL || value[0] < '1' || value[0] > '9') return 0;
  for (const char *byte = value; *byte != '\0'; ++byte)
    if (*byte < '0' || *byte > '9') return 0;
  errno = 0;
  char *end;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || *end != '\0' || parsed > maximum) return 0;
  *output = (uint64_t)parsed;
  return 1;
}

static inline int keiko_app_clip_deadline(uint64_t *deadline, int required) {
  const char *selected = getenv("KEIKO_UI_START_DEADLINE_MS");
  uint64_t absolute;
  if (selected == NULL) return !required;
  if (!keiko_positive_u64(selected, UINT64_MAX, &absolute)) return 0;
  if (absolute < *deadline) *deadline = absolute;
  return 1;
}
#endif

#endif
