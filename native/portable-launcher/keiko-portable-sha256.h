#ifndef KEIKO_PORTABLE_SHA256_H
#define KEIKO_PORTABLE_SHA256_H

#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <bcrypt.h>

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

#elif defined(__APPLE__)

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

#else

/*
 * Neither Windows nor Apple: a self-contained FIPS 180-4 SHA-256. The portable launcher links no
 * libraries by construction - `scripts/check-linux-portable-launcher.sh` compiles it with `cc` and
 * no `-l` flag at all - so a Linux branch cannot reach for libcrypto without adding both a link
 * flag and a runtime dependency to an artifact whose whole point is self-sufficiency.
 *
 * Before this branch existed the `#else` above was unconditional, so Linux compiled the Apple path
 * and died on <CommonCrypto/CommonDigest.h>. `keiko-portable-sha256.test.c` pins the known-answer
 * vectors for "" and "abc", and the Linux quality script now compiles it exactly as macOS and
 * Windows already did.
 */

typedef struct {
  uint32_t state[8];
  uint64_t bits;
  unsigned char buffer[64];
  size_t buffered;
  int active;
} keiko_sha256;

static void keiko_sha256_clear(keiko_sha256 *context) {
  memset(context, 0, sizeof(*context));
}

static uint32_t keiko_sha256_rotr(uint32_t value, unsigned int count) {
  return (value >> count) | (value << (32u - count));
}

static void keiko_sha256_compress(keiko_sha256 *context, const unsigned char block[64]) {
  static const uint32_t round_constants[64] = {
      0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u,
      0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu,
      0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu,
      0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau, 0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
      0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu,
      0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
      0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u, 0x19a4c116u,
      0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
      0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u,
      0xc67178f2u};
  uint32_t schedule[64];
  uint32_t a;
  uint32_t b;
  uint32_t c;
  uint32_t d;
  uint32_t e;
  uint32_t f;
  uint32_t g;
  uint32_t h;
  size_t index;

  for (index = 0; index < 16; ++index) {
    schedule[index] = ((uint32_t)block[index * 4] << 24) | ((uint32_t)block[index * 4 + 1] << 16) |
                      ((uint32_t)block[index * 4 + 2] << 8) | (uint32_t)block[index * 4 + 3];
  }
  for (index = 16; index < 64; ++index) {
    const uint32_t previous = schedule[index - 15];
    const uint32_t recent = schedule[index - 2];
    const uint32_t sigma0 =
        keiko_sha256_rotr(previous, 7) ^ keiko_sha256_rotr(previous, 18) ^ (previous >> 3);
    const uint32_t sigma1 =
        keiko_sha256_rotr(recent, 17) ^ keiko_sha256_rotr(recent, 19) ^ (recent >> 10);
    schedule[index] = schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1;
  }

  a = context->state[0];
  b = context->state[1];
  c = context->state[2];
  d = context->state[3];
  e = context->state[4];
  f = context->state[5];
  g = context->state[6];
  h = context->state[7];

  for (index = 0; index < 64; ++index) {
    const uint32_t sum1 =
        keiko_sha256_rotr(e, 6) ^ keiko_sha256_rotr(e, 11) ^ keiko_sha256_rotr(e, 25);
    const uint32_t choose = (e & f) ^ ((~e) & g);
    const uint32_t temp1 = h + sum1 + choose + round_constants[index] + schedule[index];
    const uint32_t sum0 =
        keiko_sha256_rotr(a, 2) ^ keiko_sha256_rotr(a, 13) ^ keiko_sha256_rotr(a, 22);
    const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temp2 = sum0 + majority;
    h = g;
    g = f;
    f = e;
    e = d + temp1;
    d = c;
    c = b;
    b = a;
    a = temp1 + temp2;
  }

  context->state[0] += a;
  context->state[1] += b;
  context->state[2] += c;
  context->state[3] += d;
  context->state[4] += e;
  context->state[5] += f;
  context->state[6] += g;
  context->state[7] += h;
}

static int keiko_sha256_init(keiko_sha256 *context) {
  memset(context, 0, sizeof(*context));
  context->state[0] = 0x6a09e667u;
  context->state[1] = 0xbb67ae85u;
  context->state[2] = 0x3c6ef372u;
  context->state[3] = 0xa54ff53au;
  context->state[4] = 0x510e527fu;
  context->state[5] = 0x9b05688cu;
  context->state[6] = 0x1f83d9abu;
  context->state[7] = 0x5be0cd19u;
  context->active = 1;
  return context->active;
}

static int keiko_sha256_update(keiko_sha256 *context, const void *input, size_t length) {
  const unsigned char *bytes = (const unsigned char *)input;
  if (!context->active) return 0;
  context->bits += (uint64_t)length * 8u;
  while (length > 0) {
    const size_t room = sizeof(context->buffer) - context->buffered;
    const size_t chunk = length < room ? length : room;
    memcpy(context->buffer + context->buffered, bytes, chunk);
    context->buffered += chunk;
    bytes += chunk;
    length -= chunk;
    if (context->buffered == sizeof(context->buffer)) {
      keiko_sha256_compress(context, context->buffer);
      context->buffered = 0;
    }
  }
  return 1;
}

static int keiko_sha256_final(keiko_sha256 *context, unsigned char output[32]) {
  const uint64_t bits = context->bits;
  size_t index;

  if (!context->active) {
    keiko_sha256_clear(context);
    return 0;
  }

  context->buffer[context->buffered] = 0x80u;
  ++context->buffered;
  if (context->buffered > 56) {
    memset(context->buffer + context->buffered, 0, sizeof(context->buffer) - context->buffered);
    keiko_sha256_compress(context, context->buffer);
    context->buffered = 0;
  }
  memset(context->buffer + context->buffered, 0, 56 - context->buffered);
  for (index = 0; index < 8; ++index) {
    context->buffer[56 + index] = (unsigned char)((bits >> (56u - 8u * (unsigned int)index)) & 0xffu);
  }
  keiko_sha256_compress(context, context->buffer);

  for (index = 0; index < 8; ++index) {
    const uint32_t word = context->state[index];
    output[index * 4] = (unsigned char)((word >> 24) & 0xffu);
    output[index * 4 + 1] = (unsigned char)((word >> 16) & 0xffu);
    output[index * 4 + 2] = (unsigned char)((word >> 8) & 0xffu);
    output[index * 4 + 3] = (unsigned char)(word & 0xffu);
  }

  keiko_sha256_clear(context);
  return 1;
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
