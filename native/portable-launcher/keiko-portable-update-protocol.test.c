#include <assert.h>
#include <stddef.h>
#include <stdint.h>
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
  unsigned char content[KEIKO_KHP_MAX_BYTES];
  keiko_handoff_plan plan;
  size_t length = encode_fields(content, sizeof(content), fields);
  int result = keiko_khp_parse(content, length, &plan);
  if (result) keiko_khp_clear(&plan);
  return result;
}

static void rejects_field(size_t field, const char *value) {
  const char *fields[KEIKO_KHP_FIELD_COUNT];
  memcpy(fields, valid_fields, sizeof(fields));
  fields[field] = value;
  assert(parses(fields) == 0);
}

int main(void) {
  static const char malformed_utf8[] = {(char)0xc0, (char)0xaf, '\0'};
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
  rejects_field(KEIKO_KHP_SESSION_ID, malformed_utf8);
  rejects_field(KEIKO_KHP_MANAGED_ROOT, INVALID_RELATIVE_PATH);
  rejects_field(KEIKO_KHP_MANAGED_ROOT, INVALID_DOT_PATH);
  rejects_field(KEIKO_KHP_CANDIDATE_ROOT, FOREIGN_CANDIDATE);

  /* Parsing establishes syntax only. Product code must separately authorize every
   * root, digest, process identity, registration snapshot, and runtime capability. */
  return 0;
}
