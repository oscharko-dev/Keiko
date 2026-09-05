#ifndef KEIKO_PORTABLE_UPDATE_PROTOCOL_H
#define KEIKO_PORTABLE_UPDATE_PROTOCOL_H

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  KEIKO_KHP_VERSION = 2,
  KEIKO_KHP_FIELD_COUNT = 32,
  KEIKO_KHP_MAX_BYTES = 64 * 1024,
  KEIKO_KHP_MAX_PATH_BYTES = 32 * 1024,
  KEIKO_KHP_ACTIVATION_ID = 0,
  KEIKO_KHP_SESSION_ID = 1,
  KEIKO_KHP_STAGE_ID = 2,
  KEIKO_KHP_TARGET = 3,
  KEIKO_KHP_TARGET_VERSION = 4,
  KEIKO_KHP_NEW_LAUNCH_ID = 5,
  KEIKO_KHP_RESTORE_LAUNCH_ID = 6,
  KEIKO_KHP_AGGREGATE_REVISION = 7,
  KEIKO_KHP_PREVIOUS_REGISTRATION_STATE = 8,
  KEIKO_KHP_OLD_PID = 9,
  KEIKO_KHP_OLD_LAUNCH_ID = 10,
  KEIKO_KHP_OLD_HOST = 11,
  KEIKO_KHP_OLD_PORT = 12,
  KEIKO_KHP_OLD_VERSION = 13,
  KEIKO_KHP_MANAGED_ROOT = 14,
  KEIKO_KHP_STAGE_ROOT = 15,
  KEIKO_KHP_CANDIDATE_ROOT = 16,
  KEIKO_KHP_BACKUP_ROOT = 17,
  KEIKO_KHP_CANDIDATE_LAUNCHER = 18,
  KEIKO_KHP_CANDIDATE_SUPERVISOR = 19,
  KEIKO_KHP_CURRENT_TREE_SHA256 = 20,
  KEIKO_KHP_CANDIDATE_TREE_SHA256 = 21,
  KEIKO_KHP_CURRENT_LAUNCHER_SHA256 = 22,
  KEIKO_KHP_CURRENT_SUPERVISOR_SHA256 = 23,
  KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256 = 24,
  KEIKO_KHP_CANDIDATE_SUPERVISOR_SHA256 = 25,
  KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256 = 26,
  KEIKO_KHP_PREPARED_REGISTRATION_SHA256 = 27,
  KEIKO_KHP_OLD_EXIT_AT = 28,
  KEIKO_KHP_START_AT = 29,
  KEIKO_KHP_VERIFY_AT = 30,
  KEIKO_KHP_CLEANUP_AT = 31
};

typedef struct {
  char *field[KEIKO_KHP_FIELD_COUNT];
} keiko_handoff_plan;

static uint16_t keiko_khp_read_u16(const unsigned char *value) {
  return (uint16_t)((uint16_t)value[0] | (uint16_t)((uint16_t)value[1] << 8));
}

static uint32_t keiko_khp_read_u32(const unsigned char *value) {
  return (uint32_t)value[0] | ((uint32_t)value[1] << 8) |
         ((uint32_t)value[2] << 16) | ((uint32_t)value[3] << 24);
}

static int keiko_khp_is_lower_hex(const char *value, size_t length) {
  size_t index;
  if (strlen(value) != length) return 0;
  for (index = 0; index < length; ++index) {
    char byte = value[index];
    if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) return 0;
  }
  return 1;
}

