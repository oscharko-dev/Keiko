#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef KEIKO_PORTABLE_TARGET
#error "KEIKO_PORTABLE_TARGET must be defined by the native quality build"
#endif

#include "keiko-portable-update-protocol.h"

#if defined(_WIN32)
#define ROOT_PATH "C:\\Keiko"
#define STAGE_PATH "C:\\.keiko-portable-updates\\stage-1"
#define CANDIDATE_PATH "C:\\.keiko-portable-updates\\stage-1\\Keiko"
#define BACKUP_PATH "C:\\.keiko-previous-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
#define LAUNCHER_PATH "C:\\.keiko-portable-updates\\stage-1\\Keiko\\Keiko.exe"
#define SUPERVISOR_PATH \
  "C:\\.keiko-portable-updates\\stage-1\\Keiko\\runtime\\native\\keiko-runtime-supervisor.exe"
#define INVALID_RELATIVE_PATH "Keiko"
#define INVALID_DOT_PATH "C:\\Keiko\\..\\foreign"
#define FOREIGN_CANDIDATE "C:\\foreign\\Keiko"
#else
#define ROOT_PATH "/Applications/Keiko.app"
#define STAGE_PATH "/Applications/.keiko-portable-updates/stage-1"
#define CANDIDATE_PATH "/Applications/.keiko-portable-updates/stage-1/Keiko/Keiko.app"
#define BACKUP_PATH "/Applications/.keiko-previous-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
#define LAUNCHER_PATH \
  "/Applications/.keiko-portable-updates/stage-1/Keiko/Keiko.app/Contents/MacOS/Keiko"
#define SUPERVISOR_PATH                                                        \
  "/Applications/.keiko-portable-updates/stage-1/Keiko/Keiko.app/Contents/" \
  "Resources/runtime/native/keiko-runtime-supervisor"
#define INVALID_RELATIVE_PATH "Applications/Keiko.app"
#define INVALID_DOT_PATH "/Applications/../foreign"
#define FOREIGN_CANDIDATE "/tmp/foreign/Keiko.app"
#endif

static const char *valid_fields[KEIKO_KHP_FIELD_COUNT] = {
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "session-1",
  "stage-1",
  KEIKO_PORTABLE_TARGET,
  "1.2.3",
  "22222222222222222222222222222222",
  "55555555555555555555555555555555",
  "7",
  "present",
  "123",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "127.0.0.1",
  "1983",
  "1.2.2",
  ROOT_PATH,
  STAGE_PATH,
  CANDIDATE_PATH,
  BACKUP_PATH,
  LAUNCHER_PATH,
  SUPERVISOR_PATH,
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "3333333333333333333333333333333333333333333333333333333333333333",
  "4444444444444444444444444444444444444444444444444444444444444444",
  "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "1111111111111111111111111111111111111111111111111111111111111111",
  "1800000000000",
  "1800000030000",
  "1800000060000",
  "1800000090000"
#if defined(_WIN32)
  ,
  "windows-generation-v1",
  "6666666666666666666666666666666666666666666666666666666666666666",
  "7777777777777777777777777777777777777777777777777777777777777777",
  "8888888888888888888888888888888888888888888888888888888888888888",
  "9999999999999999999999999999999999999999999999999999999999999999"
#endif
};

static void write_u16(unsigned char *out, uint16_t value) {
  out[0] = (unsigned char)(value & 0xffu);
  out[1] = (unsigned char)((value >> 8) & 0xffu);
}

static void write_u32(unsigned char *out, uint32_t value) {
  out[0] = (unsigned char)(value & 0xffu);
  out[1] = (unsigned char)((value >> 8) & 0xffu);
  out[2] = (unsigned char)((value >> 16) & 0xffu);
  out[3] = (unsigned char)((value >> 24) & 0xffu);
}

