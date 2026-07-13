#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failed(OSStatus status) { return status == errSecSuccess ? 0 : 1; }

static OSStatus require_one_identity(SecKeychainRef keychain) {
  SecIdentitySearchRef search = NULL;
  OSStatus status = SecIdentitySearchCreate(keychain, CSSM_KEYUSE_SIGN, &search);
  if (failed(status)) return status;
  CFIndex count = 0;
  SecIdentityRef identity = NULL;
  while ((status = SecIdentitySearchCopyNext(search, &identity)) == errSecSuccess) {
    count++;
    CFRelease(identity);
    identity = NULL;
  }
  CFRelease(search);
  if (status != errSecItemNotFound) return status;
  return count == 1 ? errSecSuccess : errSecInvalidItemRef;
}

static CFDataRef read_file(const char *path) {
  FILE *file = fopen(path, "rb");
  if (file == NULL || fseek(file, 0, SEEK_END) != 0) return NULL;
  long size = ftell(file);
  if (size <= 0 || size > 16 * 1024 * 1024 || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return NULL;
  }
  UInt8 *bytes = malloc((size_t)size);
  if (bytes == NULL || fread(bytes, 1, (size_t)size, file) != (size_t)size) {
    free(bytes);
    fclose(file);
    return NULL;
  }
  fclose(file);
  return CFDataCreateWithBytesNoCopy(NULL, bytes, size, kCFAllocatorMalloc);
}

typedef struct {
  const char *keychain_path;
  const char *keychain_password;
  const char *p12_path;
  const char *p12_password;
} setup_env_t;

/* Reads the four env vars setup() needs. Returns 1 when all are present, 0 otherwise. */
static int read_setup_env(setup_env_t *env) {
  env->keychain_path = getenv("KEIKO_KEYCHAIN_PATH");
  env->keychain_password = getenv("KEIKO_KEYCHAIN_PASSWORD");
  env->p12_path = getenv("KEIKO_P12_PATH");
  env->p12_password = getenv("APPLE_DEVELOPER_ID_CERT_PASSWORD");
  return env->keychain_path && env->keychain_password && env->p12_path && env->p12_password;
}

/* Creates the ephemeral signing keychain and applies its settings. On a settings failure the
   partially-created keychain is deleted before returning, mirroring the original error path. */
static int create_signing_keychain(const char *path, const char *password,
                                    SecKeychainRef *out_keychain) {
  OSStatus status =
      SecKeychainCreate(path, (UInt32)strlen(password), password, false, NULL, out_keychain);
  if (failed(status)) return 3;
  SecKeychainSettings settings = { SEC_KEYCHAIN_SETTINGS_VERS1, true, false, 3600 };
  if (failed(SecKeychainSetSettings(*out_keychain, &settings))) {
    SecKeychainDelete(*out_keychain);
    CFRelease(*out_keychain);
    return 4;
  }
  return 0;
}

typedef struct {
  SecTrustedApplicationRef codesign;
  CFArrayRef trusted;
  SecAccessRef access;
} signing_access_t;

/* Builds the SecAccessRef that scopes the imported identity to codesign. Populates out->access
   only on success; out->codesign / out->trusted are set as far as construction got, for
   release_signing_access to clean up either way. */
static OSStatus build_signing_access(signing_access_t *out) {
  out->codesign = NULL;
  out->trusted = NULL;
  out->access = NULL;
  OSStatus status = SecTrustedApplicationCreateFromPath("/usr/bin/codesign", &out->codesign);
  if (failed(status)) return status;
  const void *trusted_values[] = { out->codesign };
  out->trusted = CFArrayCreate(NULL, trusted_values, 1, &kCFTypeArrayCallBacks);
  if (out->trusted == NULL) return errSecAllocate;
  return SecAccessCreate(CFSTR("Keiko portable signing"), out->trusted, &out->access);
}