static int keiko_khp_is_bounded_id(const char *value) {
  size_t index, length = strlen(value);
  if (length < 1 || length > 128) return 0;
  for (index = 0; index < length; ++index) {
    char byte = value[index];
    if (!((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') ||
          (byte >= '0' && byte <= '9') || byte == '.' || byte == '_' || byte == ':' ||
          byte == '-')) return 0;
  }
  return ((value[0] >= 'A' && value[0] <= 'Z') ||
          (value[0] >= 'a' && value[0] <= 'z') ||
          (value[0] >= '0' && value[0] <= '9'));
}

static int keiko_khp_is_decimal(const char *value) {
  size_t index, length = strlen(value);
  if (length < 1 || length > 16) return 0;
  if (length > 1 && value[0] == '0') return 0;
  for (index = 0; index < length; ++index)
    if (value[index] < '0' || value[index] > '9') return 0;
  return 1;
}

static int keiko_khp_decimal_value(const char *value, uint64_t maximum,
                                   uint64_t *result) {
  uint64_t parsed = 0;
  size_t index;
  if (!keiko_khp_is_decimal(value)) return 0;
  for (index = 0; value[index] != '\0'; ++index) {
    uint64_t digit = (uint64_t)(value[index] - '0');
    if (parsed > (maximum - digit) / 10u) return 0;
    parsed = parsed * 10u + digit;
  }
  *result = parsed;
  return 1;
}

static int keiko_khp_is_version(const char *value) {
  size_t index, length = strlen(value);
  if (length < 1 || length > 64) return 0;
  for (index = 0; index < length; ++index) {
    char byte = value[index];
    if (!((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') ||
          (byte >= '0' && byte <= '9') || byte == '.' || byte == '+' || byte == '-'))
      return 0;
  }
  return ((value[0] >= 'A' && value[0] <= 'Z') ||
          (value[0] >= 'a' && value[0] <= 'z') ||
          (value[0] >= '0' && value[0] <= '9'));
}

static int keiko_khp_is_utf8(const unsigned char *value, size_t length) {
  size_t index = 0;
  while (index < length) {
    unsigned char first = value[index++];
    if (first <= 0x7f) continue;
    if (first >= 0xc2 && first <= 0xdf) {
      if (index >= length || (value[index++] & 0xc0) != 0x80) return 0;
      continue;
    }
    if (first >= 0xe0 && first <= 0xef) {
      unsigned char second;
      if (index + 1 >= length) return 0;
      second = value[index++];
      if ((second & 0xc0) != 0x80 || (value[index++] & 0xc0) != 0x80 ||
          (first == 0xe0 && second < 0xa0) || (first == 0xed && second >= 0xa0))
        return 0;
      continue;
    }
    if (first >= 0xf0 && first <= 0xf4) {
      unsigned char second;
      if (index + 2 >= length) return 0;
      second = value[index++];
      if ((second & 0xc0) != 0x80 || (value[index++] & 0xc0) != 0x80 ||
          (value[index++] & 0xc0) != 0x80 ||
          (first == 0xf0 && second < 0x90) || (first == 0xf4 && second >= 0x90))
        return 0;
      continue;
    }
    return 0;
  }
  return 1;
}

static int keiko_khp_is_absolute_canonical_path(const char *value) {
  size_t index, length = strlen(value), segment_start;
  if (length < 1 || length > KEIKO_KHP_MAX_PATH_BYTES) return 0;
#if defined(_WIN32)
  if (length < 3 ||
      !(((value[0] >= 'A' && value[0] <= 'Z') ||
         (value[0] >= 'a' && value[0] <= 'z')) &&
        value[1] == ':' && value[2] == '\\'))
    return 0;
  segment_start = 3;
  for (index = 3; index <= length; ++index) {
    char byte = value[index];
    if (byte == '/' || (byte == ':' && index > 1)) return 0;
    if (byte == '\\' || byte == '\0') {
      size_t segment_length = index - segment_start;
      if ((segment_length == 0 && index != length) ||
          (segment_length == 1 && value[segment_start] == '.') ||
          (segment_length == 2 && value[segment_start] == '.' &&
           value[segment_start + 1] == '.'))
        return 0;
      segment_start = index + 1;
    }
  }
  return length == 3 || value[length - 1] != '\\';
#else
  if (value[0] != '/') return 0;
  segment_start = 1;
  for (index = 1; index <= length; ++index) {
    char byte = value[index];
    if (byte == '\\') return 0;
    if (byte == '/' || byte == '\0') {
      size_t segment_length = index - segment_start;
      if ((segment_length == 0 && index != length) ||
          (segment_length == 1 && value[segment_start] == '.') ||
          (segment_length == 2 && value[segment_start] == '.' &&
           value[segment_start + 1] == '.'))
        return 0;
      segment_start = index + 1;
    }
  }
  return length == 1 || value[length - 1] != '/';
#endif
}

static int keiko_khp_parent_path(const char *path, char *output, size_t capacity) {
  const char *last;
  size_t length;
#if defined(_WIN32)
  last = strrchr(path, '\\');
#else
  last = strrchr(path, '/');
#endif
  if (last == NULL) return 0;
  length = (size_t)(last - path);
#if !defined(_WIN32)
  if (length == 0) length = 1;
#endif
  if (length + 1 > capacity) return 0;
  memcpy(output, path, length);
  output[length] = '\0';
  return 1;
}

static int keiko_khp_path_is_contained(const char *root, const char *path) {
  size_t root_length = strlen(root);
  if (strncmp(root, path, root_length) != 0) return 0;
  if (path[root_length] == '\0') return 1;
#if defined(_WIN32)
  return path[root_length] == '\\';
#else
  return path[root_length] == '/';
#endif
}

/* The capsule authorizes one fixed sibling transaction only. Syntax-valid absolute
 * paths are not authority: stage and backup must derive byte-for-byte from the
 * freshly attested managed root, activation and stage identifiers. */
static int keiko_khp_topology_valid(const keiko_handoff_plan *plan) {
  const char *managed = plan->field[KEIKO_KHP_MANAGED_ROOT];
  const char *stage = plan->field[KEIKO_KHP_STAGE_ROOT];
  const char *candidate = plan->field[KEIKO_KHP_CANDIDATE_ROOT];
  const char *backup = plan->field[KEIKO_KHP_BACKUP_ROOT];
  char parent[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char expected_stage[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char expected_backup[KEIKO_KHP_MAX_PATH_BYTES + 1];
  int stage_length, backup_length;
  if (!keiko_khp_parent_path(managed, parent, sizeof(parent))) return 0;
#if defined(_WIN32)
  stage_length = snprintf(expected_stage, sizeof(expected_stage), "%s\\.keiko-portable-updates\\%s",
                          parent, plan->field[KEIKO_KHP_STAGE_ID]);
  backup_length = snprintf(expected_backup, sizeof(expected_backup), "%s\\.keiko-previous-%s",
                           parent, plan->field[KEIKO_KHP_ACTIVATION_ID]);
#else
  stage_length = snprintf(expected_stage, sizeof(expected_stage), "%s/.keiko-portable-updates/%s",
                          parent, plan->field[KEIKO_KHP_STAGE_ID]);
  backup_length = snprintf(expected_backup, sizeof(expected_backup), "%s/.keiko-previous-%s",
                           parent, plan->field[KEIKO_KHP_ACTIVATION_ID]);
#endif
  if (stage_length <= 0 || (size_t)stage_length >= sizeof(expected_stage) ||
      backup_length <= 0 || (size_t)backup_length >= sizeof(expected_backup)) return 0;
  return strcmp(stage, expected_stage) == 0 && strcmp(backup, expected_backup) == 0 &&
         strcmp(candidate, stage) != 0 && keiko_khp_path_is_contained(stage, candidate) &&
         keiko_khp_path_is_contained(candidate, plan->field[KEIKO_KHP_CANDIDATE_LAUNCHER]) &&
         keiko_khp_path_is_contained(candidate, plan->field[KEIKO_KHP_CANDIDATE_SUPERVISOR]);
}

static void keiko_khp_clear(keiko_handoff_plan *plan) {
  size_t index;
  for (index = 0; index < KEIKO_KHP_FIELD_COUNT; ++index) {
    if (plan->field[index] != NULL) {
      memset(plan->field[index], 0, strlen(plan->field[index]));
      free(plan->field[index]);
      plan->field[index] = NULL;
    }
  }
}

static int keiko_khp_fields_valid(const keiko_handoff_plan *plan) {
  size_t index;
  uint64_t revision, old_pid, old_port, deadline[4];
  if (!keiko_khp_is_lower_hex(plan->field[KEIKO_KHP_ACTIVATION_ID], 32) ||
      !keiko_khp_is_bounded_id(plan->field[KEIKO_KHP_SESSION_ID]) ||
      !keiko_khp_is_bounded_id(plan->field[KEIKO_KHP_STAGE_ID]) ||
      strcmp(plan->field[KEIKO_KHP_TARGET], KEIKO_PORTABLE_TARGET) != 0 ||
      !keiko_khp_is_version(plan->field[KEIKO_KHP_TARGET_VERSION]) ||
      !keiko_khp_is_bounded_id(plan->field[KEIKO_KHP_NEW_LAUNCH_ID]) ||
      !keiko_khp_is_bounded_id(plan->field[KEIKO_KHP_RESTORE_LAUNCH_ID]) ||
      strcmp(plan->field[KEIKO_KHP_RESTORE_LAUNCH_ID],
             plan->field[KEIKO_KHP_NEW_LAUNCH_ID]) == 0 ||
      strcmp(plan->field[KEIKO_KHP_RESTORE_LAUNCH_ID],
             plan->field[KEIKO_KHP_OLD_LAUNCH_ID]) == 0 ||
      !keiko_khp_decimal_value(plan->field[KEIKO_KHP_AGGREGATE_REVISION],
                               UINT64_C(9007199254740991), &revision) ||
      revision < 1 ||
      (strcmp(plan->field[KEIKO_KHP_PREVIOUS_REGISTRATION_STATE], "present") != 0 &&
       strcmp(plan->field[KEIKO_KHP_PREVIOUS_REGISTRATION_STATE], "absent") != 0) ||
      !keiko_khp_decimal_value(plan->field[KEIKO_KHP_OLD_PID], INT32_MAX, &old_pid) ||
      old_pid < 1 ||
      !keiko_khp_is_bounded_id(plan->field[KEIKO_KHP_OLD_LAUNCH_ID]) ||
      strcmp(plan->field[KEIKO_KHP_OLD_HOST], "127.0.0.1") != 0 ||
      !keiko_khp_decimal_value(plan->field[KEIKO_KHP_OLD_PORT], 65535, &old_port) ||
      old_port < 1 || !keiko_khp_is_version(plan->field[KEIKO_KHP_OLD_VERSION]))
    return 0;
  for (index = KEIKO_KHP_MANAGED_ROOT;
       index <= KEIKO_KHP_CANDIDATE_SUPERVISOR; ++index)
    if (!keiko_khp_is_absolute_canonical_path(plan->field[index])) return 0;
  for (index = KEIKO_KHP_CURRENT_TREE_SHA256;
       index <= KEIKO_KHP_PREPARED_REGISTRATION_SHA256; ++index)
    if (!keiko_khp_is_lower_hex(plan->field[index], 64)) return 0;
  for (index = 0; index < 4; ++index)
    if (!keiko_khp_decimal_value(plan->field[KEIKO_KHP_OLD_EXIT_AT + index],
                                 UINT64_C(9007199254740991), &deadline[index]) ||
        deadline[index] < 1)
      return 0;
  if (!(deadline[0] < deadline[1] && deadline[1] < deadline[2] &&
        deadline[2] < deadline[3]))
    return 0;
  return keiko_khp_topology_valid(plan);
}

static int keiko_khp_parse(const unsigned char *content, size_t length,
                           keiko_handoff_plan *plan) {
  size_t index, offset = 8;
  memset(plan, 0, sizeof(*plan));
  if (length < 8 || length > KEIKO_KHP_MAX_BYTES || memcmp(content, "KHP1", 4) != 0 ||
      keiko_khp_read_u16(content + 4) != KEIKO_KHP_VERSION ||
      keiko_khp_read_u16(content + 6) != KEIKO_KHP_FIELD_COUNT) return 0;
  for (index = 0; index < KEIKO_KHP_FIELD_COUNT; ++index) {
    uint32_t field_length;
    if (offset > length || length - offset < 4) goto invalid;
    field_length = keiko_khp_read_u32(content + offset);
    offset += 4;
    if (field_length == 0 || field_length > KEIKO_KHP_MAX_BYTES ||
        offset > length || length - offset < field_length ||
        memchr(content + offset, 0, field_length) != NULL ||
        !keiko_khp_is_utf8(content + offset, field_length)) goto invalid;
    plan->field[index] = calloc((size_t)field_length + 1, 1);
    if (plan->field[index] == NULL) goto invalid;
    memcpy(plan->field[index], content + offset, field_length);
    offset += field_length;
  }
  if (offset != length || !keiko_khp_fields_valid(plan)) goto invalid;
  return 1;
invalid:
  keiko_khp_clear(plan);
  return 0;
}

#endif