static size_t encode_fields(unsigned char *out, size_t capacity,
                            const char *const *fields) {
  size_t index, offset = 8;
  assert(capacity >= 8);
  memcpy(out, "KHP1", 4);
  write_u16(out + 4, KEIKO_KHP_VERSION);
  write_u16(out + 6, KEIKO_KHP_FIELD_COUNT);
  for (index = 0; index < KEIKO_KHP_FIELD_COUNT; ++index) {
    size_t length = strlen(fields[index]);
    assert(length <= UINT32_MAX);
    assert(offset + 4 + length <= capacity);
    write_u32(out + offset, (uint32_t)length);
    offset += 4;
    memcpy(out + offset, fields[index], length);
    offset += length;
  }
  return offset;
}

static int parses(const char *const *fields) {
  unsigned char *content = (unsigned char *)malloc(KEIKO_KHP_MAX_BYTES);
  keiko_handoff_plan plan;
  size_t length;
  int result;
  if (content == NULL) return 0;
  length = encode_fields(content, KEIKO_KHP_MAX_BYTES, fields);
  result = keiko_khp_parse(content, length, &plan);
  if (result) keiko_khp_clear(&plan);
  memset(content, 0, KEIKO_KHP_MAX_BYTES);
  free(content);
  return result;
}

static void rejects_field(size_t field, const char *value) {
  const char *fields[KEIKO_KHP_FIELD_COUNT];
  size_t index;
  for (index = 0; index < KEIKO_KHP_FIELD_COUNT; ++index) {
    fields[index] = valid_fields[index];
  }
  fields[field] = value;
  assert(parses(fields) == 0);
}

static int hex_nibble(int byte) {
  if (byte >= '0' && byte <= '9') return byte - '0';
  if (byte >= 'a' && byte <= 'f') return byte - 'a' + 10;
  return -1;
}

static void fixture_path(char *output, size_t capacity) {
  const char *source = __FILE__;
#if defined(_WIN32)
  const char *fixture_name = "khp-v3-windows.hex";
#else
  const char *fixture_name = "khp-v2-macos.hex";
#endif
  const char *slash = strrchr(source, '/');
  const char *backslash = strrchr(source, '\\');
  const char *separator = slash;
  size_t directory_length;
  int written;
  if (separator == NULL || (backslash != NULL && backslash > separator)) separator = backslash;
  assert(separator != NULL);
  directory_length = (size_t)(separator - source);
  written = snprintf(
      output,
      capacity,
      "%.*s/fixtures/%s",
      (int)directory_length,
      source,
      fixture_name
  );
  assert(written > 0 && (size_t)written < capacity);
}

static void parses_canonical_fixture(void) {
  char path[4096];
  unsigned char *decoded = (unsigned char *)malloc(KEIKO_KHP_MAX_BYTES);
  FILE *fixture = NULL;
  size_t length = 0;
  int high = -1;
  int byte;
  keiko_handoff_plan plan;
  assert(decoded != NULL);
  fixture_path(path, sizeof(path));
#if defined(_MSC_VER)
  assert(fopen_s(&fixture, path, "rb") == 0);
#else
  fixture = fopen(path, "rb");
#endif
  assert(fixture != NULL);
  while ((byte = fgetc(fixture)) != EOF) {
    int nibble;
    if (byte == '\n' || byte == '\r') continue;
    nibble = hex_nibble(byte);
    assert(nibble >= 0);
    if (high < 0) {
      high = nibble;
    } else {
      assert(length < KEIKO_KHP_MAX_BYTES);
      decoded[length++] = (unsigned char)((high << 4) | nibble);
      high = -1;
    }
  }
  assert(fclose(fixture) == 0);
  assert(high < 0);
  assert(keiko_khp_parse(decoded, length, &plan) == 1);
  assert(plan.version == KEIKO_KHP_VERSION);
  assert(plan.field_count == KEIKO_KHP_FIELD_COUNT);
#if defined(_WIN32)
  assert(strcmp(plan.field[KEIKO_KHP_CUTOVER_KIND], "windows-generation-v1") == 0);
  assert(strcmp(
             plan.field[KEIKO_KHP_CANDIDATE_GENERATION_TREE_SHA256],
             "7777777777777777777777777777777777777777777777777777777777777777"
         ) == 0);
#endif
  keiko_khp_clear(&plan);
  memset(decoded, 0, KEIKO_KHP_MAX_BYTES);
  free(decoded);
}

