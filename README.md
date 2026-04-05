# BMAD Auto

Automation tooling for the [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) — a CLI that orchestrates Phase 4 implementation end-to-end using Claude Code skills.

## The Pipeline

BMAD Auto turns a sprint backlog into shipped code through a six-phase loop that runs unattended until the sprint is done or a quality gate fires:

```
sprint-status.yaml ──> Story Selection ──> Skill Execution ──> Quality Gates
        ^                                        |                   |
        |                                        v                   v
        +──── status update <──── Claude Code CLI (skills) ──── pass / halt
```

**How it works:** The orchestrator reads `sprint-status.yaml`, picks the first actionable story, maps its status to a BMAD skill (`bmad-create-story`, `bmad-dev-story`, or `bmad-code-review`), spawns it via the Claude Code CLI with streamed output, then runs quality gates — a test-suite gate that ignores pre-existing failures and a code-review severity gate that halts on Critical/High findings. If the code review finds issues, the orchestrator automatically sets the story back to `in-progress` and re-runs `bmad-dev-story` with targeted cycle context (only the unresolved findings and changed files), looping until the review passes or a max-cycle limit is reached. Once a story is done, the next one is picked up and the loop continues.

**Token efficiency is a first-class concern.** Each skill invocation receives only the minimal context it needs — the story key, the workflow definition, and (in fix cycles) a capped 2K-char extract of review findings plus a diff of changed files. The companion `bmad-distillator` skill compresses planning documents down to dense, LLM-optimized distillates at roughly a 3:1 token ratio (e.g. 15K tokens of prose becomes ~5K tokens of structured bullets) with lossless information preservation. Test baselines are captured once at run start so gate checks are a simple diff, not a full re-analysis. The result: a complete create-develop-review cycle for a typical story runs in 3-4 skill invocations, each operating well within a single context window, with no redundant re-reading of project docs between steps.

## What's Inside

- **`bmad-autopilot/`** — The core CLI tool. Reads sprint status, picks the next story, invokes the right Claude Code skill, runs quality gates, and loops until the sprint is done or a HALT is triggered.
- **`_bmad/`** — BMAD Method configuration, core prompts, and skill definitions.
- **`_bmad-output/`** — Generated artifacts from autopilot runs (gitignored, user-specific).

## Quick Start

```bash
# Install dependencies and build
npm run setup

# Run the autopilot from a BMAD project
bmad-auto run
```

Requires **Node.js >= 20** and **Claude Code CLI** installed and authenticated.

## CLI Usage

```bash
# List all epics with progress bars
bmad-auto epics

# Run all stories in an epic
bmad-auto epic 1

# Run a specific story
bmad-auto story 1-4-password-reset

# Run all pending stories across all epics
bmad-auto run

# Show sprint status
bmad-auto status
```

### Terminal UI (TUI)

Launch a full-screen interactive sprint board with live output, keyboard navigation, and real-time status updates:

```bash
bmad-auto epic 1 --tui
```

Use `Tab` to switch panels, arrow keys to navigate stories, `Enter` to expand details, and `G` to jump to the latest output.

### Web Dashboard

Start a browser-based dashboard alongside any run:

```bash
bmad-auto epic 1 --dashboard
# Then open http://localhost:3141

# Or run standalone in a separate terminal:
bmad-auto dashboard -p /path/to/project
```

See [`bmad-autopilot/README.md`](bmad-autopilot/README.md) for full command reference, options, and architecture details.

## Contributing

### Setup

```bash
git clone https://github.com/bmad-code-org/bmad-autopilot.git
cd bmad-auto
npm run setup
```

### Development Workflow

```bash
cd bmad-autopilot

# Run in dev mode (no build step)
npm run dev

# Run tests
npm test

# Watch mode for tests
npm run test:watch

# Build
npm run build
```

### Project Structure

```
bmad-autopilot/
  src/
    cli.ts          # Entry point
    orchestrator.ts # Main loop
    runner.ts       # Skill execution
    gates.ts        # Quality gate checks
    state.ts        # Sprint state management
    config.ts       # Configuration loading
    dashboard.ts    # Live CLI dashboard
    logger.ts       # Structured logging
    types.ts        # TypeScript types
    ui/             # Ink React components
  tests/            # Vitest test suites
```

### Guidelines

- **TypeScript** — strict mode, no `any` unless truly unavoidable.
- **Tests** — add or update tests for any behavior change. Run `npm test` before pushing.
- **Commits** — use clear, descriptive commit messages. One logical change per commit.
- **PRs** — keep them focused. Link to an issue if one exists. Include a brief summary of what changed and why.

### CI

Pull requests are automatically checked for:

- TypeScript type checking
- Build verification
- Test suite (vitest)

All checks must pass before merging.

## License

MIT
