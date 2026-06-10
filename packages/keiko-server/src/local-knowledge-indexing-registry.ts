interface ActiveLocalKnowledgeIndexingRun {
  readonly capsuleId: string;
  readonly controller: AbortController;
  jobId?: string;
}

export class LocalKnowledgeIndexingRegistry {
  private readonly runsByCapsule = new Map<string, ActiveLocalKnowledgeIndexingRun>();
  private readonly runsByJobId = new Map<string, ActiveLocalKnowledgeIndexingRun>();

  start(capsuleId: string): AbortController {
    this.complete(capsuleId);
    const controller = new AbortController();
    this.runsByCapsule.set(capsuleId, { capsuleId, controller });
    return controller;
  }

  attachJobId(capsuleId: string, jobId: string): void {
    const run = this.runsByCapsule.get(capsuleId);
    if (run === undefined) {
      return;
    }
    if (run.jobId !== undefined) {
      this.runsByJobId.delete(run.jobId);
    }
    run.jobId = jobId;
    this.runsByJobId.set(jobId, run);
  }

  cancel(capsuleId: string): boolean {
    const run = this.runsByCapsule.get(capsuleId);
    if (run === undefined) {
      return false;
    }
    run.controller.abort();
    return true;
  }

  isActiveCapsule(capsuleId: string): boolean {
    return this.runsByCapsule.has(capsuleId);
  }

  isActiveJob(jobId: string): boolean {
    return this.runsByJobId.has(jobId);
  }

  complete(capsuleId: string): void {
    const run = this.runsByCapsule.get(capsuleId);
    if (run === undefined) {
      return;
    }
    if (run.jobId !== undefined) {
      this.runsByJobId.delete(run.jobId);
    }
    this.runsByCapsule.delete(capsuleId);
  }

  reset(): void {
    for (const run of this.runsByCapsule.values()) {
      run.controller.abort();
    }
    this.runsByCapsule.clear();
    this.runsByJobId.clear();
  }
}

export const localKnowledgeIndexingRegistry = new LocalKnowledgeIndexingRegistry();
