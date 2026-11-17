# Skills

A skill is a named set of instructions a team writes once and reuses on any of its canvases, the
way it reuses a custom agent. A person calls one by writing `/handle` in the request
(`/brand-check tighten the hero`), and the agent that runs the work gets the skill's instructions
for that run. GitHub issue #380. Agreed with the maintainer as the split from custom agents
(#380 thread, Nov 2026): agents are _who_ does the work, skills are _how_.

## Why

`@doop` and the custom agents carry one fixed brief each. Teams repeat the same long instructions
("check against our brand rules: …", "write the release-notes card like this: …") in prompt after
prompt. A skill lets them write those once, give them a short name, and ask for them by name from
any canvas, with any agent.

## Goals

- A workspace (or a person, for their personal canvases) creates, edits and deletes skills in
  the settings, beside its custom agents.
- `/handle` in a composer card, a comment addressed to an agent, or an automation's agent prompt
  adds that skill's instructions to the run. Several `/handle`s add several skills.
- Works with every agent on the canvas's team (built-in and custom) and every runner (API model
  and the local Claude Code harness).

## Non-goals (this PR)

- The agent choosing a skill by itself (a `use_skill` tool and a skills list in the system
  prompt). Next PR; this one's storage and settings are what it builds on.
- Autocomplete or a picker for `/` in the composer. Follow-up; nothing here blocks it.
- MCP access for external agents (`list_skills` / `get_skill`).
- Files, scripts or assets inside a skill. A skill is markdown text only.
- Sharing skills between workspaces, a public catalogue, versions.

## Anti-goals

- A `/handle` that names no skill must never change what the run does. The text stays as written
  and goes to the agent as it always has.
- Paths and URLs in a request (`/c/abc`, `https://x.com/brand`) must not be read as skills.
- A skill's text is never sent to a canvas's viewers (the canvas GET, the room), the same rule
  `teamOfCanvas` keeps for agent briefs. Anyone who can queue work for an agent (share-link
  commenters, Slack and Linear authors) can name a skill, exactly as they can already address a
  custom agent whose brief shapes the reply; skills add no gate custom agents lack. (Builder's
  call, matching the existing posture.)

## Approaches considered

- **A. Parse `/handle` from the work text on the server at run time (picked).** No change to the
  composer, the task API or the task schema; comments and automations get it for free because the
  resident agent already joins all of them into one `workText`. Cost: people have to know the
  handle, as with `@mentions` today.
- B. The composer resolves `/handle` and sends skill ids on the card (a `tasks.skills` column).
  Explicit, but more layers to change, and comments and automations would not get it without the
  same work again.
- C. A skill picker in the composer. Most discoverable, most UI, and still needs A or B under it.
  Left as the follow-up to A.

## Model (`shared/skills.ts`)

- `Skill { handle, description, body, createdAt, updatedAt }` in an `AgentScope` (the type from
  `shared/customAgents.ts`: `{ workspaceId } | { personal: true }`).
- `handle`: `^[a-z][a-z0-9-]{1,31}$`, unique per scope, fixed once created (queued work may name
  it). Hyphens are allowed (`brand-check`), unlike agent handles.
- `description`: one line, 1 to 120 characters, no control characters. Shown in settings; becomes
  the list the agent reads in the bot-invoked follow-up.
- `body`: markdown, 20 to 8000 characters.
- `MAX_SKILLS` 50 per scope.
- `parseSkillInput` / `parseSkillPatch` return `Parsed<T>` like `parseCustomAgentInput`.
- `skillHandlesIn(text): string[]`: every `/handle` in the text that starts the text or follows
  whitespace or `(`, and ends at whitespace, the end, or one of `.,;:!?)`. Order of first
  appearance, no duplicates. It only finds candidates; the server keeps the ones the scope has.

## Storage (`server/skills.ts`)

- Table `skills` (`id`, `scope`, `handle`, `description`, `body`, `created_by`, `created_at`,
  `updated_at`), unique index on (`scope`, `handle`), `scope` keyed `ws:<id>` / `user:<id>` as in
  `custom_agents`. Next free migration number, generated with drizzle-kit.
- Mirrored in memory at boot (`hydrateSkills()` beside `hydrateCustomAgents()` in
  `server/index.ts`), database written before the mirror, writes queued per scope: the same shape
  as `server/customAgents.ts`, copied rather than shared (two small modules read more plainly
  than one generic one).
