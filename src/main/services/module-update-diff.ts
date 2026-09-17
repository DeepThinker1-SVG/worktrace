import { toModuleWindowData } from '../../shared/markdown';
import type { ParsedFile, ParsedModule } from '../../shared/markdown';
import type { ModuleUpdateSummary, RenderedHeadingNode } from '../../shared/workspace';

export function buildModuleUpdateSummaries(input: {
  previous?: ParsedFile;
  next?: ParsedFile;
  fileRecovered: boolean;
  changedAt: number;
  id: number;
}): Record<string, ModuleUpdateSummary> {
  const summaries: Record<string, ModuleUpdateSummary> = {};

  if (!input.next) {
    for (const module of input.previous?.modules ?? []) {
      summaries[module.moduleKey] = createSummary(input, module.moduleKey, 'error', false, false, [], false, false);
    }

    return summaries;
  }

  const previousModules = new Map((input.previous?.modules ?? []).map((module) => [module.moduleKey, module]));
  const nextModuleKeys = new Set(input.next.modules.map((module) => module.moduleKey));
  const deletedModuleCount = [...previousModules.keys()].filter((moduleKey) => !nextModuleKeys.has(moduleKey)).length;
  let fileStructureChanged = deletedModuleCount > 0;

  for (const nextModule of input.next.modules) {
    const previousModule = previousModules.get(nextModule.moduleKey);

    if (!previousModule) {
      const nextData = toModuleWindowData(input.next.relativePath, nextModule);
      summaries[nextModule.moduleKey] = createSummary(
        input,
        nextModule.moduleKey,
        input.fileRecovered ? 'restored' : 'recentlyUpdated',
        true,
        nextData.leadingBodyMarkdown.trim().length > 0,
        collectHeadingKeys(nextData.headings),
        true,
        true,
      );
      fileStructureChanged = false;
      continue;
    }

    const changes = diffModule(input.next.relativePath, previousModule, nextModule);

    if (
      changes.leadingBodyChanged ||
      changes.changedHeadingKeys.length > 0 ||
      changes.structureChanged ||
      input.fileRecovered ||
      fileStructureChanged
    ) {
      summaries[nextModule.moduleKey] = createSummary(
        input,
        nextModule.moduleKey,
        input.fileRecovered ? 'restored' : 'recentlyUpdated',
        false,
        changes.leadingBodyChanged,
        changes.changedHeadingKeys,
        changes.structureChanged,
        fileStructureChanged,
      );
      fileStructureChanged = false;
    }
  }

  return summaries;
}

function diffModule(
  relativePath: string,
  previousModule: ParsedModule,
  nextModule: ParsedModule,
): { leadingBodyChanged: boolean; changedHeadingKeys: string[]; structureChanged: boolean } {
  const previousData = toModuleWindowData(relativePath, previousModule);
  const nextData = toModuleWindowData(relativePath, nextModule);
  const previousHeadings = new Map(flattenHeadings(previousData.headings).map((heading) => [heading.viewKey, heading]));
  const nextHeadingKeys = new Set(flattenHeadings(nextData.headings).map((heading) => heading.viewKey));
  const changedHeadingKeys: string[] = [];

  for (const nextHeading of flattenHeadings(nextData.headings)) {
    const previousHeading = previousHeadings.get(nextHeading.viewKey);

    if (!previousHeading || headingChanged(previousHeading, nextHeading)) {
      changedHeadingKeys.push(nextHeading.viewKey);
    }
  }

  return {
    leadingBodyChanged: previousData.leadingBodyMarkdown !== nextData.leadingBodyMarkdown,
    changedHeadingKeys,
    structureChanged: [...previousHeadings.keys()].some((headingKey) => !nextHeadingKeys.has(headingKey)),
  };
}

function headingChanged(previous: RenderedHeadingNode, next: RenderedHeadingNode): boolean {
  return (
    previous.rawTitle !== next.rawTitle ||
    previous.title !== next.title ||
    previous.bodyMarkdown !== next.bodyMarkdown ||
    previous.markers.join('\u001f') !== next.markers.join('\u001f')
  );
}

function flattenHeadings(headings: RenderedHeadingNode[]): RenderedHeadingNode[] {
  return headings.flatMap((heading) => [heading, ...flattenHeadings(heading.children)]);
}

function collectHeadingKeys(headings: RenderedHeadingNode[]): string[] {
  return flattenHeadings(headings).map((heading) => heading.viewKey);
}

function createSummary(
  input: { changedAt: number; id: number; next?: ParsedFile; previous?: ParsedFile },
  moduleKey: string,
  phase: ModuleUpdateSummary['phase'],
  moduleAdded: boolean,
  leadingBodyChanged: boolean,
  changedHeadingKeys: string[],
  structureChanged: boolean,
  fileStructureChanged: boolean,
): ModuleUpdateSummary {
  return {
    id: input.id,
    relativePath: input.next?.relativePath ?? input.previous?.relativePath ?? moduleKey.split('::')[0],
    phase,
    changedAt: input.changedAt,
    moduleAdded,
    leadingBodyChanged,
    changedHeadingKeys,
    structureChanged,
    fileStructureChanged,
  };
}
