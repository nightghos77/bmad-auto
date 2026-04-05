#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { loadConfig, detectBmadVersion } from './config.js';
import { orchestrate } from './orchestrator.js';
import { loadSprintStatus, getNextAction, getEpicKeys, getEpicStories, parseEpicNames, parseEpicDescriptions, humanizeStoryKey, isStoryKey } from './state.js';

const program = new Command();

program
  .name('bmad-auto')
  .description('Automate the BMAD Method Phase 4 implementation cycle')
  .version('0.1.0');

/**
 * Print BMAD version info for the target project. Warns if unsupported.
 * Returns false if version is unsupported (caller should exit).
 */
function checkBmadVersion(projectRoot: string): boolean {
  const info = detectBmadVersion(projectRoot);
  if (info.version === 'unknown') {
    console.log(chalk.yellow(`\n  ⚠ Could not detect BMAD Method version in ${projectRoot}`));
    console.log(chalk.yellow('    Make sure _bmad/_config/manifest.yaml exists.'));
    console.log(chalk.dim('    Install or update BMAD Method: https://github.com/bmad-code-org/BMAD-METHOD\n'));
    return false;
  }
  console.log(chalk.dim(`  BMAD Method: v${info.version} (${info.format} layout)`));
  if (!info.supported) {
    console.log(chalk.red.bold(`\n  ✗ BMAD Method v${info.version} is not supported.`));
    console.log(chalk.red(`    Minimum required: v6.0.0`));
    console.log(chalk.cyan('    Update BMAD Method: https://github.com/bmad-code-org/BMAD-METHOD\n'));
    return false;
  }
  return true;
}

/**
 * Wire up verbose console event listeners for terminal output.
 */
async function wireVerboseOutput() {
  const { orchestratorEvents } = await import('./orchestrator.js');
  const { runnerEvents } = await import('./runner.js');

  orchestratorEvents.on('log', (msg: string) => {
    const ts = new Date().toLocaleTimeString();
    if (msg.includes('HALT')) {
      console.log(chalk.red(`  ${ts}  ${msg}`));
    } else if (msg.includes('✓') || msg.includes('complete')) {
      console.log(chalk.green(`  ${ts}  ${msg}`));
    } else {
      console.log(chalk.dim(`  ${ts}  `) + msg);
    }
  });

  runnerEvents.on('skill_start', (d: { skill: string; storyKey: string }) => {
    console.log(chalk.cyan.bold(`\n  ▶ ${d.skill} → ${d.storyKey}`));
  });

  runnerEvents.on('skill_output', (d: { line: string; type: string }) => {
    const line = d.line;
    if (d.type === 'tool') {
      console.log(chalk.magenta(`    ${line}`));
    } else if (d.type === 'assistant') {
      const display = line.length > 200 ? line.slice(0, 200) + '...' : line;
      console.log(chalk.white(`    ${display}`));
    } else if (d.type === 'stderr') {
      console.log(chalk.red(`    ${line}`));
    } else if (d.type === 'result') {
      console.log(chalk.green(`    ${line}`));
    } else if (d.type === 'tool_result') {
      const display = line.length > 150 ? line.slice(0, 150) + '...' : line;
      console.log(chalk.dim(`    ${display}`));
    } else if (line.trim()) {
      console.log(chalk.dim(`    ${line}`));
    }
  });

  runnerEvents.on('skill_complete', (d: { skill: string; storyKey: string; durationMs: number }) => {
    console.log(chalk.green.bold(`  ✓ ${d.skill} completed in ${Math.round(d.durationMs / 1000)}s\n`));
  });

  runnerEvents.on('skill_error', (d: { skill: string; exitCode: number; stderr?: string }) => {
    console.log(chalk.red(`  ✗ ${d.skill} failed (exit ${d.exitCode})`));
    if (d.stderr) {
      const lines = d.stderr.split('\n').slice(-5);
      for (const line of lines) {
        if (line.trim()) console.log(chalk.red.dim(`    ${line}`));
      }
    }
  });

  orchestratorEvents.on('gate', (r: { gate: string; passed: boolean; details: string }) => {
    if (r.passed) {
      console.log(chalk.green(`  ✓ Gate [${r.gate}]: ${r.details}`));
    } else {
      console.log(chalk.red.bold(`  ✗ Gate [${r.gate}]: ${r.details}`));
    }
  });
}

