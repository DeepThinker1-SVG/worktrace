import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { EventDocumentService } from "../src/main/services/event-document-service";
import { EventMutationService } from "../src/main/services/event-mutation-service";
import {
  createEvent,
  indentEvent,
  moveEvent,
  outdentEvent,
  updateDeadline,
  updateTags,
  updateNote,
  deleteEvent,
  updateStatus,
  updateTitle,
} from "../src/shared/events";

async function fixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "workboard-todo-"));
  await fs.mkdir(path.join(workspace, ".workboard"));
  await fs.writeFile(
    path.join(workspace, "todo.md"),
    "# 当前\n\n## 重复\n\n### 重复\n\n# 已结束\n",
    "utf8",
  );
  return { workspace, documents: new EventDocumentService(workspace) };
}

describe("Todo sidecar and mutation consistency", () => {
  it("initializes a sidecar with distinct ids and preserves ids on rename", async () => {
    const { workspace, documents } = await fixture();
    const initial = await documents.initialize("todo.md");
    const root = initial.document.current[0];
    const child = root.children[0];
    expect(root.id).not.toBe(child.id);
    const mutation = new EventMutationService(documents);
    const updated = await mutation.mutate("todo.md", (document) =>
      updateTitle(document, root.id, "改名"),
    );
    expect(updated.current[0].id).toBe(root.id);
    expect(updated.current[0].children[0].id).toBe(child.id);
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("keeps the markdown document readable when the sidecar is absent", async () => {
    const { workspace, documents } = await fixture();
    await documents.initialize("todo.md");
    const mutation = new EventMutationService(documents);
    await mutation.mutate("todo.md", (document) => document);
    await fs.rm(path.join(workspace, ".workboard", "events.json"));
    expect((await documents.load("todo.md")).status).toBe("sidecar-missing");
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("keeps metadata through normal edits and reloads", async () => {
    const { workspace, documents } = await fixture();
    const initial = await documents.initialize("todo.md");
    const root = initial.document.current[0];
    const createdAt = initial.sidecar!.metadata[root.id].createdAt;
    const mutation = new EventMutationService(documents);
    let current = await mutation.mutate("todo.md", (document) =>
      updateTitle(document, root.id, "改名"),
    );
    current = await mutation.mutate("todo.md", (document) =>
      updateDeadline(document, root.id, "2026-12-31"),
    );
    current = await mutation.mutate("todo.md", (document) =>
      updateDeadline(document, root.id, undefined),
    );
    expect(current.current[0].deadline).toBeUndefined();
    expect(
      (await documents.load("todo.md")).document.current[0].deadline,
    ).toBeUndefined();
    current = await mutation.mutate("todo.md", (document) =>
      updateDeadline(document, root.id, "2026-12-31"),
    );
    current = await mutation.mutate("todo.md", (document) =>
      updateStatus(document, root.id, "已完成"),
    );
    expect(current.current[0].id).toBe(root.id);
    expect(current.current[0].closedAt).toBeTruthy();
    expect(current.current[0].deadline).toBe("2026-12-31");
    const reopened = await mutation.mutate("todo.md", (document) =>
      updateStatus(document, root.id, "进行中"),
    );
    expect(reopened.current[0].id).toBe(root.id);
    expect(reopened.current[0].closedAt).toBeUndefined();
    expect(
      (await documents.load("todo.md")).document.current[0].createdAt,
    ).toBe(createdAt);
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("updates activity time only for events changed by a mutation", async () => {
    const { workspace, documents } = await fixture();
    const initial = await documents.initialize("todo.md");
    const root = initial.document.current[0];
    const child = root.children[0];
    const mutation = new EventMutationService(documents);
    const before = await documents.load("todo.md");
    const rootUpdatedAt = before.document.current[0].updatedAt;
    const childUpdatedAt = before.document.current[0].children[0].updatedAt;
    await mutation.mutate("todo.md", (document) => updateTitle(document, root.id, "只改根事件"));
    const after = await documents.load("todo.md");
    expect(after.document.current[0].updatedAt).not.toBe(rootUpdatedAt);
    expect(after.document.current[0].children[0].updatedAt).toBe(childUpdatedAt);
    expect(after.document.current[0].children[0].id).toBe(child.id);
    expect(after.document.activities).toContainEqual(expect.objectContaining({
      eventId: root.id,
      type: "title",
      before: "重复",
      after: "只改根事件",
    }));
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("follows ids through order and hierarchy changes and removes deleted metadata", async () => {
    const { workspace, documents } = await fixture();
    await fs.writeFile(
      path.join(workspace, "todo.md"),
      "# 当前\n\n## A\n\n## B\n\n# 已结束\n",
      "utf8",
    );
    const initial = await documents.initialize("todo.md");
    const a = initial.document.current[0];
    const b = initial.document.current[1];
    const mutation = new EventMutationService(documents);
    await mutation.mutate("todo.md", (document) =>
      moveEvent(document, b.id, { index: 0 }),
    );
    await mutation.mutate("todo.md", (document) => indentEvent(document, a.id));
    await mutation.mutate("todo.md", (document) =>
      outdentEvent(document, a.id),
    );
    const loaded = await documents.load("todo.md");
    expect(
      loaded.document.current.flatMap((event) => [
        event.id,
        ...event.children.map((child) => child.id),
      ]),
    ).toEqual([b.id, a.id]);
    const removed = await mutation.mutate("todo.md", (document) =>
      document.current[0].id === b.id
        ? { ...document, current: document.current.slice(1) }
        : document,
    );
    expect(removed.current.some((event) => event.id === b.id)).toBe(false);
    const afterDelete = await documents.load("todo.md");
    expect(afterDelete.sidecar?.metadata[b.id]).toBeUndefined();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("serializes consecutive mutations in order", async () => {
    const { workspace, documents } = await fixture();
    await documents.initialize("todo.md");
    const mutation = new EventMutationService(documents);
    const first = mutation.mutate("todo.md", (document) =>
      createEvent(document, { title: "先" }),
    );
    const second = mutation.mutate("todo.md", (document) =>
      createEvent(document, { title: "后" }),
    );
    await Promise.all([first, second]);
    expect(
      (await documents.load("todo.md")).document.current.map(
        (event) => event.title,
      ),
    ).toEqual(["重复", "先", "后"]);
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("supports root tags, notes, deadline and subtree deletion", async () => {
    const { workspace, documents } = await fixture();
    const initial = await documents.initialize("todo.md");
    const root = initial.document.current[0];
    const mutation = new EventMutationService(documents);
    await mutation.mutate("todo.md", (document) => updateTags(document, root.id, ["项目", "紧急"]));
    await mutation.mutate("todo.md", (document) => updateNote(document, root.id, "补充说明"));
    await mutation.mutate("todo.md", (document) => updateDeadline(document, root.id, "2026-09-30"));
    const edited = await documents.load("todo.md");
    expect(edited.document.current[0].tags).toEqual(["项目", "紧急"]);
    expect(edited.document.current[0].note).toBe("补充说明");
    expect(edited.document.current[0].deadline).toBe("2026-09-30");
    await mutation.mutate("todo.md", (document) => deleteEvent(document, root.id));
    const deleted = await documents.load("todo.md");
    expect(deleted.document.current).toHaveLength(0);
    expect(deleted.sidecar?.metadata[root.id]).toBeUndefined();
    await fs.rm(workspace, { recursive: true, force: true });
  });
});
