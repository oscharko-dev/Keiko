#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/types.h>
#include <unistd.h>

static void write_u32(unsigned char *value, uint32_t number) {
  value[0] = (unsigned char)number;
  value[1] = (unsigned char)(number >> 8);
  value[2] = (unsigned char)(number >> 16);
  value[3] = (unsigned char)(number >> 24);
}

int main(int argc, char **argv) {
  unsigned char observation[12] = {'K', 'R', 'Q', '1', 0, 0, 0, 0, 0, 0, 0, 0};
  pid_t child;
  (void)argv;
  if (argc != 3) return 2;
  child = fork();
  if (child == -1) return 3;
  if (child == 0) {
    for (;;) pause();
  }
  write_u32(observation + 4, (uint32_t)getpid());
  write_u32(observation + 8, (uint32_t)child);
  if (write(STDOUT_FILENO, observation, sizeof(observation)) != (ssize_t)sizeof(observation)) {
    (void)kill(child, SIGKILL);
    return 4;
  }
  for (;;) pause();
}
