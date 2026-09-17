# Worktrace

[简体中文](README.zh-CN.md)

Worktrace is a local-first desktop work planner for turning everyday work into clear, structured plans.

Create a plan, break work into nested events, and keep its progress, notes, tags, deadlines, and history together in one place. Your data stays as ordinary Markdown in a folder you control.

## Plan work without losing context

Worktrace is designed for work that evolves while it is being done:

- Create plans and build nested event trees.
- Set statuses, tags, notes, creation dates, completion dates, and deadlines.
- Move, indent, outdent, archive, or delete events as a plan changes.
- See the same plan as a workboard, timeline, calendar, or statistics view.

## Views for the question at hand

### Workboard

Organize current and closed events in a focused hierarchy. Search, filter by status or tag, and edit an event without leaving the plan.

### Timeline

Review meaningful changes, including created events and updates to titles, notes, statuses, tags, and deadlines.

### Calendar

See when work was created, completed, or due. Deadlines are clearly distinguished from other dates.

### Statistics

Get an at-a-glance view of active work, completed work, blockers, tag use, and recent activity trends.

## Local files, not a proprietary silo

Choose a local workspace and create or open a work plan. Worktrace stores the plan as Markdown and maintains its event metadata alongside it, so the source remains portable and yours.

You can also browse and open Markdown files from the workspace, manage which directories are watched, and keep useful files visible in separate windows.

## Get started

1. Open Worktrace.
2. Select a local workspace, or open an existing Markdown plan.
3. Create a new work plan and add your first event.
4. Use the workboard to update work as it happens; switch to Timeline, Calendar, or Statistics when you need a different perspective.

## Download

Worktrace currently provides a Windows x64 installer. Download the latest version from [GitHub Releases](../../releases/latest).

## Development

Requires Node.js 20 or newer.

```bash
npm ci
npm start
```

Run the full verification suite:

```bash
npm run verify
```

## License

[MIT](LICENSE)