/**
 * Print the orchestrator result summary.
 */
function printResult(result: { outcome: string; storiesProcessed: number; storiesDeferred?: number; haltReason?: string; lastStory?: string; deferredStories?: string[] }, scope: string) {
  if (result.outcome === 'complete' && result.storiesProcessed > 0) {
    console.log(chalk.green.bold(`\n  ${scope} complete! ${result.storiesProcessed} stories processed.`));
  } else if (result.outcome === 'complete' && result.storiesProcessed === 0) {
    console.log(chalk.green.bold(`\n  ${scope} — nothing to do. All stories are already done.`));
  } else if (result.outcome === 'complete_with_deferrals') {
    const deferrals = result.storiesDeferred || 0;
    if (result.storiesProcessed === 0) {
      console.log(chalk.yellow.bold(`\n  ${scope} has ${deferrals} deferred story(ies) that need attention:`));
    } else {
      console.log(chalk.yellow.bold(`\n  ${scope} complete with ${deferrals} deferral(s). ${result.storiesProcessed} stories processed.`));
    }
    if (result.deferredStories?.length) {
      for (const ds of result.deferredStories) {
        console.log(chalk.yellow(`    ⏭ ${ds}`));
      }
      console.log('');
      console.log(chalk.dim('  See deferred-work.md for details.'));
      console.log(chalk.dim('  To continue, fix the issue then update sprint-status.yaml:'));
      console.log(chalk.cyan(`    Change status from ${chalk.bold('deferred')} → ${chalk.bold('ready-for-dev')} and re-run:`));
      for (const ds of result.deferredStories) {
        console.log(chalk.cyan(`    bmad-auto story ${ds}`));
      }
      console.log(chalk.dim('\n  Or use Claude Code with BMAD Method to fix manually:'));
      console.log(chalk.cyan('    /bmad:bmm:workflows:dev-story <story-file>'));
    }
  } else if (result.outcome === 'halted') {
    console.log(chalk.red(`\n  Halted at: ${result.lastStory}`));
    console.log(chalk.red(`  Reason: ${result.haltReason}`));
  } else {
    console.log(chalk.yellow(`\n  Interrupted after ${result.storiesProcessed} stories.`));
  }
}

/**
 * Run the orchestrator with the full Ink TUI sprint board.
 */
async function runWithTui(statusFile: string, run: () => Promise<unknown>) {
  const React = await import('react');
  const { render } = await import('ink');
  const { App } = await import('./ui/App.js');
  const { loadSprintStatus: loadStatus } = await import('./state.js');

  const initialStatus = loadStatus(statusFile);
  const { waitUntilExit } = render(
    React.createElement(App, { statusFile, initialStatus })
  );

  // Run orchestrator in parallel — events flow to the Ink UI via orchestratorEvents/runnerEvents
  run().finally(() => {
    // Give Ink a moment to render final state
    setTimeout(() => process.exit(0), 500);
  });

  await waitUntilExit();
}

