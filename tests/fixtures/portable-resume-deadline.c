#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

static uint64_t fixture_wall;
static uint64_t fixture_monotonic = 1000u;

static int fixture_gettimeofday(struct timeval *value, void *zone) {
  (void)zone;
  value->tv_sec = (time_t)(fixture_wall / 1000u);
  value->tv_usec = (suseconds_t)((fixture_wall % 1000u) * 1000u);
  return 0;
}

static int fixture_clock_gettime(clockid_t clock, struct timespec *value) {
  assert(clock == CLOCK_MONOTONIC);
  value->tv_sec = (time_t)(fixture_monotonic / 1000u);
  value->tv_nsec = (long)((fixture_monotonic % 1000u) * 1000000u);
  return 0;
}

#define gettimeofday fixture_gettimeofday
#define clock_gettime fixture_clock_gettime
#define main unused_portable_launcher_main
#include "../../native/portable-launcher/keiko-portable-launcher.c"
#undef main
#undef clock_gettime
#undef gettimeofday

typedef struct {
  keiko_coordinator_context transaction;
  const char *activation;
  const char *executable;
  const char *gate_path;
  uint64_t failure_wall;
  uint64_t cleanup_deadline;
  unsigned int restored_calls;
  unsigned int restored_admissions;
} resume_fixture;

static void reopen_gate(const resume_fixture *fixture) {
  int descriptor = open(fixture->gate_path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  assert(descriptor >= 0);
  if (descriptor != KEIKO_COORDINATOR_START_GATE_FD) {
    assert(dup2(descriptor, KEIKO_COORDINATOR_START_GATE_FD) == KEIKO_COORDINATOR_START_GATE_FD);
    assert(close(descriptor) == 0);
  }
}

static void select_image(const resume_fixture *fixture, int restoring) {
  const char *body = restoring ? "coordinator" : "candidate-launcher";
  int descriptor = open(fixture->executable, O_WRONLY | O_TRUNC | O_CLOEXEC | O_NOFOLLOW);
  assert(descriptor >= 0);
  assert(keiko_coordinator_write_exact(descriptor, body, strlen(body)) == 1);
  assert(fsync(descriptor) == 0);
  assert(close(descriptor) == 0);
}

static int start_resume(void *opaque, uint64_t deadline, int restoring) {
  resume_fixture *fixture = (resume_fixture *)opaque;
  keiko_coordinator_context resumed;
  int admitted;
  if (restoring) {
    fixture->restored_calls += 1u;
    assert(deadline == fixture->cleanup_deadline);
  }
  select_image(fixture, restoring);
  reopen_gate(fixture);
  admitted = keiko_coordinator_prepare_resume_posix(
      &resumed, fixture->activation, fixture->executable, restoring);
  if (admitted) keiko_coordinator_clear(&resumed);
  if (restoring && admitted) fixture->restored_admissions += 1u;
  return admitted;
}

static int engine_deadline(void *opaque, int field, uint64_t *deadline) {
  resume_fixture *fixture = (resume_fixture *)opaque;
  int result = keiko_coordinator_deadline(&fixture->transaction, (unsigned int)field, deadline);
  if (result && field == KEIKO_KHP_CLEANUP_AT) fixture->cleanup_deadline = *deadline;
  return result;
}

static int plain_ok(void *opaque) { (void)opaque; return 1; }
static int timed_ok(void *opaque, uint64_t deadline) {
  (void)opaque;
  (void)deadline;
  return 1;
}
static int no_extra_receipt(void *opaque) { (void)opaque; return 0; }
static void no_runtime_hold(void *opaque) { (void)opaque; }

static int engine_receipt(void *opaque, const char *kind, const char *outcome,
                          uint64_t deadline) {
  resume_fixture *fixture = (resume_fixture *)opaque;
  (void)deadline;
  if (strcmp(kind, "verify") == 0 && strcmp(outcome, "intent") == 0) {
    assert(fixture->failure_wall >= fixture_wall);
    fixture_monotonic += fixture->failure_wall - fixture_wall;
    fixture_wall = fixture->failure_wall;
    return 0;
  }
  return 1;
}

static int rollback(resume_fixture *fixture) {
  char capsule[KEIKO_KHP_MAX_PATH_BYTES + 1];
  const char *state = getenv("KEIKO_STATE_DIR");
  int descriptor, result;
  const keiko_coordinator_engine engine = {
      fixture, engine_deadline, plain_ok, plain_ok, timed_ok, timed_ok, start_resume,
      engine_receipt, no_extra_receipt, timed_ok, timed_ok, timed_ok, timed_ok, timed_ok,
      timed_ok, no_runtime_hold};
  assert(snprintf(capsule, sizeof(capsule), "%s/updates/handoff/%s", state,
                  fixture->activation) > 0);
  descriptor = open(capsule, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  assert(descriptor >= 0);
  assert(keiko_coordinator_load_plan(&fixture->transaction, descriptor, fixture->activation,
                                    fixture_monotonic + KEIKO_COORDINATOR_MAX_CONTROL_MS) == 1);
  assert(close(descriptor) == 0);
  result = keiko_coordinator_execute_engine(&engine, KEIKO_KHP_START_AT, KEIKO_KHP_VERIFY_AT,
                                           KEIKO_KHP_CLEANUP_AT);
  keiko_khp_clear(&fixture->transaction.plan);
  return result;
}

int main(int argc, char **argv) {
  resume_fixture fixture;
  keiko_coordinator_context resumed;
  int admitted;
  assert(argc == 9);
  memset(&fixture, 0, sizeof(fixture));
  fixture.activation = argv[2];
  fixture.executable = argv[3];
  fixture.gate_path = argv[4];
  assert(keiko_khp_decimal_value(argv[5], UINT64_C(9007199254740991), &fixture_wall) == 1);
  assert(keiko_khp_decimal_value(argv[6], UINT64_C(9007199254740991),
                                &fixture.failure_wall) == 1);
  assert(strcmp(getenv("KEIKO_STATE_DIR"), argv[7]) == 0);
  if (strcmp(argv[1], "rollback") == 0) admitted = rollback(&fixture);
  else {
    reopen_gate(&fixture);
    admitted = keiko_coordinator_prepare_resume_posix(
        &resumed, fixture.activation, fixture.executable, strcmp(argv[8], "restore") == 0);
    if (admitted) keiko_coordinator_clear(&resumed);
  }
  printf("{\"admitted\":%d,\"restoredCalls\":%u,\"restoredAdmissions\":%u}\n", admitted,
         fixture.restored_calls, fixture.restored_admissions);
  return 0;
}
