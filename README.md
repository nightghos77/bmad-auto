# BMAD Auto

Automation tooling for the [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) — a CLI that orchestrates Phase 4 implementation end-to-end using Claude Code skills.

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