static void rejects_cross_target_headers(void) {
  unsigned char *content = (unsigned char *)malloc(KEIKO_KHP_MAX_BYTES);
  keiko_handoff_plan plan;
  size_t length;
  assert(content != NULL);
  length = encode_fields(content, KEIKO_KHP_MAX_BYTES, valid_fields);
  write_u16(content + 4, KEIKO_KHP_VERSION);
  write_u16(
      content + 6,
      KEIKO_KHP_FIELD_COUNT == KEIKO_KHP_MAC_FIELD_COUNT
          ? KEIKO_KHP_WINDOWS_FIELD_COUNT
          : KEIKO_KHP_MAC_FIELD_COUNT
  );
  assert(keiko_khp_parse(content, length, &plan) == 0);
  write_u16(
      content + 4,
      KEIKO_KHP_VERSION == KEIKO_KHP_MAC_VERSION
          ? KEIKO_KHP_WINDOWS_VERSION
          : KEIKO_KHP_MAC_VERSION
  );
  write_u16(content + 6, KEIKO_KHP_FIELD_COUNT);
  assert(keiko_khp_parse(content, length, &plan) == 0);
  memset(content, 0, KEIKO_KHP_MAX_BYTES);
  free(content);
}

int main(void) {
  static const unsigned char malformed_utf8[] = {0xc0u, 0xafu, 0u};
  assert(parses(valid_fields) == 1);

  rejects_field(KEIKO_KHP_AGGREGATE_REVISION, "0");
  rejects_field(KEIKO_KHP_AGGREGATE_REVISION, "07");
  rejects_field(KEIKO_KHP_AGGREGATE_REVISION, "9007199254740992");
  rejects_field(KEIKO_KHP_OLD_PID, "0");
  rejects_field(KEIKO_KHP_OLD_PID, "2147483648");
  rejects_field(KEIKO_KHP_OLD_PORT, "0");
  rejects_field(KEIKO_KHP_OLD_PORT, "065535");
  rejects_field(KEIKO_KHP_OLD_PORT, "65536");
  rejects_field(KEIKO_KHP_CLEANUP_AT, "9999999999999999");
  rejects_field(KEIKO_KHP_START_AT, "1800000000000");
  rejects_field(KEIKO_KHP_SESSION_ID, (const char *)malformed_utf8);
  rejects_field(KEIKO_KHP_MANAGED_ROOT, INVALID_RELATIVE_PATH);
  rejects_field(KEIKO_KHP_MANAGED_ROOT, INVALID_DOT_PATH);
  rejects_field(KEIKO_KHP_CANDIDATE_ROOT, FOREIGN_CANDIDATE);
#if defined(_WIN32)
  rejects_field(KEIKO_KHP_CUTOVER_KIND, "windows-generation-v2");
  rejects_field(KEIKO_KHP_CURRENT_GENERATION_TREE_SHA256, "-");
  rejects_field(KEIKO_KHP_CANDIDATE_GENERATION_TREE_SHA256, "A");
  rejects_field(KEIKO_KHP_CURRENT_SETUP_MANIFEST_SHA256, "");
  rejects_field(KEIKO_KHP_CANDIDATE_SETUP_MANIFEST_SHA256, "0");
#endif
  rejects_cross_target_headers();
  parses_canonical_fixture();

  /* Parsing establishes syntax only. Product code must separately authorize every
   * root, digest, process identity, registration snapshot, and runtime capability. */
  return 0;
}
