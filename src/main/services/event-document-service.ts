import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  applyIdentityTree,
  emptySidecar,
  parseTodoMarkdown,
  serializeTodoMarkdown,
  sidecarFromDocument,
  validateTodoSidecar,
  type EventDocument,
  type TodoSidecar,
  type TodoSidecarDocument,
} from "../../shared/events";
import { atomicWriteJson } from "./config-service";

export type EventDocumentState = {
  document: EventDocument;
  sidecar?: TodoSidecarDocument;
  status: "ready" | "sidecar-missing";
};

export class EventDocumentService {
  private activeSidecarPath: string | null = null;
  constructor(private readonly workspacePath: string, private readonly storageRoot?: string) {}
  async load(relativePath: string): Promise<EventDocumentState> {
    const safe = this.safePath(relativePath);
    const markdown = await fs.readFile(
      path.join(this.workspacePath, safe),
      "utf8",
    );
    const sidecar = await this.readSidecar(safe);
    const parsed = parseTodoMarkdown(markdown, safe, sidecar.statusDefinitions);
    const entry = sidecar.documents[safe];
    if (!entry) return { document: parsed, status: "sidecar-missing" };
    return {
      document: applyIdentityTree(parsed, entry),
      sidecar: entry,
      status: "ready",
    };
  }
  async initialize(relativePath: string): Promise<EventDocumentState> {
    const safe = this.safePath(relativePath);
    const markdown = await fs.readFile(
      path.join(this.workspacePath, safe),
      "utf8",
    );
    const sidecar = await this.readSidecar(safe);
    const parsed = parseTodoMarkdown(markdown, safe, sidecar.statusDefinitions);
    const entry = sidecarFromDocument({ ...parsed, relativePath: safe });
    sidecar.documents[safe] = entry;
    await this.writeSidecar(sidecar, safe);
    return {
      document: applyIdentityTree(parsed, entry),
      sidecar: entry,
      status: "ready",
    };
  }
  async readSidecar(relativePath?: string): Promise<TodoSidecar> {
    const sidecarPath = this.resolveSidecarPath(relativePath);
    try {
      return validateTodoSidecar(
        JSON.parse(await fs.readFile(sidecarPath, "utf8")),
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return emptySidecar();
      throw error;
    }
  }
  async writeSidecar(sidecar: TodoSidecar, relativePath?: string): Promise<void> {
    await atomicWriteJson(this.resolveSidecarPath(relativePath), validateTodoSidecar(sidecar));
  }
  async write(
    relativePath: string,
    document: EventDocument,
    entry: TodoSidecarDocument,
  ): Promise<EventDocument> {
    const safe = this.safePath(relativePath);
    const markdownPath = path.join(this.workspacePath, safe);
    const temp = `${markdownPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temp, serializeTodoMarkdown(document), "utf8");
      await fs.rename(temp, markdownPath);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw new Error("保存失败", { cause: error });
    }
    const sidecar = await this.readSidecar(safe);
    sidecar.documents[safe] = entry;
    sidecar.statusDefinitions = entry.statusDefinitions ?? sidecar.statusDefinitions;
    try {
      await this.writeSidecar(sidecar, safe);
    } catch (error) {
      throw new Error("保存失败", { cause: error });
    }
    const actual = await fs.readFile(markdownPath, "utf8");
    return applyIdentityTree(parseTodoMarkdown(actual, safe, entry.statusDefinitions), entry);
  }
  private safePath(input: string): string {
    const normalized = input.replaceAll("\\", "/");
    const root = path.resolve(this.workspacePath);
    const resolved = path.resolve(root, normalized);
    const relative = path.relative(root, resolved);
    if (
      !normalized ||
      path.isAbsolute(input) ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      path.extname(normalized).toLowerCase() !== ".md"
    )
      throw new Error("Invalid Todo relative path.");
    return normalized;
  }

  private resolveSidecarPath(relativePath?: string): string {
    if (!relativePath && this.activeSidecarPath) return this.activeSidecarPath;
    if (!relativePath) return path.join(this.storageRoot ?? path.join(this.workspacePath, '.workboard'), 'events.json');

    const safe = this.safePath(relativePath);
    if (!this.storageRoot) {
      this.activeSidecarPath = path.join(this.workspacePath, '.workboard', 'events.json');
      return this.activeSidecarPath;
    }

    const absolutePath = path.resolve(this.workspacePath, safe);
    const key = crypto.createHash('sha256').update(process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath).digest('hex');
    this.activeSidecarPath = path.join(this.storageRoot, `${key}.json`);
    return this.activeSidecarPath;
  }
}
