#include <assert.h>
#include <string.h>

#include "keiko-portable-sha256.h"

static void assert_digest(const char *input, const char *expected) {
  keiko_sha256 hash;
  unsigned char digest[32];
  char hex[65];
  assert(keiko_sha256_init(&hash));
  assert(keiko_sha256_update(&hash, input, strlen(input)));
  assert(keiko_sha256_final(&hash, digest));
  keiko_sha256_hex(digest, hex);
  assert(strcmp(hex, expected) == 0);
}

int main(void) {
  assert_digest("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert_digest("abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  return 0;
}