/* Releases the codesign trusted-application resources. The access ref itself is owned by the
   caller (its lifetime spans the import, unlike codesign/trusted). */
static void release_signing_access(signing_access_t *access) {
  if (access->trusted) CFRelease(access->trusted);
  if (access->codesign) CFRelease(access->codesign);
}

/* Imports the PKCS#12 blob into keychain under access, then verifies exactly one identity
   resulted. */
static OSStatus import_p12(SecKeychainRef keychain, CFDataRef p12, CFStringRef passphrase,
                            SecAccessRef access) {
  const void *usage_values[] = { kSecAttrCanSign };
  const void *attribute_values[] = { kSecAttrIsPermanent, kSecAttrIsSensitive };
  CFArrayRef key_usage = CFArrayCreate(NULL, usage_values, 1, &kCFTypeArrayCallBacks);
  CFArrayRef key_attributes =
      CFArrayCreate(NULL, attribute_values, 2, &kCFTypeArrayCallBacks);
  OSStatus status;
  if (key_usage == NULL || key_attributes == NULL) {
    status = errSecAllocate;
  } else {
    SecItemImportExportKeyParameters parameters = { 0 };
    parameters.version = SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION;
    parameters.passphrase = passphrase;
    parameters.accessRef = access;
    parameters.keyAttributes = key_attributes;
    parameters.keyUsage = key_usage;
    SecExternalFormat format = kSecFormatPKCS12;
    SecExternalItemType type = kSecItemTypeAggregate;
    CFArrayRef items = NULL;
    status = SecItemImport(p12, NULL, &format, &type, 0, &parameters, keychain, &items);
    if (!failed(status)) status = require_one_identity(keychain);
    if (items) CFRelease(items);
  }
  if (key_attributes) CFRelease(key_attributes);
  if (key_usage) CFRelease(key_usage);
  return status;
}

/* Orchestrates the p12 -> keychain import: loads the file and passphrase, builds the signing
   access, imports, and releases everything it acquired before returning the final status. */
static OSStatus import_identity(SecKeychainRef keychain, const char *p12_path,
                                 const char *p12_password) {
  CFDataRef p12 = read_file(p12_path);
  CFStringRef passphrase = CFStringCreateWithCString(NULL, p12_password, kCFStringEncodingUTF8);
  OSStatus status = errSecParam;
  if (p12 != NULL && passphrase != NULL) {
    signing_access_t access = { NULL, NULL, NULL };
    status = build_signing_access(&access);
    if (!failed(status)) status = import_p12(keychain, p12, passphrase, access.access);
    if (access.access) CFRelease(access.access);
    release_signing_access(&access);
  }
  if (passphrase) CFRelease(passphrase);
  if (p12) CFRelease(p12);
  return status;
}

static int setup(void) {
  setup_env_t env;
  if (!read_setup_env(&env)) return 2;

  SecKeychainRef keychain = NULL;
  int keychain_status =
      create_signing_keychain(env.keychain_path, env.keychain_password, &keychain);
  if (keychain_status != 0) return keychain_status;

  OSStatus status = import_identity(keychain, env.p12_path, env.p12_password);
  if (failed(status)) {
    SecKeychainDelete(keychain);
    CFRelease(keychain);
    return 4;
  }
  CFRelease(keychain);
  return 0;
}

static int cleanup(void) {
  const char *path = getenv("KEIKO_KEYCHAIN_PATH");
  if (!path) return 0;
  SecKeychainRef keychain = NULL;
  OSStatus status = SecKeychainOpen(path, &keychain);
  if (status == errSecNoSuchKeychain) return 0;
  if (failed(status)) return 5;
  status = SecKeychainDelete(keychain);
  CFRelease(keychain);
  return failed(status) ? 6 : 0;
}

int main(int argc, char **argv) {
  if (argc != 2) return 1;
  if (strcmp(argv[1], "setup") == 0) return setup();
  if (strcmp(argv[1], "cleanup") == 0) return cleanup();
  return 1;
}
