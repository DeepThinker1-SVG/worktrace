import fs from 'node:fs/promises';
import path from 'node:path';

import type { BundledWorkflowPackage, WorkflowPackageLocale } from '../../shared/workflow';

export const aiCodingWorkflowPackages: Array<
  Omit<BundledWorkflowPackage, 'filesByLocale' | 'updateAvailable' | 'hasLocalChanges'>
> = [
  {
    id: 'workboard',
    locales: ['zh-CN', 'en'],
  },
];

export const aiCodingWorkflowDefaultFilePaths = [
  'AGENTS.workboard-section.md',
  '.agents/skills/workboard-workflow/SKILL.md',
  '.workboard/PROTOCOL.md',
  '.workboard/templates/current.md',
  '.workboard/templates/change.md',
  '.workboard/templates/verify.md',
  '.workboard/templates/retrospective.md',
  '.workboard/templates/project-status.md',
  '.workboard/templates/code-map.md',
  '.workboard/templates/decisions.md',
] as const;

export type AiCodingWorkflowDefaultFilePath = (typeof aiCodingWorkflowDefaultFilePaths)[number];

export async function locateAiCodingWorkflowDefaultPackage(
  packageId = 'workboard',
  locale: WorkflowPackageLocale = 'zh-CN',
): Promise<string> {
  const workflowPackage = aiCodingWorkflowPackages.find((entry) => entry.id === packageId);

  if (!workflowPackage?.locales.includes(locale)) {
    throw new Error(`Bundled AI coding workflow package is unavailable: ${packageId}/${locale}`);
  }

  for (const candidate of candidateDefaultPackagePaths(packageId, locale)) {
    if (await hasRequiredDefaultFiles(candidate)) {
      return candidate;
    }
  }

  throw new Error('Default AI coding workflow package resources are missing.');
}

export async function assertAiCodingWorkflowDefaultPackage(packagePath: string): Promise<void> {
  for (const relativePath of aiCodingWorkflowDefaultFilePaths) {
    const filePath = path.join(packagePath, relativePath);
    const stat = await fs.stat(filePath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new Error(`Default AI coding workflow file is missing: ${relativePath}`);
      }

      throw error;
    });

    if (!stat.isFile()) {
      throw new Error(`Default AI coding workflow path is not a file: ${relativePath}`);
    }
  }
}

function candidateDefaultPackagePaths(packageId: string, locale: WorkflowPackageLocale): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'workflow', 'ai-coding', packageId, locale) : undefined,
    path.resolve(process.cwd(), 'resources', 'workflow', 'ai-coding', packageId, locale),
    path.resolve(__dirname, '..', '..', 'resources', 'workflow', 'ai-coding', packageId, locale),
    path.resolve(__dirname, '..', '..', '..', 'resources', 'workflow', 'ai-coding', packageId, locale),
  ];

  return candidates.filter((candidate): candidate is string => candidate !== undefined);
}

async function hasRequiredDefaultFiles(packagePath: string): Promise<boolean> {
  for (const relativePath of aiCodingWorkflowDefaultFilePaths) {
    const stat = await fs.stat(path.join(packagePath, relativePath)).catch(() => null);

    if (!stat?.isFile()) {
      return false;
    }
  }

  return true;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
