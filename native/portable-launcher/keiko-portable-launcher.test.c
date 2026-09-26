#include <assert.h>
#include <fcntl.h>
#include <stdint.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static unsigned int coordinator_cleanup_kills;
static const char *coordinator_cutover_failure;
static int coordinator_test_kill(pid_t pid, int signal_number) {
  coordinator_cleanup_kills += 1u;
  return kill(pid, signal_number);
}

static int coordinator_test_cutover_checkpoint(const char *checkpoint) {
  return coordinator_cutover_failure == NULL ||
         strcmp(coordinator_cutover_failure, checkpoint) != 0;
}

#define KEIKO_COORDINATOR_KILL coordinator_test_kill
#define KEIKO_COORDINATOR_CUTOVER_CHECKPOINT coordinator_test_cutover_checkpoint
#define main keiko_portable_launcher_product_main
#include "keiko-portable-launcher.c"
#undef main
#undef KEIKO_COORDINATOR_CUTOVER_CHECKPOINT
#undef KEIKO_COORDINATOR_KILL

static const char RECONCILE_OK[] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static const char RECONCILE_LIVE[] = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
static const char RECONCILE_HANG[] = "cccccccccccccccccccccccccccccccc";
static const char RECONCILE_NONZERO_EXIT[] = "dddddddddddddddddddddddddddddddd";
static const char RECONCILE_SIGNALLED_EXIT[] = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