// ─── EPICS command (list all epics) ─────────────────────────────────────
program
  .command('epics')
  .description('List all epics with progress overview')
  .option('-p, --project-root <path>', 'Path to the BMAD project root', process.cwd())
  .action((options: { projectRoot: string }) => {
    try {
      const config = loadConfig(options.projectRoot);
      const statusFile = resolve(config.implementation_artifacts, 'sprint-status.yaml');
      const status = loadSprintStatus(statusFile);
      const epicsFile = resolve(config.planning_artifacts, 'epics.md');
      const epicNames = parseEpicNames(epicsFile);
      const epicDescs = parseEpicDescriptions(epicsFile);
      const epics = getEpicKeys(status);

      console.log(chalk.bold.cyan(`\n  BMAD Autopilot — ${status.project}\n`));

      let totalStories = 0;
      let totalDone = 0;

      for (const epicKey of epics) {
        const epicStatus = status.development_status[epicKey];
        const stories = getEpicStories(status, epicKey);
        const done = stories.filter(s => status.development_status[s] === 'done').length;
        totalStories += stories.length;
        totalDone += done;

        const pct = stories.length > 0 ? Math.round(done / stories.length * 100) : 0;
        const icon = epicStatus === 'done' ? '✅' : epicStatus === 'in-progress' ? '🔄' : '⏳';
        const name = epicNames[epicKey] || '';
        const bar = renderBar(pct, 20);

        const next = getNextAction(status, epicKey);
        const nextHint = next ? chalk.dim(` → next: ${next.skill}`) : '';

        console.log(`  ${icon} ${chalk.bold(epicKey)}${name ? ': ' + chalk.white(name) : ''}`);
        if (epicDescs[epicKey]) console.log(`     ${chalk.dim(epicDescs[epicKey])}`);
        console.log(`     ${bar} ${done}/${stories.length} (${pct}%)${nextHint}`);
      }

      console.log(chalk.dim(`\n  Overall: ${totalDone}/${totalStories} stories (${totalStories > 0 ? Math.round(totalDone / totalStories * 100) : 0}%)\n`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  Error: ${message}\n`));
      process.exit(1);
    }
  });

function renderBar(pct: number, width: number): string {
  const filled = Math.round(pct / 100 * width);
  const empty = width - filled;
  const color = pct === 100 ? chalk.green : pct > 0 ? chalk.cyan : chalk.dim;
  return color('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

// ─── EPIC command ───────────────────────────────────────────────────────
program
  .command('epic <epic-key>')
  .description('Run all stories in an epic through the full BMAD cycle (create → dev → review → test)')
  .option('-p, --project-root <path>', 'Path to the BMAD project root', process.cwd())
  .option('--dry-run', 'Print planned skill invocations without executing', false)
  .option('--timeout <ms>', 'Timeout per skill in milliseconds', '1800000')
  .option('--dashboard', 'Start web dashboard alongside the run', false)
  .option('--port <port>', 'Web dashboard port', '3141')
  .option('--test-gate', 'Enable test suite quality gate (runs tests after dev, disabled by default)', false)
  .option('--gate-mode <mode>', 'Test gate behavior: strict (any failure), balanced (3+ failures), lenient (warn only)', 'balanced')
  .option('--no-interactive', 'Disable interactive prompts on failure (auto-defer)', false)
  .option('--tui', 'Render full Ink terminal UI with sprint board', false)
  .option('--budget <usd>', 'Max budget per skill invocation in USD (0 = unlimited for Pro Max)', '0')
  .option('--soft-pass-cycles <n>', 'After N review cycles, accept Medium/Low issues instead of deferring (0 = disable)', '3')
  .action(async (epicKey: string, options: { projectRoot: string; dryRun: boolean; timeout: string; dashboard: boolean; port: string; testGate: boolean; gateMode: string; interactive: boolean; tui: boolean; budget: string; softPassCycles: string }) => {
    try {
      // Normalize epic key: accept "1", "epic-1", etc.
      const normalizedEpic = epicKey.startsWith('epic-') ? epicKey : `epic-${epicKey}`;

      // Validate BMAD version
      const config = loadConfig(options.projectRoot);
      if (!checkBmadVersion(options.projectRoot)) process.exit(1);

      const statusFile = resolve(config.implementation_artifacts, 'sprint-status.yaml');
      const status = loadSprintStatus(statusFile);

      if (!(normalizedEpic in status.development_status)) {
        console.error(chalk.red(`\n  Epic '${normalizedEpic}' not found in sprint status.`));
        const epics = getEpicKeys(status);
        console.error(chalk.dim(`  Available epics: ${epics.join(', ')}\n`));
        process.exit(1);
      }

      const stories = getEpicStories(status, normalizedEpic);
      const done = stories.filter(s => status.development_status[s] === 'done').length;
      console.log(chalk.bold.cyan(`\n  BMAD Autopilot — ${normalizedEpic}`));
      console.log(chalk.dim(`  Stories: ${done}/${stories.length} done\n`));

      let dashboardHandle: { close: () => void } | undefined;
      if (options.dashboard) {
        const { startDashboard } = await import('./dashboard.js');
        dashboardHandle = startDashboard({ projectRoot: options.projectRoot, port: parseInt(options.port, 10) });
      }

      const budgetUsd = parseFloat(options.budget) || undefined; // 0 or NaN → undefined (unlimited)
      const softPass = parseInt(options.softPassCycles, 10) || undefined; // 0 → undefined (disabled)

      if (options.tui) {
        await runWithTui(statusFile, async () => orchestrate({
          projectRoot: options.projectRoot,
          dryRun: options.dryRun,
          timeoutMs: parseInt(options.timeout, 10),
          epic: normalizedEpic,
          testGate: options.testGate,
          gateMode: options.gateMode as 'strict' | 'balanced' | 'lenient',
          interactive: false,
          maxBudgetUsd: budgetUsd,
          softPassCycles: softPass,
        }));
        return;
      }

      await wireVerboseOutput();

      const result = await orchestrate({
        projectRoot: options.projectRoot,
        dryRun: options.dryRun,
        timeoutMs: parseInt(options.timeout, 10),
        epic: normalizedEpic,
        testGate: options.testGate,
        gateMode: options.gateMode as 'strict' | 'balanced' | 'lenient',
        interactive: options.interactive,
        maxBudgetUsd: budgetUsd,
        softPassCycles: softPass,
      });

      printResult(result, normalizedEpic);

      if (dashboardHandle) {
        console.log(chalk.dim('\n  Dashboard still running. Press Ctrl+C to stop.'));
        await new Promise(() => {});
      }
      if (result.outcome === 'halted') process.exit(1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  Error: ${message}\n`));
      process.exit(1);
    }
  });

