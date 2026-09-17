import type { WorkspaceState, ModuleUpdateSummary } from '../../shared/workspace';

export class TransientUpdateState {
  private readonly fileUpdateStatuses: WorkspaceState['fileUpdateStatuses'] = {};
  private readonly moduleUpdateSummaries = new Map<string, ModuleUpdateSummary>();
  private readonly clearTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly onExpired: () => void,
    private readonly recentUpdateDurationMs = 4200,
  ) {}

  getFileUpdateStatuses(): WorkspaceState['fileUpdateStatuses'] {
    return { ...this.fileUpdateStatuses };
  }

  markUpdating(input: {
    relativePath: string;
    moduleKeys: string[];
    id: number;
    changedAt: number;
  }): void {
    this.clearTimer(input.relativePath);
    this.fileUpdateStatuses[input.relativePath] = {
      phase: 'updating',
      updatedAt: input.changedAt,
    };

    for (const moduleKey of input.moduleKeys) {
      this.moduleUpdateSummaries.set(moduleKey, {
        id: input.id,
        relativePath: input.relativePath,
        phase: 'updating',
        changedAt: input.changedAt,
        moduleAdded: false,
        leadingBodyChanged: false,
        changedHeadingKeys: [],
        structureChanged: false,
        fileStructureChanged: false,
      });
    }
  }

  markCompleted(input: {
    relativePath: string;
    phase: 'recentlyUpdated' | 'error';
    summaries: Record<string, ModuleUpdateSummary>;
    changedAt: number;
  }): void {
    this.fileUpdateStatuses[input.relativePath] = {
      phase: input.phase,
      updatedAt: input.changedAt,
    };

    for (const [moduleKey, summary] of Object.entries(input.summaries)) {
      this.moduleUpdateSummaries.set(moduleKey, summary);
    }

    this.scheduleClear(input.relativePath);
  }

  clearAll(): void {
    for (const timer of this.clearTimers.values()) {
      clearTimeout(timer);
    }

    this.clearTimers.clear();

    for (const relativePath of Object.keys(this.fileUpdateStatuses)) {
      delete this.fileUpdateStatuses[relativePath];
    }

    this.moduleUpdateSummaries.clear();
  }

  clearFile(relativePath: string): void {
    this.clearTimer(relativePath);
    delete this.fileUpdateStatuses[relativePath];

    for (const [moduleKey, summary] of this.moduleUpdateSummaries) {
      if (summary.relativePath === relativePath) {
        this.moduleUpdateSummaries.delete(moduleKey);
      }
    }
  }

  private scheduleClear(relativePath: string): void {
    this.clearTimer(relativePath);

    const timer = setTimeout(() => {
      delete this.fileUpdateStatuses[relativePath];

      for (const [moduleKey, summary] of this.moduleUpdateSummaries) {
        if (summary.relativePath === relativePath) {
          this.moduleUpdateSummaries.delete(moduleKey);
        }
      }

      this.clearTimers.delete(relativePath);
      this.onExpired();
    }, this.recentUpdateDurationMs);

    this.clearTimers.set(relativePath, timer);
  }

  private clearTimer(relativePath: string): void {
    const timer = this.clearTimers.get(relativePath);

    if (timer) {
      clearTimeout(timer);
      this.clearTimers.delete(relativePath);
    }
  }
}