static int write_all(int descriptor, const void *content, size_t length) {
  const unsigned char *bytes = (const unsigned char *)content;
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(descriptor, bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return 1;
}

static int read_all(int descriptor, void *content, size_t length) {
  unsigned char *bytes = (unsigned char *)content;
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(descriptor, bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return 1;
}

static int reconcile_fixture(const char *activation_id) {
  unsigned char response[20] = {'K', 'R', 'S', '1', 1, 0, 2, 0, 8, 0, 0, 0};
  if (strcmp(activation_id, RECONCILE_HANG) == 0) {
    for (;;) pause();
  }
  if (strcmp(activation_id, RECONCILE_LIVE) == 0) response[16] = 1;
  if (!write_all(4, response, sizeof(response))) return 1;
  if (strcmp(activation_id, RECONCILE_NONZERO_EXIT) == 0) return 9;
  if (strcmp(activation_id, RECONCILE_SIGNALLED_EXIT) == 0) {
    raise(SIGTERM);
    return 1;
  }
  return 0;
}

static int supervisor_fixture(void) {
  unsigned char header[12], control[12];
  unsigned char launched[12] = {'K', 'R', 'S', '1', 1, 0, 1, 0, 0, 0, 0, 0};
  unsigned char reaped[20] = {'K', 'R', 'S', '1', 1, 0, 2, 0, 8, 0, 0, 0};
  unsigned char *payload = NULL;
  uint32_t payload_length;
  int result = 1;
  if (fcntl(3, F_GETFD) == -1 || fcntl(4, F_GETFD) == -1 ||
      fcntl(KEIKO_COORDINATOR_START_GATE_FD, F_GETFD) == -1 ||
      !read_all(3, header, sizeof(header)) || memcmp(header, "KRP1", 4u) != 0 ||
      keiko_khp_read_u16(header + 4u) != 1u || keiko_khp_read_u16(header + 6u) != 1u)
    return 1;
  payload_length = keiko_khp_read_u32(header + 8u);
  if (payload_length == 0 || payload_length > KEIKO_COORDINATOR_KRP_MAX_BYTES) return 1;
  payload = (unsigned char *)malloc(payload_length);
  if (payload == NULL || !read_all(3, payload, payload_length) ||
      !write_all(4, launched, sizeof(launched)) || !read_all(3, control, sizeof(control)) ||
      memcmp(control, "KRC1", 4u) != 0 || !write_all(4, reaped, sizeof(reaped)))
    goto cleanup;
  result = 0;
cleanup:
  if (payload != NULL) {
    memset(payload, 0, payload_length);
    free(payload);
  }
  return result;
}

static void copy_executable(const char *source, const char *destination) {
  unsigned char buffer[16 * 1024];
  int input = open(source, O_RDONLY | O_CLOEXEC);
  int output = open(destination, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0700);
  assert(input >= 0);
  assert(output >= 0);
  for (;;) {
    ssize_t count = read(input, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) continue;
    assert(count >= 0);
    if (count == 0) break;
    assert(write_all(output, buffer, (size_t)count) == 1);
  }
  assert(fsync(output) == 0);
  assert(close(output) == 0);
  assert(close(input) == 0);
}

static void write_fixture_file(const char *path, const char *content) {
  int descriptor = open(path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0700);
  assert(descriptor >= 0);
  assert(write_all(descriptor, content, strlen(content)) == 1);
  assert(fsync(descriptor) == 0);
  assert(close(descriptor) == 0);
}

static void replace_fixture_file(const char *path, const char *content) {
  int descriptor = open(path, O_TRUNC | O_WRONLY | O_CLOEXEC);
  assert(descriptor >= 0);
  assert(write_all(descriptor, content, strlen(content)) == 1);
  assert(fsync(descriptor) == 0);
  assert(close(descriptor) == 0);
}

typedef struct {
  char root[PATH_MAX];
  char managed[PATH_MAX];
  char stage[PATH_MAX];
  char candidate[PATH_MAX];
  char backup[PATH_MAX];
  char state[PATH_MAX];
  char registration[PATH_MAX];
  char capsule[PATH_MAX];
  char receipts[PATH_MAX];
  char previous_snapshot[PATH_MAX];
  char next_snapshot[PATH_MAX];
  char old_digest[65];
  char new_digest[65];
  char previous_registration_digest[65];
  char prepared_registration_digest[65];
  keiko_coordinator_context context;
} cutover_fixture;

static uint64_t fixture_deadline(void) {
  return keiko_tree_now_ms() + 5000u;
}

static void assert_tree_digest(const char *path, const char *expected) {
  char actual[65];
  assert(keiko_tree_hash_posix(path, fixture_deadline(), actual) == 1);
  assert(strcmp(actual, expected) == 0);
}

static void assert_path_absent(const char *path) {
  struct stat status;
  errno = 0;
  assert(lstat(path, &status) == -1);
  assert(errno == ENOENT);
}

static void cutover_fixture_init(cutover_fixture *fixture) {
  char managed_payload[PATH_MAX], candidate_payload[PATH_MAX];
  char canonical_root[PATH_MAX];
  memset(fixture, 0, sizeof(*fixture));
  memcpy(fixture->root, "/tmp/keiko-coordinator-cutover.XXXXXX",
         sizeof("/tmp/keiko-coordinator-cutover.XXXXXX"));
  assert(mkdtemp(fixture->root) != NULL);
  assert(realpath(fixture->root, canonical_root) != NULL);
  memcpy(fixture->root, canonical_root, strlen(canonical_root) + 1u);
  assert(join_path(fixture->managed, sizeof(fixture->managed), fixture->root, "/managed") == 1);
  assert(join_path(fixture->stage, sizeof(fixture->stage), fixture->root, "/stage") == 1);
  assert(join_path(fixture->candidate, sizeof(fixture->candidate), fixture->stage,
                   "/candidate") == 1);
  assert(join_path(fixture->backup, sizeof(fixture->backup), fixture->root, "/backup") == 1);
  assert(join_path(fixture->state, sizeof(fixture->state), fixture->root, "/state") == 1);
  assert(join_path(fixture->registration, sizeof(fixture->registration), fixture->state,
                   "/portable-install-state.json") == 1);
  assert(join_path(fixture->capsule, sizeof(fixture->capsule), fixture->root, "/capsule") == 1);
  assert(join_path(fixture->receipts, sizeof(fixture->receipts), fixture->capsule,
                   "/receipts") == 1);
  assert(join_path(fixture->previous_snapshot, sizeof(fixture->previous_snapshot),
                   fixture->capsule, "/registration.previous") == 1);
  assert(join_path(fixture->next_snapshot, sizeof(fixture->next_snapshot), fixture->capsule,
                   "/registration.next") == 1);
  assert(mkdir(fixture->managed, 0700) == 0);
  assert(mkdir(fixture->stage, 0700) == 0);
  assert(mkdir(fixture->candidate, 0700) == 0);
  assert(mkdir(fixture->state, 0700) == 0);
  assert(mkdir(fixture->capsule, 0700) == 0);
  assert(mkdir(fixture->receipts, 0700) == 0);
  assert(join_path(managed_payload, sizeof(managed_payload), fixture->managed, "/payload") == 1);
  assert(join_path(candidate_payload, sizeof(candidate_payload), fixture->candidate, "/payload") ==
         1);
  write_fixture_file(managed_payload, "old attested tree\n");
  write_fixture_file(candidate_payload, "new attested tree\n");
  write_fixture_file(fixture->registration, "previous registration\n");
  write_fixture_file(fixture->previous_snapshot, "previous registration\n");
  write_fixture_file(fixture->next_snapshot, "prepared registration\n");
  assert(keiko_tree_hash_posix(fixture->managed, fixture_deadline(), fixture->old_digest) == 1);
  assert(keiko_tree_hash_posix(fixture->candidate, fixture_deadline(), fixture->new_digest) == 1);
  assert(keiko_coordinator_hash_file(fixture->registration, fixture_deadline(),
                                     fixture->previous_registration_digest) == 1);
  assert(keiko_coordinator_hash_file(fixture->next_snapshot, fixture_deadline(),
                                     fixture->prepared_registration_digest) == 1);
  fixture->context.supervisor_pid = -1;
  fixture->context.supervisor_control = -1;
  fixture->context.supervisor_response = -1;
  fixture->context.start_gate = -1;
  memcpy(fixture->context.state_dir, fixture->state, strlen(fixture->state) + 1u);
  memcpy(fixture->context.capsule, fixture->capsule, strlen(fixture->capsule) + 1u);
  memset(fixture->context.plan_sha256, 'f', 64u);
  fixture->context.plan_sha256[64] = '\0';
  fixture->context.plan.field[KEIKO_KHP_ACTIVATION_ID] =
      (char *)"0123456789abcdef0123456789abcdef";
  fixture->context.plan.field[KEIKO_KHP_MANAGED_ROOT] = fixture->managed;
  fixture->context.plan.field[KEIKO_KHP_STAGE_ROOT] = fixture->stage;
  fixture->context.plan.field[KEIKO_KHP_CANDIDATE_ROOT] = fixture->candidate;
  fixture->context.plan.field[KEIKO_KHP_BACKUP_ROOT] = fixture->backup;
  fixture->context.plan.field[KEIKO_KHP_CURRENT_TREE_SHA256] = fixture->old_digest;
  fixture->context.plan.field[KEIKO_KHP_CANDIDATE_TREE_SHA256] = fixture->new_digest;
  fixture->context.plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256] =
      fixture->previous_registration_digest;
  fixture->context.plan.field[KEIKO_KHP_PREPARED_REGISTRATION_SHA256] =
      fixture->prepared_registration_digest;
}

static void cutover_fixture_clear(cutover_fixture *fixture) {
  struct stat status;
  const char *trees[] = {fixture->managed, fixture->backup, fixture->stage, fixture->capsule,
                         fixture->state};
  size_t index;
  coordinator_cutover_failure = NULL;
  for (index = 0; index < sizeof(trees) / sizeof(trees[0]); ++index) {
    if (lstat(trees[index], &status) == 0) {
      if (S_ISLNK(status.st_mode)) assert(unlink(trees[index]) == 0);
      else assert(keiko_coordinator_remove_tree(trees[index], fixture_deadline()) == 1);
    } else {
      assert(errno == ENOENT);
    }
  }
  assert(rmdir(fixture->root) == 0);
}

static void test_atomic_promote_survives_each_cutover_boundary(void) {
  cutover_fixture fixture;
  cutover_fixture_init(&fixture);

  coordinator_cutover_failure = "promote-before-exchange";
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.old_digest);
  assert_tree_digest(fixture.candidate, fixture.new_digest);
  assert_path_absent(fixture.backup);

  coordinator_cutover_failure = "promote-after-exchange";
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.new_digest);
  assert_tree_digest(fixture.candidate, fixture.old_digest);
  assert_path_absent(fixture.backup);

  coordinator_cutover_failure = "promote-after-relocation";
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.new_digest);
  assert_path_absent(fixture.candidate);
  assert_tree_digest(fixture.backup, fixture.old_digest);

  coordinator_cutover_failure = NULL;
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 1);
  assert_tree_digest(fixture.managed, fixture.new_digest);
  assert_path_absent(fixture.candidate);
  assert_tree_digest(fixture.backup, fixture.old_digest);
  cutover_fixture_clear(&fixture);
}

