# Worktrace Writing Conventions

Worktrace Markdown is project state maintained jointly by the user, ordinary editors, and Agents. It records what state the project is in now, not a full account of an individual execution.

## How to read it

1. Users primarily scan Worktrace through hierarchical headings and the markers at the start of those headings.
2. A work-item heading must independently state the subject and its current status, main conclusion, or required action without relying on the body text.
3. Level-one headings represent stable, independently viewable control modules; level-two headings represent outcomes, plans, risks, or decisions the user needs to understand; use level three only when a level-two item genuinely needs subdivision.
4. Body text should add only essential causes, effects, verification gaps, or next steps that the heading cannot carry.

## Free-form markers

1. Use markers at the start of headings to express status or attention, such as `[In progress]`, `[To verify]`, `[High risk]`, or `[Decision needed]`.
2. Markers shown in templates are suggestions suitable for that file, not a fixed vocabulary. Adjust or extend them when the situation calls for it.
3. Use only markers that help the user make decisions; do not pile on labels merely to complete a classification.

## Update principles

1. Update existing work items so their headings and markers reflect the current state; do not append diary-style reports.
2. Prefer changing a marker or heading when that is sufficient. Change body text only when it is inaccurate or lacks an important durable conclusion.
3. Do not mechanically add hierarchy or empty nodes for structural completeness. Replace, adjust, or omit template placeholders as needed.
4. Preserve only state, verification, blockers, decisions, and uncovered work that will remain useful later.
