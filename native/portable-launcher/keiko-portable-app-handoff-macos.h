#ifndef KEIKO_PORTABLE_APP_HANDOFF_MACOS_H
#define KEIKO_PORTABLE_APP_HANDOFF_MACOS_H
#include <mach-o/dyld.h>

static int keiko_macos_handoff_environment(const keiko_runtime_owner *owner, uint64_t deadline) {
  const struct app_environment_packet *packet = owner->application_environment;
  unsigned char header[12] = {'K','A','E','1',1,0,1,0,0,0,0,0};
  if (packet == NULL || packet->storage == NULL || packet->storage_length < 5u) return 0;
  write_u32(header + 8, (uint32_t)(packet->storage_length - 1u));
  return keiko_owner_write(owner->handoff->control, header, sizeof(header), deadline) &&
         keiko_owner_write(owner->handoff->control, packet->storage,
                            packet->storage_length - 1u, deadline);
}

static int keiko_handoff_spawn(keiko_runtime_owner *owner) {
  keiko_app_handoff *handoff = owner->handoff;
  char path[PATH_MAX], self[PATH_MAX], canonical[PATH_MAX], digest[65], source[65];
  char state[PATH_MAX + 32], grant[80];
  uint32_t capacity = sizeof(self);
  int input[2] = {-1, -1}, response[2] = {-1, -1}, proof[2] = {-1, -1};
  int capsule = -1, executable = -1, current = -1, named = -1, initialized = 0, result = 0;
  struct stat opened, before, after, named_file;
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  if (!keiko_app_owner_state_named(owner) ||
      (capsule = keiko_handoff_capsule(owner, handoff->activation)) < 0 ||
      _NSGetExecutablePath(self, &capacity) != 0 || realpath(self, canonical) == NULL ||
      (current = keiko_coordinator_open_hashed_file(canonical, handoff->deadline, source)) < 0 ||
      snprintf(path, sizeof(path), "%s/updates/handoff/%s/coordinator",
                 owner->state_path, handoff->activation) <= 0 || strlen(path) >= sizeof(path) - 1u ||
      (executable = keiko_coordinator_open_hashed_file(path, handoff->deadline, digest)) < 0 ||
      strcmp(source, digest) != 0 || strcmp(digest, handoff->coordinator) != 0 ||
      fstat(executable, &opened) != 0 || opened.st_uid != geteuid() ||
      (opened.st_mode & (S_IWGRP | S_IWOTH)) != 0 ||
      !keiko_owner_private_pipe(input) || !keiko_owner_private_pipe(response) ||
      !keiko_owner_private_pipe(proof) || posix_spawn_file_actions_init(&actions) != 0) goto cleanup;
  initialized = 1;
  if (posix_spawnattr_init(&attributes) != 0) goto cleanup;
  initialized = 2;
  if (posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT) != 0 ||
      posix_spawn_file_actions_adddup2(&actions, input[0], 0) != 0 ||
      posix_spawn_file_actions_adddup2(&actions, response[1], 3) != 0 ||
      posix_spawn_file_actions_adddup2(&actions, proof[0], 7) != 0 ||
      snprintf(state, sizeof(state), "KEIKO_STATE_DIR=%s", owner->state_path) <= 0 ||
      snprintf(grant, sizeof(grant), "KEIKO_APP_HANDOFF_DEADLINE_MS=%llu",
                 (unsigned long long)handoff->deadline) <= 0 ||
      !keiko_app_owner_state_named(owner) || !keiko_tree_before_deadline(handoff->deadline)) goto cleanup;
  char *const arguments[] = {path, (char *)"--coordinate-update", handoff->activation, NULL};
  char *const environment[] = {state, grant, NULL};
  if ((named = keiko_handoff_capsule(owner, handoff->activation)) < 0 ||
      fstat(capsule, &before) != 0 || fstat(named, &after) != 0 ||
      !keiko_coordinator_same_directory(&before, &after) ||
      lstat(path, &named_file) != 0 || !keiko_coordinator_same_file(&opened, &named_file) ||
      named_file.st_uid != geteuid() || (named_file.st_mode & (S_IWGRP | S_IWOTH)) != 0 ||
      !keiko_app_owner_state_named(owner) || !keiko_tree_before_deadline(handoff->deadline) ||
      posix_spawn(&handoff->child, path, &actions, &attributes, arguments, environment) != 0) goto cleanup;
  handoff->control = input[1]; input[1] = -1;
  handoff->response = response[0]; response[0] = -1;
  handoff->proof = proof[1]; proof[1] = -1;
  result = keiko_handoff_envelope(owner, 1, handoff->deadline);
cleanup:
  if (initialized >= 2) posix_spawnattr_destroy(&attributes);
  if (initialized >= 1) posix_spawn_file_actions_destroy(&actions);
  if (capsule >= 0) close(capsule);
  if (executable >= 0) close(executable);
  if (current >= 0) close(current);
  if (named >= 0) close(named);
  for (size_t i = 0; i < 2; ++i) {
    keiko_owner_close(&input[i]); keiko_owner_close(&response[i]); keiko_owner_close(&proof[i]);
  }
  return result;
}
#endif