static void test_atomic_cutover_rejects_untrusted_states(void) {
  cutover_fixture fixture;
  char candidate_payload[PATH_MAX], cross_device_backup[PATH_MAX];
  char foreign[PATH_MAX], link_target[PATH_MAX], real_stage[PATH_MAX];
  struct stat managed_parent, device_parent;
  cutover_fixture_init(&fixture);
  assert(keiko_coordinator_publish_registration(&fixture.context, fixture_deadline()) == 0);
  assert(mkdir(fixture.backup, 0700) == 0);
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.old_digest);
  assert(rmdir(fixture.backup) == 0);

  assert(unlink(fixture.registration) == 0);
  write_fixture_file(fixture.registration, "untrusted registration\n");
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.old_digest);
  assert(unlink(fixture.registration) == 0);
  assert(symlink(fixture.previous_snapshot, fixture.registration) == 0);
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.old_digest);
  assert(unlink(fixture.registration) == 0);
  write_fixture_file(fixture.registration, "previous registration\n");

  assert(join_path(foreign, sizeof(foreign), fixture.stage, "/foreign") == 1);
  assert(rename(fixture.candidate, foreign) == 0);
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.old_digest);
  assert(rename(foreign, fixture.candidate) == 0);

  assert(join_path(candidate_payload, sizeof(candidate_payload), fixture.candidate, "/payload") ==
         1);
  assert(unlink(candidate_payload) == 0);
  write_fixture_file(candidate_payload, "old attested tree\n");
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.old_digest);
  assert(unlink(candidate_payload) == 0);
  write_fixture_file(candidate_payload, "new attested tree\n");

  memcpy(cross_device_backup, "/dev/keiko-3405-cross-device-backup",
         sizeof("/dev/keiko-3405-cross-device-backup"));
  assert(stat(fixture.root, &managed_parent) == 0);
  assert(stat("/dev", &device_parent) == 0);
  assert(managed_parent.st_dev != device_parent.st_dev);
  fixture.context.plan.field[KEIKO_KHP_BACKUP_ROOT] = cross_device_backup;
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.old_digest);
  fixture.context.plan.field[KEIKO_KHP_BACKUP_ROOT] = fixture.backup;

  assert(rename(fixture.candidate, foreign) == 0);
  assert(join_path(link_target, sizeof(link_target), fixture.stage, "/candidate") == 1);
  assert(symlink(foreign, link_target) == 0);
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.old_digest);
  assert(unlink(link_target) == 0);
  assert(rename(foreign, fixture.candidate) == 0);

  assert(join_path(real_stage, sizeof(real_stage), fixture.root, "/stage-real") == 1);
  assert(rename(fixture.stage, real_stage) == 0);
  assert(symlink(real_stage, fixture.stage) == 0);
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.old_digest);
  assert(unlink(fixture.stage) == 0);
  assert(rename(real_stage, fixture.stage) == 0);
  cutover_fixture_clear(&fixture);
}

