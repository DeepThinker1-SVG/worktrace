---
name: workboard-workflow
description: Maintain Worktrace project state during substantive development, investigation, verification, and task closing. Use it to create a window-local CURRENT, update PROJECT-STATUS when project-level progress, priorities, risks, decisions, or user actions change, and maintain VERIFY, CHANGE, DECISIONS, CODE-MAP, or RETROSPECTIVE when a task specifically needs them. Do not use it for simple questions or one-off read-only checks with no durable state change.
---

# Worktrace Workflow

Treat Worktrace as a user-facing view of current project state, not an execution log. Compress events into state, complexity into clear titles, and execution details into items that need user attention.

## Sources and locations

- Store Worktrace state files under `workboard/`.
- Treat `.workboard/` as protocol, template, and application configuration storage.
- Read `AGENTS.md` and `.workboard/PROTOCOL.md` before the first Worktrace update in a window.
- Read the matching template when creating a file. When updating an existing file, preserve its structure and user edits.

## CURRENT

- Create one independent `workboard/CURRENT.<scope>.md` for each Codex window doing substantive work.
- Check only whether the intended filename already exists. Do not search, read, or reuse another window's CURRENT.
- Keep updating the same CURRENT within the window.
- Record the window's goal, meaningful progress, risks, decisions, verification state, and next step.
- Update it after meaningful state changes and before finishing the task.

## PROJECT-STATUS

- Update `workboard/PROJECT-STATUS.md` when work materially changes project-level progress, priorities, risks, decisions, or actions needed from the user.
- Read its current content first and update only the nodes this window can confirm.
- Preserve user and concurrent changes. Do not copy CURRENT wholesale or replace global state with a window-local conclusion.

## Other files

Create or update VERIFY, CHANGE, DECISIONS, CODE-MAP, or RETROSPECTIVE only when the task specifically needs that artifact.

## Decide what to record

Record information only when it affects the user's understanding of current state, next steps, risks, decisions, verification, or required action. This includes meaningful state or plan changes, durable decisions, relevant risks or blockers, resolved risks that change the current picture, work needing user judgment or acceptance, and work that must be split or paused.

Do not record files read, commands run, line counts, temporary investigation paths, discarded guesses, execution logs, completion-report copies, or details recoverable from code or Git.

## Update efficiently

- Follow `.workboard/PROTOCOL.md` for headings, free-form markers, and body format.
- Make each work-item title express its subject and current state or conclusion.
- Prefer changing a marker or title when that is enough.
- Change body text only when it is inaccurate or missing a durable conclusion.
- Do not append diary entries or spend tokens rewriting, merging, or deleting content only for stylistic cleanup.
- Distinguish modifications, automated checks, real runtime verification, user acceptance, and uncovered work.
- Record user acceptance only after the user explicitly confirms it.

## Boundaries

- Do not delete, archive, or register Worktrace files unless explicitly requested.
- Do not edit `.workboard/workspace.json` to register files.