// ─── STORY command ──────────────────────────────────────────────────────
program
  .command('story <story-key>')
  .description('Run a specific story through its full cycle (create → dev → review → test) until done')
  .option('-p, --project-root <path>', 'Path to the BMAD project root', process.cwd())
  .option('--dry-run', 'Print planned skill invocations without executing', false)
  .option('--timeout <ms>', 'Timeout per skill in milliseconds', '1800000')
  .option('--dashboard', 'Start web dashboard alongside the run', false)
  .option('--port <port>', 'Web dashboard port', '3141')
  .option('--test-gate', 'Enable test suite quality gate (runs tests after dev, disabled by default)', false)
  .option('--gate-mode <mode>', 'Test gate behavior: strict (any failure), balanced (3+ failures), lenient (warn only)', 'balanced')
  .option('--no-interactive', 'Disable interactive prompts on failure (auto-defer)', false)
  .option('--budget <usd>', 'Max budget per skill invocation in USD (0 = unlimited for Pro Max)', '0')
  .option('--soft-pass-cycles <n>', 'After N review cycles, accept Medium/Low issues instead of deferring (0 = disable)', '3')
  .action(async (storyKey: string, options: { projectRoot: string; dryRun: boolean; timeout: string; dashboard: boolean; port: string; testGate: boolean; gateMode: string; interactive: boolean; budget: string; softPassCycles: string }) => {
    try {
      const config = loadConfig(options.projectRoot);
      if (!checkBmadVersion(options.projectRoot)) process.exit(1);

      const statusFile = resolve(config.implementation_artifacts, 'sprint-status.yaml');
      const status = loadSprintStatus(statusFile);

      if (!isStoryKey(storyKey) || !(storyKey in status.development_status)) {
        console.error(chalk.red(`\n  Story '${storyKey}' not found in sprint status.`));
        process.exit(1);
      }

      const currentStatus = status.development_status[storyKey];
      if (currentStatus === 'done') {
        console.log(chalk.green(`\n  Story ${storyKey} is already done.\n`));
        return;
      }

      console.log(chalk.bold.cyan(`\n  BMAD Autopilot — ${storyKey}`));
      console.log(chalk.dim(`  Status: ${currentStatus}\n`));

      let dashboardHandle: { close: () => void } | undefined;
      if (options.dashboard) {
        const { startDashboard } = await import('./dashboard.js');
        dashboardHandle = startDashboard({ projectRoot: options.projectRoot, port: parseInt(options.port, 10) });
      }

      await wireVerboseOutput();

      const result = await orchestrate({
        projectRoot: options.projectRoot,
        dryRun: options.dryRun,
        timeoutMs: parseInt(options.timeout, 10),
        story: storyKey,
        testGate: options.testGate,
        gateMode: options.gateMode as 'strict' | 'balanced' | 'lenient',
        interactive: options.interactive,
        maxBudgetUsd: parseFloat(options.budget) || undefined,
        softPassCycles: parseInt(options.softPassCycles, 10) || undefined,
      });

      printResult(result, storyKey);

      if (dashboardHandle) {
        console.log(chalk.dim('\n  Dashboard still running. Press Ctrl+C to stop.'));
        await new Promise(() => {});
      }
      if (result.outcome === 'halted') process.exit(1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  Error: ${message}\n`));
      process.exit(1);
    }
  });

// ─── RUN command ────────────────────────────────────────────────────────
program
  .command('run')
  .description('Run all pending stories across all epics through the BMAD pipeline')
  .option('-p, --project-root <path>', 'Path to the BMAD project root', process.cwd())
  .option('--dry-run', 'Print planned skill invocations without executing', false)
  .option('--timeout <ms>', 'Timeout per skill in milliseconds', '1800000')
  .option('--dashboard', 'Start web dashboard alongside the run', false)
  .option('--port <port>', 'Web dashboard port', '3141')
  .option('--test-gate', 'Enable test suite quality gate (runs tests after dev, disabled by default)', false)
  .option('--gate-mode <mode>', 'Test gate behavior: strict (any failure), balanced (3+ failures), lenient (warn only)', 'balanced')
  .option('--no-interactive', 'Disable interactive prompts on failure (auto-defer)', false)
  .option('--budget <usd>', 'Max budget per skill invocation in USD (0 = unlimited for Pro Max)', '0')
  .option('--soft-pass-cycles <n>', 'After N review cycles, accept Medium/Low issues instead of deferring (0 = disable)', '3')
  .action(async (options: { projectRoot: string; dryRun: boolean; timeout: string; dashboard: boolean; port: string; testGate: boolean; gateMode: string; interactive: boolean; budget: string; softPassCycles: string }) => {
    try {
      if (!checkBmadVersion(options.projectRoot)) process.exit(1);

      let dashboardHandle: { close: () => void } | undefined;
      if (options.dashboard) {
        const { startDashboard } = await import('./dashboard.js');
        dashboardHandle = startDashboard({ projectRoot: options.projectRoot, port: parseInt(options.port, 10) });
      }

      await wireVerboseOutput();

      const result = await orchestrate({
        projectRoot: options.projectRoot,
        dryRun: options.dryRun,
        timeoutMs: parseInt(options.timeout, 10),
        testGate: options.testGate,
        gateMode: options.gateMode as 'strict' | 'balanced' | 'lenient',
        interactive: options.interactive,
        maxBudgetUsd: parseFloat(options.budget) || undefined,
        softPassCycles: parseInt(options.softPassCycles, 10) || undefined,
      });

      printResult(result, 'Sprint');

      if (dashboardHandle) {
        console.log(chalk.dim('\n  Dashboard still running. Press Ctrl+C to stop.'));
        await new Promise(() => {});
      }
      if (result.outcome === 'halted') process.exit(1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  Error: ${message}\n`));
      process.exit(1);
    }
  });