static void test_registration_and_restore_are_crash_idempotent(void) {
  cutover_fixture fixture;
  cutover_fixture_init(&fixture);
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 1);

  coordinator_cutover_failure = "register-after-publish";
  assert(keiko_coordinator_publish_registration(&fixture.context, fixture_deadline()) == 0);
  assert(keiko_coordinator_file_digest_matches(fixture.registration,
                                               fixture.prepared_registration_digest,
                                               fixture_deadline()) == 1);
  assert_tree_digest(fixture.managed, fixture.new_digest);
  coordinator_cutover_failure = NULL;
  assert(keiko_coordinator_publish_registration(&fixture.context, fixture_deadline()) == 1);
  assert(keiko_coordinator_file_digest_matches(fixture.registration,
                                               fixture.prepared_registration_digest,
                                               fixture_deadline()) == 1);

  coordinator_cutover_failure = "restore-after-exchange";
  assert(keiko_coordinator_restore_previous(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.old_digest);
  assert_tree_digest(fixture.backup, fixture.new_digest);
  assert(keiko_coordinator_file_digest_matches(fixture.registration,
                                               fixture.prepared_registration_digest,
                                               fixture_deadline()) == 1);

  coordinator_cutover_failure = NULL;
  assert(keiko_coordinator_restore_previous(&fixture.context, fixture_deadline()) == 1);
  assert_tree_digest(fixture.managed, fixture.old_digest);
  assert_tree_digest(fixture.backup, fixture.new_digest);
  assert(keiko_coordinator_file_digest_matches(fixture.registration,
                                               fixture.previous_registration_digest,
                                               fixture_deadline()) == 1);
  assert(keiko_coordinator_restore_previous(&fixture.context, fixture_deadline()) == 1);
  cutover_fixture_clear(&fixture);
}

