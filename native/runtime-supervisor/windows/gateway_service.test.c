/* Independently observe the suspended root in the supervisor's named job. The other
 * invocation runs inside that job and emits the first observable child instruction. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

int wmain(int argc, wchar_t **argv) {
  if (argc == 1) {
    puts("child-entered");
    return 0;
  }
  if (argc != 2 || wcscmp(argv[1], L"--observe")) return 2;
  for (int i = 0; i < 200; i++) {
    HANDLE job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE,
        L"Local\\KeikoRuntime-0123456789abcdef0123456789abcdef");
    if (job) {
      JOBOBJECT_BASIC_PROCESS_ID_LIST ids = {0};
      BOOL found = QueryInformationJobObject(job, JobObjectBasicProcessIdList, &ids,
          sizeof(ids), NULL) && ids.NumberOfProcessIdsInList == 1;
      CloseHandle(job);
      if (found) { printf("observed-job-root=%llu\n", (unsigned long long)ids.ProcessIdList[0]); return 0; }
    }
    Sleep(10);
  }
  return 1;
}
