#ifndef KEIKO_PORTABLE_SHA256_H
#define KEIKO_PORTABLE_SHA256_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#if defined(_WIN32)

#define WIN32_LEAN_AND_MEAN
#include <bcrypt.h>
#include <windows.h>

#if defined(_MSC_VER)
#pragma comment(lib, "bcrypt.lib")
#endif

typedef struct {
  BCRYPT_ALG_HANDLE algorithm;
  BCRYPT_HASH_HANDLE hash;
  unsigned char *object;
  ULONG object_length;
} keiko_sha256;

static void keiko_sha256_clear(keiko_sha256 *context) {
  if (context->hash != NULL) BCryptDestroyHash(context->hash);
  if (context->object != NULL) {
    SecureZeroMemory(context->object, context->object_length);
    HeapFree(GetProcessHeap(), 0, context->object);
  }
  if (context->algorithm != NULL) BCryptCloseAlgorithmProvider(context->algorithm, 0);
  memset(context, 0, sizeof(*context));
}

static int keiko_sha256_init(keiko_sha256 *context) {
  ULONG result_length = 0;
  memset(context, 0, sizeof(*context));
  if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(
          &context->algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0)) ||
      !BCRYPT_SUCCESS(BCryptGetProperty(
          context->algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR)&context->object_length,
          sizeof(context->object_length), &result_length, 0)) ||
      result_length != sizeof(context->object_length) || context->object_length == 0) {
    keiko_sha256_clear(context);
    return 0;
  }
  context->object = (unsigned char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                                               context->object_length);
  if (context->object == NULL ||
      !BCRYPT_SUCCESS(BCryptCreateHash(context->algorithm, &context->hash, context->object,
                                       context->object_length, NULL, 0, 0))) {
    keiko_sha256_clear(context);
    return 0;
  }
  return 1;
}

static int keiko_sha256_update(keiko_sha256 *context, const void *input, size_t length) {
  const unsigned char *bytes = (const unsigned char *)input;
  while (length > 0) {
    ULONG chunk = length > ULONG_MAX ? ULONG_MAX : (ULONG)length;
    if (!BCRYPT_SUCCESS(BCryptHashData(context->hash, (PUCHAR)bytes, chunk, 0))) return 0;
    bytes += chunk;
    length -= chunk;
  }
  return 1;
}

static int keiko_sha256_final(keiko_sha256 *context, unsigned char output[32]) {
  int result = BCRYPT_SUCCESS(BCryptFinishHash(context->hash, output, 32, 0));
  keiko_sha256_clear(context);
  return result;
}

#else

#include <CommonCrypto/CommonDigest.h>

typedef struct {
  CC_SHA256_CTX value;
  int active;
} keiko_sha256;

static void keiko_sha256_clear(keiko_sha256 *context) {
  memset(context, 0, sizeof(*context));
}

static int keiko_sha256_init(keiko_sha256 *context) {
  memset(context, 0, sizeof(*context));
  context->active = CC_SHA256_Init(&context->value) == 1;
  return context->active;
}

static int keiko_sha256_update(keiko_sha256 *context, const void *input, size_t length) {
  const unsigned char *bytes = (const unsigned char *)input;
  while (length > 0) {
    CC_LONG chunk = length > UINT32_MAX ? UINT32_MAX : (CC_LONG)length;
    if (!context->active || CC_SHA256_Update(&context->value, bytes, chunk) != 1) return 0;
    bytes += chunk;
    length -= chunk;
  }
  return 1;
}

static int keiko_sha256_final(keiko_sha256 *context, unsigned char output[32]) {
  int result = context->active && CC_SHA256_Final(output, &context->value) == 1;
  keiko_sha256_clear(context);
  return result;
}

#endif

static void keiko_sha256_hex(const unsigned char digest[32], char output[65]) {
  static const char hex[] = "0123456789abcdef";
  size_t index;
  for (index = 0; index < 32; ++index) {
    output[index * 2] = hex[digest[index] >> 4];
    output[index * 2 + 1] = hex[digest[index] & 15];
  }
  output[64] = '\0';
}

#endif