static void test_restore_handles_post_exchange_shape(void) {
  cutover_fixture fixture;
  cutover_fixture_init(&fixture);
  coordinator_cutover_failure = "promote-after-exchange";
  assert(keiko_coordinator_promote_roots(&fixture.context, fixture_deadline()) == 0);
  coordinator_cutover_failure = "restore-before-exchange";
  assert(keiko_coordinator_restore_previous(&fixture.context, fixture_deadline()) == 0);
  assert_tree_digest(fixture.managed, fixture.new_digest);
  assert_tree_digest(fixture.candidate, fixture.old_digest);
  assert_path_absent(fixture.backup);
  coordinator_cutover_failure = NULL;
  assert(keiko_coordinator_restore_previous(&fixture.context, fixture_deadline()) == 1);
  assert_tree_digest(fixture.managed, fixture.old_digest);
  assert_tree_digest(fixture.candidate, fixture.new_digest);
  assert_path_absent(fixture.backup);
  cutover_fixture_clear(&fixture);
}

static void test_recovery_control_is_fixed_and_bounded(void) {
  char valid[] =
      "KUR1\n0123456789abcdef0123456789abcdef\n"
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"
      "7\n0\n-\ncccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n"
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n";
  char trailing[] =
      "KUR1\n0123456789abcdef0123456789abcdef\n"
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"
      "7\n0\n-\ncccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n"
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\nX";
  char runtime_control_magic[] =
      "KRC1\n0123456789abcdef0123456789abcdef\n"
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"
      "7\n0\n-\ncccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n"
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n";
  keiko_recovery_control control;
  memset(&control, 0, sizeof(control));
  assert(keiko_recovery_parse_control(valid, &control) == 1);
  assert(control.intent_revision == 7u);
  assert(control.receipt_sequence == 0u);
  memset(&control, 0, sizeof(control));
  assert(keiko_recovery_parse_control(trailing, &control) == 0);
  memset(&control, 0, sizeof(control));
  assert(keiko_recovery_parse_control(runtime_control_magic, &control) == 0);
}

