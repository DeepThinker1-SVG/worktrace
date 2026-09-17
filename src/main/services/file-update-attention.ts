import {
  clearFileAttention,
  mergePendingFileUpdates,
  type ModuleUpdateSummary,
  type PendingFileUpdateIndex,
} from '../../shared/workspace';

export function mergeFileUpdateSummaries(input: {
  current: PendingFileUpdateIndex;
  relativePath: string;
  summaries: Record<string, ModuleUpdateSummary>;
  fileWindowOpen: boolean;
}): PendingFileUpdateIndex {
  const next = mergePendingFileUpdates(input.current, input.summaries);

  return input.fileWindowOpen ? clearFileAttention(next, input.relativePath) : next;
}
