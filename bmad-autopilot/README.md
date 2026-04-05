# BMAD Autopilot

A CLI tool that automates the [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) Phase 4 implementation cycle end-to-end. It reads your sprint status, determines the next story to work on, invokes the right Claude Code skill, runs quality gates, and loops until the epic/sprint is complete or a HALT condition is triggered — with full visibility via CLI output or a web dashboard.

## Table of Contents

- [How It Works](#how-it-works)
- [Complete Orchestration Flow](#complete-orchestration-flow)
- [Story State Machine](#story-state-machine)
- [Epic Lifecycle](#epic-lifecycle)
- [Quality Gates](#quality-gates)
- [Review Cycle (Fix Loop)](#review-cycle-fix-loop)
- [BMAD Method Compatibility](#bmad-method-compatibility)
- [BMAD Backward Compatibility](#bmad-backward-compatibility)
- [Prerequisites](#prerequisites)
- [Before You Start](#before-you-start)
- [Installation](#installation)
- [Commands](#commands)
- [Web Dashboard](#web-dashboard)
- [Cross-Process Communication](#cross-process-communication)
- [Failure Handling & Deferrals](#failure-handling--deferrals)
- [Run Logs](#run-logs)
- [Visibility Philosophy](#visibility-philosophy)
- [Project Structure](#project-structure)
- [Development](#development)

---

## How It Works

```
sprint-status.yaml  -->  State Machine  -->  Skill Runner  -->  Quality Gates
       ^                                         |                    |
       |                                         v                    v
       +----- updates status <--- Claude Code CLI (skills) ---- pass/halt
```

The orchestrator reads `sprint-status.yaml`, picks the first actionable story, maps its status to a BMAD skill, executes it via Claude Code CLI, streams live output, runs quality gates (test suite + code review severity), verifies the status advanced, and loops.

| Story Status    | Skill Invoked       | Expected Transition     |
|-----------------|---------------------|-------------------------|
| `backlog`       | `bmad-create-story` | `ready-for-dev`         |
| `ready-for-dev` | `bmad-dev-story`    | `review`                |
| `in-progress`   | `bmad-dev-story`    | `review`                |
| `review`        | `bmad-code-review`  | `done` or stays `review` (triggers fix cycle) |

---

## Complete Orchestration Flow

This is the detailed step-by-step flow of what happens when you run `bmad-auto epic 1` or `bmad-auto story 1-4-password-reset`:

### Phase 1: Initialization

```
1. Load BMAD config
   └── Read _bmad/bmm/config.yaml
   └── Resolve {project-root} placeholders to absolute paths
   └── Extract: project_name, implementation_artifacts, output_folder, story_location

1b. Branch protection check
    └── Detect current git branch
    └── If on main/master/develop/production/staging → STOP
    └── Interactive: prompt to create a bmad/* branch
    └── Pipeline: hard stop with suggested branch name

2. Locate sprint status file
   └── Resolve {implementation_artifacts}/sprint-status.yaml
   └── Parse YAML → SprintStatus object
   └── Validate development_status section exists

3. Create run logger
   └── Generate unique run ID (first segment of UUID)
   └── Create log directory: _bmad-output/autopilot-runs/{epic-scope}/
   └── Open JSONL log file: {timestamp}-{runId}.jsonl

4. Initialize live output file
   └── Create _bmad-output/autopilot-runs/.live.jsonl
   └── This ephemeral file enables cross-process dashboard communication

5. Capture test baseline (NEW)
   └── Detect test command (npm test, pytest, etc.)
   └── Run the full test suite BEFORE any work begins
   └── If some tests are already failing, record their names
   └── This baseline is used later so pre-existing failures don't block new stories
```

### Phase 2: Story Selection

```
6. Read sprint-status.yaml
   └── Parse development_status section

7. Apply scope filter
   └── Epic mode: only consider stories matching "N-*" (e.g., epic-1 → "1-*")
   └── Story mode: only consider the specific story key
   └── Run-all mode: consider all stories

8. Find the first actionable story
   └── Walk entries in order (YAML preserves insertion order)
   └── Skip non-story keys (epic-N, *-retrospective)
   └── Skip stories outside the epic filter (if set)
   └── Map status to skill using SKILL_MAP:
       backlog        → bmad-create-story
       ready-for-dev  → bmad-dev-story
       in-progress    → bmad-dev-story
       review         → bmad-code-review
       done           → (skip)
   └── Return the first match as NextAction { storyKey, currentStatus, skill }

9. If no actionable story found → scope complete, exit with outcome: 'complete'
```

### Phase 3: Skill Execution

```
10. Locate the BMAD skill directory (checks per root: project → bmad-root → parent)
    └── v6.2+: {root}/.claude/skills/{skill}/workflow.md
    └── v6.0:  {root}/_bmad/bmm/workflows/4-implementation/{shortName}/instructions.xml
    └── v6.2 _bmad: {root}/_bmad/bmm/4-implementation/{skill}/workflow.md
    └── If not found → HALT with exit 127

11. Build the skill prompt
    └── v6.2+: Read workflow.md directly
    └── v6.0: Combine workflow.yaml (config) + instructions.xml (workflow)
    └── Construct prompt with story key embedded:
        "You are running the BMAD skill '{skill}' for story '{storyKey}'."
        + workflow content
        + "Begin execution now. Target story: {storyKey}"

12. Spawn Claude Code CLI subprocess
    └── Command: claude --dangerously-skip-permissions -p
                       --add-dir {skillDir}
                       --output-format stream-json --verbose
    └── Prompt piped via stdin (avoids shell argument length limits)
    └── Working directory: project root
    └── 30-minute timeout (configurable via --timeout)

13. Stream and parse output in real-time
    └── Each stdout line is a JSON object in Claude's stream-json format
    └── parseStreamLine() handles all wrapper formats:
        - Assistant messages: extract text content
        - Tool use: format as "Read → /path/to/file.ts"
        - Tool results: truncate to 200 chars, show as dimmed text
        - System messages: skip rate_limit_event, show others
        - User messages with tool_result: extract content
    └── Emit events: skill_output, skill_start, skill_complete, skill_error
    └── Write to .live.jsonl for dashboard consumption

14. Handle result
    └── Exit 0 → success, continue to Phase 4
    └── Exit non-0 → retry (up to maxRetries, default 1)
    └── All retries exhausted → HALT
    └── Exit 124 → timeout (killed after timeoutMs)
```

### Phase 4: Status Verification

```
15. Re-read sprint-status.yaml
    └── The skill should have updated the story status via BMAD's own workflow
    └── Load fresh status to see what changed

16. Check for review cycle
    └── If skill was bmad-code-review AND status is STILL 'review':
        → Review found issues that need fixing
        → Autopilot sets status to 'in-progress' (the one BMAD write autopilot does)
        → Loop back to Phase 2 (dev-story will pick it up and fix the issues)
        → See "Review Cycle" section below for details

17. Verify status advanced
    └── If status is unchanged after skill → HALT (stuck state detected)
    └── Log the transition: "✓ {storyKey}: {old} → {new}"
```

### Phase 5: Quality Gates

```
18. Test Suite Gate (after bmad-dev-story → review)
    └── Only runs once per story (skipped on review cycle re-runs)
    └── Detect test command: npm test (package.json) or pytest (pytest.ini/pyproject.toml)
    └── Run the full test suite
    └── Compare failures against baseline captured in Phase 1:
        - Pre-existing failures (in baseline) → ignored, auto-pass
        - NEW failures (not in baseline) → HALT
        - All green → pass
    └── Result written to run log and .live.jsonl

19. Code Review Severity Gate (after bmad-code-review → done)
    └── Read the story file from {story_location}/{storyKey}.md
    └── Scan for severity markers: [Critical], [High], [Medium], [Low]
    └── Critical or High findings → HALT (requires human attention)
    └── Medium/Low only → auto-pass
```

### Phase 6: Loop or Complete

```
20. Loop back to Phase 2 (Story Selection)
    └── Re-read sprint-status.yaml
    └── Find the next actionable story in scope
    └── If none remain → scope complete

21. Cleanup on exit
    └── Remove .live.jsonl (ephemeral, not kept on disk)
    └── Remove signal handlers
    └── Log run_end event with final storiesProcessed count
    └── Print log file path for post-mortem
```

---

## Story State Machine

Each story progresses through a linear state machine. The orchestrator reads the current state, invokes the corresponding skill, and expects the skill to advance the state:

```
  backlog ──────────────> ready-for-dev ──────────────> in-progress
     │                        │                             │
     │  bmad-create-story     │  bmad-dev-story             │  bmad-dev-story
     │  (writes story file)   │  (implements code)          │  (continues dev)
     │                        │                             │
     v                        v                             v
  ready-for-dev           in-progress                    review
                                                           │
                                         bmad-code-review  │
                                         (reviews code)    │
                                                           │
                                        ┌──────────────────┤
                                        │                  │
                                   Issues found        No issues
                                        │                  │
                                        v                  v
                                   in-progress           done
                                   (fix cycle)
```

### Status Definitions

| Status | Meaning | What Happens Next |
|--------|---------|-------------------|
| `backlog` | Story exists in sprint plan but has no story file yet | `bmad-create-story` generates the full story markdown with tasks, acceptance criteria, and technical details |
| `ready-for-dev` | Story file exists, ready for implementation | `bmad-dev-story` reads the story, implements code, writes tests, commits |
| `in-progress` | Development is underway (or resumed after review fixes) | `bmad-dev-story` continues implementation |
| `review` | Code is written, needs review | `bmad-code-review` reviews code quality, security, architecture |
| `done` | Story is complete, all gates passed | Skipped by orchestrator |
| `deferred` | Story failed and was deferred for manual attention | Skipped by orchestrator |

---

## Epic Lifecycle

Epics group related stories. The orchestrator processes stories within an epic sequentially (in YAML order):

```
Epic Flow:
  epic-1: in-progress
    1-1-project-setup:    done          ← already completed
    1-2-auth-middleware:   done          ← already completed
    1-3-user-registration: ready-for-dev ← NEXT: bmad-dev-story
    1-4-password-reset:    backlog       ← waiting (create-story first)
    1-5-session-mgmt:      backlog       ← waiting
```

When you run `bmad-auto epic 1`:

1. Stories are processed **in order** — `1-3` must finish before `1-4` starts
2. Each story goes through the full cycle: create → dev → review → (fix cycle if needed) → done
3. When all stories in the epic reach `done`, the epic run completes
4. Epic-level status (`epic-1: done`) is managed by BMAD skills, not by autopilot

### Story Key Convention

Story keys follow the pattern `{epic-num}-{story-num}-{slug}`:
- `1-4-password-reset` → Epic 1, Story 4
- `27-2-api-refactor` → Epic 27, Story 2

The orchestrator derives the epic from the first segment: `getEpicForStory("1-4-password-reset")` → `"epic-1"`.

---

## Quality Gates

### Test Suite Gate

**When:** After `bmad-dev-story` completes and the story transitions to `review`.

**How it works:**

1. **Baseline capture** — At the start of every run, the orchestrator runs the full test suite and records any pre-existing failures (tests that were already broken before autopilot touched anything).

2. **Gate execution** — After development completes, the test suite runs again:
   - If all tests pass → gate passes
   - If tests fail but ALL failures existed in the baseline → gate passes (pre-existing issues, not caused by this story)
   - If any NEW test failure is detected (not in baseline) → **HALT** — the story introduced a regression

3. **Skip on review cycles** — If a story goes through a review → fix → review loop, the test gate only runs on the first pass. Subsequent cycles skip it (tracked via `testedStories` Set).

**Test command detection:**
- `package.json` with `scripts.test` → `npm test`
- `pytest.ini` or `pyproject.toml` exists → `pytest`
- Neither found → gate skipped (auto-pass)

### Code Review Severity Gate

**When:** After `bmad-code-review` completes.

**How it works:**

1. Locate the story file at `{story_location}/{storyKey}.md` (path from `sprint-status.yaml`)
2. Check for a "Senior Developer Review" or "Review Findings" section
3. Count severity markers: `[Critical]`, `[High]`, `[Medium]`, `[Low]`
4. **Critical or High** → **HALT** (human must review and decide)
5. **Medium or Low only** → auto-pass

---

## Review Cycle (Fix Loop)

When code review finds issues, the orchestrator manages an automatic fix loop:

```
Step 1: bmad-dev-story completes → status moves to 'review'
                                     │
Step 2: Test gate runs (first time only)
        └── Pass → continue
        └── Fail → HALT
                                     │
Step 3: bmad-code-review runs
        └── Status moves to 'done' → story complete!
        └── Status stays at 'review' → issues found, enter fix cycle:
                                     │
Step 4: Orchestrator detects review didn't advance status
        └── Sets status to 'in-progress' ← (the ONE write autopilot makes)
        └── Logs: "Review found issues — cycling back to dev"
                                     │
Step 5: Next loop iteration picks up 'in-progress'
        └── bmad-dev-story runs again to address review findings
        └── Status moves to 'review'
                                     │
Step 6: Test gate is SKIPPED (already passed for this story)
                                     │
Step 7: bmad-code-review runs again
        └── If issues remain → repeat from Step 4
        └── If clean → status moves to 'done'
```

This cycle continues until either the review passes or a HALT condition is triggered.

---

## BMAD Backward Compatibility

BMAD Autopilot is designed to work **with** the BMAD Method, not replace it. It manipulates BMAD files and respects BMAD's file structure:

### What Autopilot Reads (never modifies)

| File | Purpose |
|------|---------|
| `_bmad/bmm/config.yaml` | Project configuration (paths, names, settings) |
| `_bmad/_config/manifest.yaml` | BMAD version detection |
| `sprint-status.yaml` | Story statuses, epic structure, `story_location` field |
| `.claude/skills/*/workflow.md` | Skill workflows — v6.2+ format |
| `_bmad/bmm/workflows/4-implementation/*/instructions.xml` | Skill workflows — v6.0 format |
| `{story_location}/{storyKey}.md` | Story files (read for review gate, dashboard display) |

### What BMAD Skills Write (via Claude Code)

The BMAD skills invoked by autopilot (create-story, dev-story, code-review) are responsible for:
- Creating story files in `{story_location}/`
- Writing code, tests, and commits
- Updating `sprint-status.yaml` with new statuses
- Writing review findings into story files

### The One Write Autopilot Makes

Autopilot makes exactly **one** direct write to `sprint-status.yaml`:

> **`review` → `in-progress`** during the review fix cycle

This is necessary because BMAD's code-review skill doesn't have a "send back for fixes" status transition — it either marks the story `done` or leaves it at `review`. Autopilot detects this and sets it back to `in-progress` so the dev-story skill can pick it up and address the review findings.

### Story File Discovery

Autopilot uses `story_location` from `sprint-status.yaml` to find story files — it never hardcodes paths:

```yaml
# sprint-status.yaml
story_location: _bmad-output/stories   # ← autopilot reads this
```

The dashboard and review gate resolve: `{project-root}/{story_location}/{storyKey}.md`

---

## BMAD Method Compatibility

BMAD Autopilot supports **BMAD Method v6.0.0 and above**, automatically detecting the installed version and adapting to its workflow layout.

| BMAD Version | Layout | Skill Location | Workflow Format |
|---|---|---|---|
| **v6.2+** | `.claude/skills/bmad-{name}/` | `workflow.md` | Markdown |
| **v6.0.x** | `_bmad/bmm/workflows/4-implementation/{name}/` | `workflow.yaml` + `instructions.xml` | YAML + XML |

On startup, the CLI reads `_bmad/_config/manifest.yaml` to detect the version and prints it:

```
  BMAD Method: v6.2.2 (v6.2+ layout)
```

If the version is below 6.0.0 or undetectable, the CLI warns and exits:

```
  ✗ BMAD Method v5.x.x is not supported.
    Minimum required: v6.0.0
    Update BMAD Method: https://github.com/bmad-code-org/BMAD-METHOD
```

The skill runner searches for workflows in this priority order per project root:
1. `.claude/skills/{skill}/` (v6.2+ with `bmad-` prefix)
2. `_bmad/bmm/workflows/4-implementation/{name}/` (v6.0 without prefix)
3. `_bmad/bmm/4-implementation/{skill}/` (v6.2 `_bmad` layout)

---

## Prerequisites

- **Node.js** >= 20.0.0
- **Claude Code CLI** installed and configured (`claude` command available)
- A project set up with the **BMAD Method v6.0+** (has `_bmad/bmm/config.yaml` and `sprint-status.yaml`)

## Before You Start

### 1. Epics must be in `sprint-status.yaml`

BMAD Autopilot reads **only** from `sprint-status.yaml` to discover epics and stories. If you've defined new epics in your planning artifacts (e.g., `epics.md` or a separate epic file) but haven't run sprint planning, **they won't appear** in the dashboard or CLI.

Before running autopilot on new epics, generate the sprint status entries first:

```bash
# In Claude Code, run the BMAD sprint planning skill:
/bmad:bmm:workflows:sprint-planning
```

This reads your epic definitions and adds entries to `sprint-status.yaml`:

```yaml
# === Epic 28: Document Intelligence Pipeline ===
epic-28: backlog
28-1-document-parser-service: backlog
28-2-ocr-integration: backlog
28-3-classification-engine: backlog
```

Once the entries exist in `sprint-status.yaml`, autopilot picks them up immediately:

```bash
bmad-auto epics                    # verify they show up
bmad-auto epic 28                  # start working on it
```

### 2. Branch protection

Autopilot **refuses to run on protected branches** (`main`, `master`, `develop`, `production`, `staging`). This prevents polluting your repo with automated commits.

When you run on a protected branch, autopilot prompts you to create a new branch:

```
  🛑 You are on 'main' — autopilot refuses to work on protected branches.

  Suggested branch: bmad/epic-28/quantum-falcon

  Create this branch and continue? [Y/n/custom name]:
```

- Press **Enter** or **Y** to accept the suggested branch
- Type a **custom name** to use your own
- Press **n** to cancel

Branch names are auto-generated with a `bmad/` prefix so you can easily identify autopilot work:
- `bmad/epic-1/cosmic-phoenix`
- `bmad/epic-28/blazing-nexus`
- `bmad/stellar-odyssey` (when no epic scope)

In CI/pipeline mode (`--no-interactive`), the branch is created automatically — no prompt needed.

## Installation

### From npm (when published)

```bash
npm install -g bmad-autopilot
```

Then run from any BMAD project directory:

```bash
bmad-auto epics
bmad-auto epic 1
```

### From source

```bash
git clone https://github.com/bmad-code-org/bmad-autopilot.git
cd bmad-autopilot
npm install
npm run build
npm link
```

### One-shot with npx (when published)

```bash
npx bmad-autopilot epics
npx bmad-autopilot epic 1
```

## Commands

### `bmad-auto epics`

List all epics with names, progress bars, and next actions.

```bash
bmad-auto epics
bmad-auto epics -p /path/to/project
```

Output:
```
  BMAD Autopilot — My Project

  🔄 epic-1  Project Foundation & Auth
     ████████████░░░░░░░░ 3/5 (60%) → next: bmad-dev-story
  ✅ epic-2  Payment Integration
     ████████████████████ 4/4 (100%)
  ⏳ epic-3  Reporting Dashboard
     ░░░░░░░░░░░░░░░░░░░░ 0/6 (0%) → next: bmad-create-story

  Overall: 7/15 stories (47%)
```

### `bmad-auto epic <key>`

Run all stories in an epic through the full cycle until the epic is complete or a HALT is triggered.

```bash
# Run epic 1 (accepts "1" or "epic-1")
bmad-auto epic 1

# With web dashboard
bmad-auto epic 1 --dashboard

# Dry run — shows what would execute
bmad-auto epic 1 --dry-run

# Custom timeout per skill
bmad-auto epic 1 --timeout 3600000

# Specify project root
bmad-auto epic 1 -p /path/to/project
```

### `bmad-auto story <key>`

Run a specific story through its full cycle until done or HALT.

```bash
# Run a specific story
bmad-auto story 1-4-password-reset

# With dashboard
bmad-auto story 1-4-password-reset --dashboard
```

The story command loops until the story reaches `done`:
- If the story is at `backlog` → runs create → dev → review → done
- If the story is at `in-progress` → runs dev → review → done
- If the story is already `done` → exits immediately

### `bmad-auto run`

Run all pending stories across all epics through the BMAD pipeline.

```bash
bmad-auto run
bmad-auto run --dry-run
bmad-auto run --dashboard --port 8080
```

### `bmad-auto status`

Show current sprint status grouped by epic.

```bash
bmad-auto status
bmad-auto status --epic 1
bmad-auto status -p /path/to/project
```

Output:
```
  BMAD Autopilot — Sprint Status

  Project: my-project

  🔄 epic-1 (3/5)
    ✅ 1-1-project-setup: done
    ✅ 1-2-auth-middleware: done
    🔄 1-3-user-registration: in-progress
    📋 1-4-password-reset: ready-for-dev
    ⏳ 1-5-session-mgmt: backlog

  Next: bmad-dev-story → 1-3-user-registration
```

### `bmad-auto dashboard`

Start the web dashboard as a standalone viewer. Connect it to a running `bmad-auto epic` or `bmad-auto run` in another terminal.

```bash
bmad-auto dashboard
bmad-auto dashboard --port 8080
```

Then open `http://localhost:3141` in your browser.

### Common Options

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --project-root <path>` | Current directory | Path to the BMAD project root |
| `--dry-run` | `false` | Print planned actions without executing |
| `--dashboard` | `false` | Start web dashboard alongside the run |
| `--port <port>` | `3141` | Web dashboard port |
| `--timeout <ms>` | `1800000` | Timeout per skill invocation (30 min) |

---

## Web Dashboard

The dashboard at `http://localhost:3141` provides:

- **Sprint Board** — Click any story to expand and see:
  - User story description
  - Task checklist with done/todo highlighting
  - Acceptance criteria
  - Related git commits (hash, message, author, date)
- **Current Activity** — Live human-readable output from the running skill with a spinner, showing tool calls, Claude responses, and results as they stream
- **Quality Gates** — Test suite and code review gate results (pass/fail)
- **Live Log** — Full event stream with timestamps
- **Status Bar** — Running/complete/halted state, story count, elapsed timer

The dashboard is dark-themed (GitHub-style), zero-dependency (single HTML page served from Node's built-in `http` module), and works on any browser.

### SSE Auto-Reconnect

The dashboard connects via Server-Sent Events (SSE). If the connection drops (network blip, server restart), it automatically reconnects after 3 seconds and receives the current state including recent activity.

---

## Cross-Process Communication

When running the CLI and dashboard in separate terminals, they communicate via a shared file:

```
Terminal 1:  bmad-auto epic 1 -p /path/to/project
Terminal 2:  bmad-auto dashboard -p /path/to/project
```

**How it works:**

1. The orchestrator writes events to `_bmad-output/autopilot-runs/.live.jsonl`
2. The dashboard polls this file every 500ms for new lines
3. Events include: `skill_start`, `output`, `skill_complete`, `skill_error`
4. The dashboard translates these into human-readable activity display
5. When the run completes, `.live.jsonl` is automatically deleted (ephemeral)

The dashboard also polls `sprint-status.yaml` every 10 seconds as a fallback to detect status changes.

---

## Failure Handling & Deferrals

When a story fails, the behavior depends on the mode:

### Interactive Mode (default when TTY)

On failure, the CLI prompts:
```
  Story 1-4-password-reset failed: skill exited with code 1
  [F]ix manually, [S]kip (defer), [H]alt pipeline?
```

- **Fix** — Pauses and waits for you to fix manually, then retries
- **Skip** — Defers the story to `deferred-work.md` and continues to the next story
- **Halt** — Stops the pipeline

### Pipeline Mode (`--no-interactive` or CI)

All failures are auto-deferred — the story is logged to `deferred-work.md` and the pipeline continues to the next story. The run ends with `complete_with_deferrals` outcome showing exactly which stories need attention:

```
  epic-15 has 1 deferred story(ies) that need attention:
    ⏭ 15-4-mentions-and-notifications

  See deferred-work.md for details.
  To continue, fix the issue then update sprint-status.yaml:
    Change status from deferred → ready-for-dev and re-run:
    bmad-auto story 15-4-mentions-and-notifications

  Or use Claude Code with BMAD Method to fix manually:
    /bmad:bmm:workflows:dev-story <story-file>
```

### Failure Points

| Condition | Trigger | Interactive | Pipeline |
|-----------|---------|-------------|----------|
| **Skill failure** | Skill exits non-0 | [F]/[S]/[H] prompt | Auto-defer |
| **Stuck state** | Status unchanged after skill | [F]/[S]/[H] prompt | Auto-defer |
| **Test gate** | New test failures (gate mode dependent) | [F]/[S]/[H] prompt | Auto-defer |
| **Review gate** | BMAD review triage indicates issues | [F]/[S]/[H] prompt | Auto-defer |
| **Review cycles** | Max review cycles exceeded (default: 3) | [F]/[S]/[H] prompt | Auto-defer |
| **Timeout** | Skill exceeds timeout (default: 30 min) | Auto-halt | Auto-defer |
| **Interrupt** | Ctrl+C (SIGINT/SIGTERM) | Graceful shutdown | Graceful shutdown |

### Gate Modes (`--gate-mode`)

| Mode | Behavior |
|------|----------|
| `strict` | Any new test failure triggers the gate |
| `balanced` | 3+ new failures trigger the gate (default) |
| `lenient` | Warn only, never block |

---

## Run Logs

Every run writes a structured JSONL log file scoped by epic:

```
_bmad-output/autopilot-runs/
  epic-1/
    2026-04-03T10-30-00-a1b2c3d4.jsonl
    2026-04-03T14-15-00-e5f6g7h8.jsonl
  epic-8/
    2026-04-03T11-00-00-i9j0k1l2.jsonl
  .live.jsonl                              ← ephemeral, deleted on run end
```

Each line is a JSON object with `ts`, `event`, and event-specific fields:

| Event | Fields | When |
|-------|--------|------|
| `run_start` | `projectRoot`, `dryRun`, `epic`, `story` | Run begins |
| `test_baseline` | `preExistingFailures` | After initial test suite capture |
| `action_selected` | `skill`, `story`, `status` | Story picked for execution |
| `skill_result` | `skill`, `story`, `exitCode`, `durationMs` | Skill finishes |
| `retry` | `skill`, `story`, `attempt` | Retrying a failed skill |
| `gate` | `gate`, `passed`, `details` | Quality gate result |
| `review_cycle` | `story` | Review → in-progress transition |
| `halt` | `reason`, `story` | Run stopped |
| `sprint_complete` | `storiesProcessed`, `epic`, `story` | Scope finished |
| `run_end` | `storiesProcessed` | Run cleanup |

---

## Visibility Philosophy

BMAD Autopilot is built around the principle that **you should always see what's happening**:

1. **Streaming output** — The skill runner uses `spawn` (not `execFileSync`) so every line of Claude's output streams to both the CLI and web dashboard in real-time
2. **No black boxes** — Every skill invocation, retry, quality gate, and status transition is logged and visible
3. **Structured run logs** — Every run writes JSONL scoped by epic for post-mortem analysis
4. **Click to inspect** — Stories in the web dashboard are clickable, showing description, tasks, and related commits
5. **Human-readable activity** — Tool calls display as `Read → /src/auth.ts`, not raw JSON
6. **Baseline transparency** — Pre-existing test failures are logged at run start so you know exactly what was broken before autopilot touched anything

---

## Project Structure

```
bmad-autopilot/
  src/
    cli.ts           # Commander CLI — epics/epic/story/run/status/dashboard commands
    orchestrator.ts   # Main loop: status → skill → gates → loop
    state.ts          # Sprint status YAML parser + state machine + epic helpers
    runner.ts         # Claude CLI spawn with streaming output + events
    gates.ts          # Test suite (with baseline) + code review quality gates
    logger.ts         # Structured JSONL run logging (scoped by epic)
    dashboard.ts      # Web dashboard: HTTP server + SSE + inline HTML
    config.ts         # BMAD project config loader
    types.ts          # TypeScript type definitions
  tests/              # vitest test suite (44 tests)
  dist/               # Built ESM output (tsup)
```

## Development

```bash
cd bmad-autopilot
npm install
npm run dev           # Run CLI via tsx (no build needed)
npm test              # Run test suite
npm run test:watch    # Watch mode
npm run build         # Build with tsup
```

## License

MIT