static void test_recovery_runtime_requires_exact_validated_snapshot(void) {
  static const char canonical[] =
      "{\n  \"schemaVersion\": 2,\n  \"revision\": 7,\n"
      "  \"activationWal\": {\"intentRevision\": 7, \"receiptSequence\": 1}\n}\n";
  static const char *const changed[] = {
      "{\n  \"schemaVersion\": 2,\n  \"revision\": 7,\n"
      "  \"activationWal\": {\"intentRevision\": 7, \"receiptSequence\": 10}\n}\n",
      "{\n  \"schemaVersion\": 2,\n  \"revision\": 7,\n"
      "  \"other\": {\"intentRevision\": 7, \"receiptSequence\": 1}\n}\n",
      "{\n  \"schemaVersion\": 2,\n  \"revision\": 7,\n"
      "  \"activationWal\": {\"intentRevision\": 7, \"receiptSequence\": 1},\n"
      "  \"duplicate\": {\"receiptSequence\": 1}\n}\n",
      "malformed runtime state\n"};
  cutover_fixture fixture;
  keiko_recovery_control control;
  char updates[PATH_MAX], runtime_state[PATH_MAX], lookalike[PATH_MAX], digest[65];
  size_t index;
  cutover_fixture_init(&fixture);
  assert(join_path(updates, sizeof(updates), fixture.state, "/updates") == 1);
  assert(mkdir(updates, 0700) == 0);
  assert(join_path(runtime_state, sizeof(runtime_state), updates, "/runtime-state.json") == 1);
  assert(join_path(lookalike, sizeof(lookalike), fixture.state, "/runtime-state.json") == 1);
  write_fixture_file(lookalike, canonical);
  write_fixture_file(runtime_state, changed[0]);
  assert(keiko_coordinator_hash_bytes(canonical, strlen(canonical), digest) == 1);
  memset(&control, 0, sizeof(control));
  control.runtime_state_sha256 = digest;
  assert(keiko_recovery_validate_runtime(&fixture.context, &control, fixture_deadline()) == 0);
  replace_fixture_file(runtime_state, canonical);
  assert(keiko_recovery_validate_runtime(&fixture.context, &control, fixture_deadline()) == 1);
  replace_fixture_file(lookalike, "malformed root lookalike\n");
  assert(keiko_recovery_validate_runtime(&fixture.context, &control, fixture_deadline()) == 1);
  for (index = 0; index < sizeof(changed) / sizeof(changed[0]); ++index) {
    replace_fixture_file(runtime_state, changed[index]);
    assert(keiko_recovery_validate_runtime(&fixture.context, &control, fixture_deadline()) == 0);
  }
  cutover_fixture_clear(&fixture);
}

static void test_recovery_restores_before_verification_and_retains_verified(void) {
  cutover_fixture restoring;
  cutover_fixture retained;
  cutover_fixture_init(&restoring);
  assert(keiko_coordinator_promote_roots(&restoring.context, fixture_deadline()) == 1);
  assert(keiko_coordinator_publish_registration(&restoring.context, fixture_deadline()) == 1);
  restoring.context.receipt_sequence = 7u;
  memset(restoring.context.receipt_sha256, 'a', 64u);
  restoring.context.receipt_sha256[64] = '\0';
  assert(keiko_recovery_reconcile(&restoring.context, 7u, 0u, 0u) == 0);
  assert_tree_digest(restoring.managed, restoring.new_digest);
  assert(keiko_recovery_reconcile(&restoring.context, 7u, 0u, fixture_deadline()) == 1);
  assert_tree_digest(restoring.managed, restoring.old_digest);
  assert(keiko_coordinator_file_digest_matches(restoring.registration,
                                               restoring.previous_registration_digest,
                                               fixture_deadline()) == 1);
  cutover_fixture_clear(&restoring);

  cutover_fixture_init(&retained);
  assert(keiko_coordinator_promote_roots(&retained.context, fixture_deadline()) == 1);
  assert(keiko_coordinator_publish_registration(&retained.context, fixture_deadline()) == 1);
  retained.context.receipt_sequence = 11u;
  memset(retained.context.receipt_sha256, 'b', 64u);
  retained.context.receipt_sha256[64] = '\0';
  assert_tree_digest(retained.managed, retained.new_digest);
  assert(keiko_coordinator_file_digest_matches(retained.registration,
                                               retained.prepared_registration_digest,
                                               fixture_deadline()) == 1);
  assert(keiko_recovery_reconcile(&retained.context, 11u, 0u,
                                  keiko_tree_now_ms() + 30000u) == 1);
  assert_tree_digest(retained.managed, retained.new_digest);
  assert_path_absent(retained.backup);
  assert_path_absent(retained.stage);
  cutover_fixture_clear(&retained);
}

