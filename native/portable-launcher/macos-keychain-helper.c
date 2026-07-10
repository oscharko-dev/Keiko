#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failed(OSStatus status) { return status == errSecSuccess ? 0 : 1; }

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

static int setup(void) {
  const char *path = getenv("KEIKO_KEYCHAIN_PATH");
  const char *password = getenv("KEIKO_KEYCHAIN_PASSWORD");
  const char *p12_path = getenv("KEIKO_P12_PATH");
  const char *p12_password = getenv("APPLE_DEVELOPER_ID_CERT_PASSWORD");
  if (!path || !password || !p12_path || !p12_password) return 2;

  SecKeychainRef keychain = NULL;
  OSStatus status = SecKeychainCreate(path, (UInt32)strlen(password), password, false, NULL, &keychain);
  if (failed(status)) return 3;
  SecKeychainSettings settings = { SEC_KEYCHAIN_SETTINGS_VERS1, true, false, 3600 };
  if (failed(SecKeychainSetSettings(keychain, &settings))) goto fail;

  CFDataRef p12 = read_file(p12_path);
  CFStringRef passphrase = CFStringCreateWithCString(NULL, p12_password, kCFStringEncodingUTF8);
  SecTrustedApplicationRef codesign = NULL;
  if (p12 == NULL || passphrase == NULL) {
    status = errSecParam;
    goto fail_data;
  }
  status = SecTrustedApplicationCreateFromPath("/usr/bin/codesign", &codesign);
  if (failed(status)) goto fail_data;
  const void *trusted_values[] = { codesign };
  CFArrayRef trusted = CFArrayCreate(NULL, trusted_values, 1, &kCFTypeArrayCallBacks);
  SecAccessRef access = NULL;
  if (trusted == NULL) {
    status = errSecAllocate;
    goto fail_trusted;
  }
  status = SecAccessCreate(CFSTR("Keiko portable signing"), trusted, &access);
  if (failed(status)) goto fail_trusted;

  SecItemImportExportKeyParameters parameters = { 0 };
  const void *usage_values[] = { kSecAttrCanSign };
  const void *attribute_values[] = { kSecAttrIsPermanent, kSecAttrIsSensitive };
  CFArrayRef key_usage = CFArrayCreate(NULL, usage_values, 1, &kCFTypeArrayCallBacks);
  CFArrayRef key_attributes =
      CFArrayCreate(NULL, attribute_values, 2, &kCFTypeArrayCallBacks);
  if (key_usage == NULL || key_attributes == NULL) {
    status = errSecAllocate;
    goto finish_import;
  }
  parameters.version = SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION;
  parameters.passphrase = passphrase;
  parameters.accessRef = access;
  parameters.keyAttributes = key_attributes;
  parameters.keyUsage = key_usage;
  SecExternalFormat format = kSecFormatPKCS12;
  SecExternalItemType type = kSecItemTypeAggregate;
  CFArrayRef items = NULL;
  status = SecItemImport(p12, NULL, &format, &type, 0, &parameters, keychain, &items);
  CFIndex identity_count = 0;
  if (!failed(status) && items != NULL) {
    for (CFIndex index = 0; index < CFArrayGetCount(items); index++) {
      CFTypeRef item = CFArrayGetValueAtIndex(items, index);
      if (CFGetTypeID(item) == SecIdentityGetTypeID()) identity_count++;
    }
    if (identity_count != 1) status = errSecInvalidItemRef;
  }
  if (items) CFRelease(items);
finish_import:
  if (key_attributes) CFRelease(key_attributes);
  if (key_usage) CFRelease(key_usage);
  CFRelease(access);
fail_trusted:
  if (trusted) CFRelease(trusted);
  if (codesign) CFRelease(codesign);
fail_data:
  if (passphrase) CFRelease(passphrase);
  if (p12) CFRelease(p12);
  if (failed(status)) goto fail;
  CFRelease(keychain);
  return 0;
fail:
  SecKeychainDelete(keychain);
  CFRelease(keychain);
  return 4;
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
