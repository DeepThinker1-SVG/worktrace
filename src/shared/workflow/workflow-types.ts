export type WorkflowPackageFile = {
  path: string;
  size: number;
  updatedAt: number;
};

export type WorkflowPackageState = {
  packagePath: string;
  files: WorkflowPackageFile[];
};

export type WorkflowPackageLocale = 'zh-CN' | 'en';

export type BundledWorkflowPackage = {
  id: string;
  locales: WorkflowPackageLocale[];
  filesByLocale: Partial<Record<WorkflowPackageLocale, WorkflowPackageFile[]>>;
  updateAvailable: boolean;
  hasLocalChanges: boolean;
};

export type BundledWorkflowPackageUpdateResult = {
  catalog: WorkflowPackageCatalog;
  backupPath?: string;
};

export type UserWorkflowPackage = {
  id: string;
  name: string;
  packagePath: string;
  files: WorkflowPackageFile[];
};

export type WorkflowPackageCatalog = {
  bundled: BundledWorkflowPackage[];
  user: UserWorkflowPackage[];
};

export function isWorkflowPackageLocale(value: unknown): value is WorkflowPackageLocale {
  return value === 'zh-CN' || value === 'en';
}

export type WorkflowImportResult = {
  state: WorkflowPackageState;
  imported: string[];
  overwritten: string[];
};

export type AgentsSectionAction = 'create' | 'append' | 'replace' | 'unchanged';

export type WorkflowApplyPlan = {
  workspacePath: string;
  agentsSectionAction: AgentsSectionAction;
  create: string[];
  overwrite: string[];
  same: string[];
};

export type WorkflowApplyResult = WorkflowApplyPlan;