static void test_spawn_preserves_fixed_protocol_descriptors(const char *self) {
  char root[] = "/tmp/keiko-coordinator-spawn.XXXXXX";
  char source[PATH_MAX], supervisor[PATH_MAX], candidate[PATH_MAX], managed[PATH_MAX];
  char candidate_launcher[PATH_MAX], active_launcher[PATH_MAX], launcher_digest[65];
  keiko_coordinator_context context;
  assert(mkdtemp(root) != NULL);
  assert(realpath(self, source) != NULL);
  assert(join_path(supervisor, sizeof(supervisor), root, "/runtime-supervisor") == 1);
  assert(join_path(candidate, sizeof(candidate), root, "/candidate") == 1);
  assert(join_path(managed, sizeof(managed), root, "/managed") == 1);
  assert(join_path(candidate_launcher, sizeof(candidate_launcher), candidate, "/launcher") == 1);
  assert(join_path(active_launcher, sizeof(active_launcher), managed, "/launcher") == 1);
  assert(mkdir(candidate, 0700) == 0);
  assert(mkdir(managed, 0700) == 0);
  copy_executable(source, supervisor);
  write_fixture_file(active_launcher, "verified launcher fixture\n");
  assert(keiko_coordinator_hash_file(active_launcher, keiko_tree_now_ms() + 3000u,
                                     launcher_digest) == 1);

  memset(&context, 0, sizeof(context));
  context.supervisor_pid = -1;
  context.supervisor_control = -1;
  context.supervisor_response = -1;
  context.start_gate = -1;
  memcpy(context.capsule, root, strlen(root) + 1u);
  memcpy(context.state_dir, root, strlen(root) + 1u);
  context.plan.field[KEIKO_KHP_ACTIVATION_ID] = (char *)RECONCILE_OK;
  context.plan.field[KEIKO_KHP_CANDIDATE_ROOT] = candidate;
  context.plan.field[KEIKO_KHP_MANAGED_ROOT] = managed;
  context.plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER] = candidate_launcher;
  context.plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256] = launcher_digest;
  assert(keiko_coordinator_spawn_supervisor(&context, keiko_tree_now_ms() + 1000u, 0) == 1);
  assert(keiko_coordinator_stop_runtime(&context, keiko_tree_now_ms() + 1000u) == 1);
  assert(context.start_gate >= 0);
  close(context.start_gate);
  context.start_gate = -1;

  assert(unlink(active_launcher) == 0);
  assert(unlink(supervisor) == 0);
  assert(rmdir(candidate) == 0);
  assert(rmdir(managed) == 0);
  assert(rmdir(root) == 0);
}