- `skillsForCanvas(canvas)`: the workspace's skills, else the owner's, as `customAgentsForCanvas`.
- Workspace deletion and account deletion drop the scope's skills (`dropWorkspaceSkills` in
  `server/workspaces.ts`, `dropPersonalSkills` in `server/accountDeletion.ts`).

## API (`server/skillRoutes.ts`, mounted at `/api/skills`)

`GET /`, `POST /`, `PATCH /:handle`, `DELETE /:handle`, `?workspace=<id>` for a workspace's
skills (members only), without it the signed-in person's own. Same membership check, error
shape and 400/403/500 messages as `customAgentRoutes.ts`. Any workspace member may change them,
as with custom agents. No realtime broadcast: nothing on the canvas shows skills yet.

## The run (`server/resident.ts`)

- After `workText` is built, `requestedSkills = skillHandlesIn(skillText)` matched against
  `skillsForCanvas(canvas)`, where `skillText` is `workText` plus each feedback item's `about`
  (the task it follows up) and each comment's earlier thread messages, so "make it bigger" after
  a `/brand-check` task keeps the skill. Resolved when the run starts, so a skill edited while work waits in
  the queue runs as edited, and one deleted meanwhile is ignored.
- When any match, one more system block after the guidelines block:
  `# Skills requested for this work` followed by, for each, `## /<handle>: <description>` and
  the body, with a line saying the person asked for these by name and they apply to this work.
  Both paths get it: the `model.run` system list (with `cache: true`) and the joined string for
  `model.runHarness`.
- The request text keeps its `/handle`s, so the agent sees which part of the request each skill
  is for.
- At most `MAX_SKILLS_PER_RUN` 5 skills per run, first five in order; the rest are left as text.
- A skill applies to the whole run. One run takes every open card, comment and follow-up of one
  payer on the canvas, and every pipeline stage of a card, so `/brand-check` on one card also
  reaches the others in that run. Accepted: requests batched into one run are usually related,
  and scoping per request would mean labelling every block. (Builder's call; per-request scoping
  is the upgrade if it bites.)
- An automation step's card text includes earlier steps' summaries, so a summary that quotes
  `/brand-check` re-applies that skill to the next step. Accepted as harmless: the step's owner
  wrote that skill for this team.
- GitHub-import cards (`runRepoCards`) never reach `workText` and get no skills.

## Settings UI (`src/components/Skills.tsx`)

- A `SettingsCard` placed right after `<CustomAgents />` in `src/pages/Workspace.tsx` (with
  `workspaceId`) and `src/pages/Settings.tsx` (personal), built from the same primitives as
  `CustomAgents.tsx`: a list of skills (`/handle` and description), an empty state, "New skill",
  edit and delete (confirm dialog) on each row.
- The form is a `Modal` with Handle (create only), Description and Instructions (a `Textarea`),
  with the limits above and the server's error shown under the form.
- One caption line on the card says how to use a skill: "Write /handle in a request to use it."
- Strings in a new `skills` catalog namespace, English and Brazilian Portuguese (`pt-BR` is typed
  against English, so a missing key fails typecheck).
- `api.skills` / `createSkill` / `updateSkill` / `deleteSkill` in `src/lib/api.ts`.

## Tests

- `tests/skills.test.ts`: `parseSkillInput` limits; `skillHandlesIn` finds `/brand-check` at the
  start, mid-sentence, before punctuation and in parentheses, and skips `/c/abc`,
  `https://x.com/brand`, `a/b` and `//x`; duplicates kept once.
- A follow-up whose `about` named `/brand-check` still gets the skill.
- `tests/skillsHttp.test.ts`: CRUD per scope, a non-member gets 403, a duplicate handle 400,
  the 51st skill 400, deleting a workspace drops its skills.
- A resident case: a run whose card says `/brand-check …` gets the skill's body in its system
  prompt, a run with an unknown `/nope` gets no skills block, and a skill from another workspace
  never reaches the run.

## Docs

A `Skills` entry in `.context/TECHSTACK.md` §2 (files, route, the `/handle` rule, tests), and this
spec in `.context/specs/INDEX.md`.

## Left to the builder

Exact wording of the system block and UI copy, the migration number, component layout inside
the card, and whether the handle field shows a live `/handle` preview.