// ─── STATUS command ─────────────────────────────────────────────────────
program
  .command('status')
  .description('Show current sprint status grouped by epic')
  .option('-p, --project-root <path>', 'Path to the BMAD project root', process.cwd())
  .option('-e, --epic <epic-key>', 'Show status for a specific epic only')
  .action((options: { projectRoot: string; epic?: string }) => {
    try {
      const config = loadConfig(options.projectRoot);
      const statusFile = resolve(config.implementation_artifacts, 'sprint-status.yaml');
      const status = loadSprintStatus(statusFile);

      const epicsFile = resolve(config.planning_artifacts, 'epics.md');
      const epicNames = parseEpicNames(epicsFile);
      const epicDescs = parseEpicDescriptions(epicsFile);

      console.log(chalk.bold.cyan('\n  BMAD Autopilot — Sprint Status\n'));
      console.log(chalk.dim('  Project: ') + status.project);

      const epics = getEpicKeys(status);
      let totalStories = 0;
      let totalDone = 0;

      for (const epicKey of epics) {
        // Filter to specific epic if requested
        if (options.epic) {
          const normalized = options.epic.startsWith('epic-') ? options.epic : `epic-${options.epic}`;
          if (epicKey !== normalized) continue;
        }

        const epicStatus = status.development_status[epicKey];
        const stories = getEpicStories(status, epicKey);
        const done = stories.filter(s => status.development_status[s] === 'done').length;
        totalStories += stories.length;
        totalDone += done;

        const epicIcon = epicStatus === 'done' ? '✅' : epicStatus === 'in-progress' ? '🔄' : '⏳';
        const epicName = epicNames[epicKey];
        console.log(`\n  ${epicIcon} ${chalk.bold(epicKey)}${epicName ? ': ' + chalk.white(epicName) : ''} (${done}/${stories.length})`);
        if (epicDescs[epicKey]) console.log(`     ${chalk.dim(epicDescs[epicKey])}`);

        for (const storyKey of stories) {
          const val = status.development_status[storyKey];
          const icon = val === 'done' ? '✅' : val === 'deferred' ? '⏭' : val === 'in-progress' ? '🔄' : val === 'review' ? '🔍' : val === 'ready-for-dev' ? '📋' : '⏳';
          console.log(`    ${icon} ${storyKey} — ${humanizeStoryKey(storyKey)}: ${val}`);
        }
      }

      console.log(chalk.dim(`\n  Overall: ${totalDone}/${totalStories} stories done (${totalStories > 0 ? Math.round(totalDone / totalStories * 100) : 0}%)`));

      const next = getNextAction(status, options.epic ? (options.epic.startsWith('epic-') ? options.epic : `epic-${options.epic}`) : undefined);
      if (next) {
        console.log(chalk.cyan(`  Next: ${next.skill} → ${next.storyKey}\n`));
      } else {
        console.log(chalk.green('  All done!\n'));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  Error: ${message}\n`));
      process.exit(1);
    }
  });

// ─── DASHBOARD command ──────────────────────────────────────────────────
program
  .command('dashboard')
  .description('Start the web dashboard to view sprint status')
  .option('-p, --project-root <path>', 'Path to the BMAD project root', process.cwd())
  .option('--port <port>', 'Port for the web dashboard', '3141')
  .action(async (options: { projectRoot: string; port: string }) => {
    try {
      const { startDashboard } = await import('./dashboard.js');
      startDashboard({
        projectRoot: options.projectRoot,
        port: parseInt(options.port, 10),
      });
      console.log(chalk.cyan.bold('\n  BMAD Autopilot Dashboard'));
      console.log(chalk.dim('  Press Ctrl+C to stop.\n'));
      await new Promise(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  Error: ${message}\n`));
      process.exit(1);
    }
  });

program.parse();