static void test_reconcile_requires_zero_live_proof(const char *self) {
  char root[] = "/tmp/keiko-coordinator-reconcile.XXXXXX";
  char source[PATH_MAX], supervisor[PATH_MAX], digest[65];
  keiko_coordinator_context context;
  uint64_t started;
  assert(mkdtemp(root) != NULL);
  assert(realpath(self, source) != NULL);
  assert(join_path(supervisor, sizeof(supervisor), root, "/runtime-supervisor") == 1);
  copy_executable(source, supervisor);
  assert(keiko_coordinator_hash_file(supervisor, keiko_tree_now_ms() + 3000u, digest) == 1);
  assert(keiko_coordinator_file_digest_matches(supervisor, digest,
                                               keiko_tree_now_ms() + 3000u) == 1);

  memset(&context, 0, sizeof(context));
  memcpy(context.capsule, root, strlen(root) + 1u);
  context.plan.field[KEIKO_KHP_CURRENT_SUPERVISOR_SHA256] = digest;
  context.plan.field[KEIKO_KHP_ACTIVATION_ID] = (char *)RECONCILE_OK;
  assert(keiko_coordinator_reconcile_stopped_runtime(&context, keiko_tree_now_ms() + 1000u) == 1);

  context.plan.field[KEIKO_KHP_ACTIVATION_ID] = (char *)RECONCILE_LIVE;
  assert(keiko_coordinator_reconcile_stopped_runtime(&context, keiko_tree_now_ms() + 1000u) == 0);

  coordinator_cleanup_kills = 0;
  context.plan.field[KEIKO_KHP_ACTIVATION_ID] = (char *)RECONCILE_NONZERO_EXIT;
  assert(keiko_coordinator_reconcile_stopped_runtime(&context, keiko_tree_now_ms() + 1000u) == 0);
  assert(coordinator_cleanup_kills == 0u);

  context.plan.field[KEIKO_KHP_ACTIVATION_ID] = (char *)RECONCILE_SIGNALLED_EXIT;
  assert(keiko_coordinator_reconcile_stopped_runtime(&context, keiko_tree_now_ms() + 1000u) == 0);
  assert(coordinator_cleanup_kills == 0u);

  context.plan.field[KEIKO_KHP_ACTIVATION_ID] = (char *)RECONCILE_HANG;
  started = keiko_tree_now_ms();
  assert(keiko_coordinator_reconcile_stopped_runtime(&context, started + 50u) == 0);
  assert(keiko_tree_now_ms() - started < 1000u);
  assert(coordinator_cleanup_kills == 1u);

  assert(unlink(supervisor) == 0);
  assert(rmdir(root) == 0);
}

int main(int argc, char **argv) {
  char path[64];
  if (argc == 3 && strcmp(argv[1], "--reconcile") == 0) return reconcile_fixture(argv[2]);
  if (argc == 1 && strstr(argv[0], "/runtime-supervisor") != NULL) return supervisor_fixture();
  assert(argc == 1);
  assert(dirname_copy(path, sizeof(path), "/tmp/Keiko.app/Contents/MacOS/keiko") == 1);
  assert(strcmp(path, "/tmp/Keiko.app/Contents/MacOS") == 0);
  assert(dirname_copy(path, sizeof(path), "keiko") == 0);
  assert(dirname_copy(path, 4, "/too/long") == 0);
  assert(join_path(path, sizeof(path), "/tmp/Keiko.app", "/Contents/Resources") == 1);
  assert(strcmp(path, "/tmp/Keiko.app/Contents/Resources") == 0);
  assert(join_path(path, 5, "/tmp", "/Keiko") == 0);
#if defined(__linux__)
  assert(current_executable_path(path, 2) == 0);
#endif
  test_spawn_preserves_fixed_protocol_descriptors(argv[0]);
  test_reconcile_requires_zero_live_proof(argv[0]);
  test_atomic_promote_survives_each_cutover_boundary();
  test_atomic_cutover_rejects_untrusted_states();
  test_registration_and_restore_are_crash_idempotent();
  test_restore_handles_post_exchange_shape();
  test_recovery_control_is_fixed_and_bounded();
  test_recovery_runtime_requires_exact_validated_snapshot();
  test_recovery_restores_before_verification_and_retains_verified();
  return 0;
}
