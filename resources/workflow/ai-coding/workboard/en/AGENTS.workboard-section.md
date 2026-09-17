# Agent Working Principles

## General Collaboration Principles

* Use the user's current goal, the existing code, and the Git state as the source of truth. Do not speculate about the final architecture or expand the task on your own.
* Before starting a non-local or complex task, assess the relevant code, workspace, and Git state. If the current state is unsuitable for continuing, explain the risk and recommend committing, splitting the work, or confirming the direction together first.
* When a complex situation could affect the product, architecture, or implementation direction, pause and explain the current state, options, and reasoning so the decision can be made with the user.
* Prefer simple, local, verifiable solutions. Protect existing work, do not implement the next phase early, and do not refactor unrelated code incidentally.
* You may point out clear code problems, architectural concerns, or future risks discovered during implementation, but do not expand the change without confirmation.
* Completion reports should clearly and concisely state what was completed, key changes, verification results, unverified areas, discovered issues, and anything that still requires user judgment.

## Worktrace Collaboration

* Substantive development, investigation, and verification tasks must follow the project's `workboard-workflow` Skill.
