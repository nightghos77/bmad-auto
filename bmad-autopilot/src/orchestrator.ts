import { resolve } from 'node:path';
import { unlinkSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { loadSprintStatus, getNextAction, updateStoryStatus, getEpicForStory, getEpicStories, appendDeferredWork, isStoryKey } from './state.js';
import { runSkill, runnerEvents, getLiveOutputPath } from './runner.js';
import { runTestGate, runReviewGate, captureTestBaseline, evaluateSoftPass, extractReviewSection } from './gates.js';
import { RunLogger } from './logger.js';
import { EventEmitter } from 'node:events';
import type { NextAction, GateMode } from './types.js';

export interface OrchestratorOptions {
  projectRoot: string;
  dryRun?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  epic?: string;
  story?: string;
  testGate?: boolean;
  gateMode?: GateMode;
  interactive?: boolean;
  maxBudgetUsd?: number;
  softPassCycles?: number;
}

export type InteractiveChoice = 'fix' | 'skip' | 'halt';

export interface OrchestratorResult {
  storiesProcessed: number;
  storiesDeferred: number;
  outcome: 'complete' | 'complete_with_deferrals' | 'halted' | 'interrupted';
  haltReason?: string;
  lastStory?: string;
  deferredStories?: string[];
}

/** Orchestrator-level events for UI consumption */
export const orchestratorEvents = new EventEmitter();

/**
 * Prompt the user interactively for a failure decision.
 * Returns 'fix' (pause for manual intervention), 'skip' (defer), or 'halt' (stop pipeline).
 */
async function promptFailureDecision(storyKey: string, reason: string, skillName?: string): Promise<InteractiveChoice> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<InteractiveChoice>((resolveChoice) => {
    console.log('');
    console.log(`  ⚠  Failure on ${storyKey}: ${reason}`);
    if (skillName) {
      console.log(`     Last skill: ${skillName}`);
      const skillHint = skillName === 'bmad-create-story' ? '/bmad-create-story'
        : skillName === 'bmad-dev-story' ? '/bmad-dev-story'
        : '/bmad-code-review';
      console.log(`     To fix manually: ${skillHint}`);
    }
    console.log('');
    console.log('  [F] Fix manually → pause pipeline, fix in Claude Code, press Enter to resume');
    console.log('  [S] Skip → defer this story and continue with the next');
    console.log('  [H] Halt → stop the pipeline');
    console.log('');

    const ask = () => {
      rl.question('  Your choice [F/S/H]: ', (answer) => {
        const choice = answer.trim().toLowerCase();
        if (choice === 'f' || choice === 'fix') {
          rl.close();
          resolveChoice('fix');
        } else if (choice === 's' || choice === 'skip') {
          rl.close();
          resolveChoice('skip');
        } else if (choice === 'h' || choice === 'halt') {
          rl.close();
          resolveChoice('halt');
        } else {
          ask(); // re-prompt on invalid input
        }
      });
    };
    ask();
  });
}

/**
 * In 'fix' mode, pause and wait for user to press Enter after manual intervention.
 */
async function waitForResume(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<void>((resolveWait) => {
    console.log('');
    console.log('  Pipeline paused. Fix the issue manually in Claude Code.');
    console.log('  Press Enter when ready to resume...');
    rl.once('line', () => {
      rl.close();
      resolveWait();
    });
  });
}

/**
 * Main orchestrator loop. Reads sprint status, determines next action,
 * invokes the skill, runs quality gates, and loops until sprint is complete or HALT.
 */
export async function orchestrate(options: OrchestratorOptions): Promise<OrchestratorResult> {
  const { projectRoot, dryRun = false, timeoutMs, maxRetries = 1, epic, story, testGate = false, gateMode = 'balanced', interactive, maxBudgetUsd, softPassCycles } = options;
  // Interactive mode: true if explicitly set, otherwise auto-detect TTY (but not in CI)
  const isInteractive = interactive !== undefined ? interactive : (process.stdin.isTTY === true && !process.env.CI);

  // When running a single story, derive the epic scope for logging
  const epicScope = epic || (story ? getEpicForStory(story) : undefined);

  const config = loadConfig(projectRoot);
  const statusFile = resolve(config.implementation_artifacts, 'sprint-status.yaml');
  const logger = new RunLogger(config.output_folder, epicScope);
  const liveFile = getLiveOutputPath(config.output_folder);

  // ── Branch protection: never work on main/master ──
  if (!dryRun && isGitRepo(projectRoot)) {
    const branch = getCurrentBranch(projectRoot);
    if (branch && PROTECTED_BRANCHES.includes(branch)) {
      const suggested = generateBranchName(epicScope);
      const isInteractiveForBranch = interactive !== undefined ? interactive : (process.stdin.isTTY === true && !process.env.CI);

      if (isInteractiveForBranch) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((res) => {
          console.log('');
          console.log(`  🛑 You are on '${branch}' — autopilot refuses to work on protected branches.`);
          console.log(`     This prevents polluting your repo with automated commits.`);
          console.log('');
          console.log(`  Suggested branch: ${suggested}`);
          console.log('');
          rl.question('  Create this branch and continue? [Y/n/custom name]: ', (a) => { rl.close(); res(a.trim()); });
        });

        if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
          return { storiesProcessed: 0, storiesDeferred: 0, outcome: 'halted', haltReason: `Refused to run on '${branch}'. Create a branch first.` };
        }

        const branchToCreate = (answer && answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes' && answer !== '')
          ? answer
          : suggested;

        if (!createAndCheckoutBranch(projectRoot, branchToCreate)) {
          return { storiesProcessed: 0, storiesDeferred: 0, outcome: 'halted', haltReason: `Failed to create branch '${branchToCreate}'.` };
        }
        orchestratorEvents.emit('log', `Created branch: ${branchToCreate}`);
      } else {
        // Non-interactive (CI/pipeline): auto-create branch
        orchestratorEvents.emit('log', `🛑 On protected branch '${branch}' — creating ${suggested}`);
        if (!createAndCheckoutBranch(projectRoot, suggested)) {
          return {
            storiesProcessed: 0, storiesDeferred: 0, outcome: 'halted',
            haltReason: `Failed to create branch '${suggested}' from protected branch '${branch}'.`,
          };
        }
        orchestratorEvents.emit('log', `Created branch: ${suggested}`);
      }
    }
  }

  logger.log({ event: 'run_start', projectRoot, dryRun, epic, story });
  orchestratorEvents.emit('log', `Run started (id: ${logger.runId})`);
  orchestratorEvents.emit('log', `Project: ${config.project_name}`);
  if (epic) orchestratorEvents.emit('log', `Epic: ${epic}`);
  if (story) orchestratorEvents.emit('log', `Story: ${story}`);
  orchestratorEvents.emit('log', `Status file: ${statusFile}`);
  if (dryRun) orchestratorEvents.emit('log', 'Mode: DRY RUN');

  let storiesProcessed = 0;
  let interrupted = false;
  const testedStories = new Set<string>(); // track stories that already passed test gate
  const reviewCycles = new Map<string, number>(); // track review cycles per story
  const deferredStories = new Set<string>(); // track deferred stories in this run
  const MAX_REVIEW_CYCLES = softPassCycles ?? 3; // allow N fix attempts, then soft-pass or defer
  const preDevSnapshots = new Map<string, string>(); // storyKey → git SHA before dev-story
  const changedFilesMap = new Map<string, string[]>(); // storyKey → files changed since last review

  // Capture pre-existing test failures so we only halt on NEW regressions
  let testBaseline: Set<string> | null = null;
  if (testGate) {
    orchestratorEvents.emit('log', 'Capturing test baseline...');
    testBaseline = captureTestBaseline(projectRoot);
    if (testBaseline) {
      orchestratorEvents.emit('log', `Test baseline: ${testBaseline.size} pre-existing failure(s) detected`);
      logger.log({ event: 'test_baseline', preExistingFailures: testBaseline.size });
    } else {
      orchestratorEvents.emit('log', 'Test baseline: all green (or no test command)');
      logger.log({ event: 'test_baseline', preExistingFailures: 0 });
    }
  } else {
    orchestratorEvents.emit('log', 'Test gate disabled (use --test-gate to enable)');
    logger.log({ event: 'test_baseline', skipped: true });
  }

  const handleSignal = () => {
    interrupted = true;
    orchestratorEvents.emit('log', 'Interrupted. Finishing current operation...');
    orchestratorEvents.emit('outcome', 'interrupted');
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  // Helper: defer a story instead of halting the pipeline
  function deferStory(storyKey: string, reason: string, skillName?: string) {
    const epicKey = getEpicForStory(storyKey);
    updateStoryStatus(statusFile, storyKey, 'deferred');
    appendDeferredWork(config.implementation_artifacts, storyKey, epicKey, reason, skillName);
    deferredStories.add(storyKey);
    logger.log({ event: 'story_deferred', story: storyKey, reason, skill: skillName });
    orchestratorEvents.emit('log', `⏭ Deferred '${storyKey}': ${reason}`);
    orchestratorEvents.emit('story_deferred', storyKey, reason);
  }

  /**
   * Handle a failure: in interactive mode, prompt the user. In pipeline mode, auto-defer.
   * Returns 'continue' (story deferred, move to next), 'retry' (user fixed, re-run loop),
   * or 'halt' (user chose to stop).
   */
  async function handleFailure(storyKey: string, reason: string, skillName?: string): Promise<'continue' | 'retry' | 'halt'> {
    if (!isInteractive) {
      // Pipeline mode: auto-defer and continue
      deferStory(storyKey, reason, skillName);
      return 'continue';
    }

    // Interactive mode: prompt the user
    orchestratorEvents.emit('interactive_prompt', storyKey, reason);
    const choice = await promptFailureDecision(storyKey, reason, skillName);
    logger.log({ event: 'interactive_choice', story: storyKey, choice });

    if (choice === 'skip') {
      deferStory(storyKey, reason, skillName);
      return 'continue';
    } else if (choice === 'halt') {
      logger.log({ event: 'halt', reason: `User chose to halt at '${storyKey}'`, story: storyKey });
      orchestratorEvents.emit('log', `User halted pipeline at '${storyKey}'`);
      return 'halt';
    } else {
      // fix: pause for manual intervention
      await waitForResume();
      orchestratorEvents.emit('log', `Resuming after manual fix for '${storyKey}'`);
      logger.log({ event: 'manual_fix_resume', story: storyKey });
      return 'retry';
    }
  }

  // Helper: build the result object with deferral counts
  function buildResult(outcome: OrchestratorResult['outcome'], extra?: Partial<OrchestratorResult>): OrchestratorResult {
    return {
      storiesProcessed,
      storiesDeferred: deferredStories.size,
      outcome,
      deferredStories: deferredStories.size > 0 ? [...deferredStories] : undefined,
      ...extra,
    };
  }

  try {
    while (!interrupted) {
      const status = loadSprintStatus(statusFile);

      // For single-story mode, check if that story is done or deferred
      if (story) {
        const storyStatus = status.development_status[story];
        if (storyStatus === 'done') {
          logger.log({ event: 'story_complete', story, storiesProcessed });
          orchestratorEvents.emit('log', `Story ${story} complete! ${storiesProcessed} steps processed.`);
          orchestratorEvents.emit('outcome', 'complete');
          return buildResult('complete');
        }
        if (storyStatus === 'deferred') {
          logger.log({ event: 'story_deferred_skip', story, storiesProcessed });
          orchestratorEvents.emit('log', `Story ${story} is deferred. Fix manually then re-run.`);
          orchestratorEvents.emit('outcome', 'complete_with_deferrals');
          return buildResult('complete_with_deferrals');
        }
      }

      const next = story
        ? getNextAction(status, getEpicForStory(story))
        : getNextAction(status, epic);

      // In story mode, skip if next action isn't for our story
      if (story && next && next.storyKey !== story) {
        logger.log({ event: 'story_complete', story, storiesProcessed });
        orchestratorEvents.emit('log', `Story ${story} complete! ${storiesProcessed} steps processed.`);
        orchestratorEvents.emit('outcome', 'complete');
        return buildResult('complete');
      }

      if (!next) {
        // Mark epic(s) as done if all their stories are complete (or deferred)
        const freshStatus = loadSprintStatus(statusFile);
        const epicsToCheck = epic ? [epic] : Object.keys(freshStatus.development_status).filter(k => k.startsWith('epic-') && !k.endsWith('-retrospective'));
        for (const ek of epicsToCheck) {
          const stories = getEpicStories(freshStatus, ek);
          const doneCount = stories.filter(s => freshStatus.development_status[s] === 'done').length;
          const deferredCount = stories.filter(s => freshStatus.development_status[s] === 'deferred').length;
          const allSettled = stories.length > 0 && stories.every(s =>
            freshStatus.development_status[s] === 'done' || freshStatus.development_status[s] === 'deferred'
          );
          if (allSettled && freshStatus.development_status[ek] !== 'done') {
            updateStoryStatus(statusFile, ek, 'done' as any);
            if (deferredCount > 0) {
              orchestratorEvents.emit('log', `✓ ${ek} complete with deferrals — ${doneCount} done, ${deferredCount} deferred`);
              logger.log({ event: 'epic_complete_with_deferrals', epic: ek, done: doneCount, deferred: deferredCount });
            } else {
              orchestratorEvents.emit('log', `✓ ${ek} marked as done — all ${stories.length} stories complete`);
              logger.log({ event: 'epic_complete', epic: ek, stories: stories.length });
            }
          }
        }

        // Check for pre-existing deferred stories (from a previous run)
        const allStories = epic ? getEpicStories(freshStatus, epic) : Object.keys(freshStatus.development_status).filter(k => isStoryKey(k));
        const preDeferred = allStories.filter(s => freshStatus.development_status[s] === 'deferred');
        for (const pd of preDeferred) deferredStories.add(pd);

        const scope = story ? `Story ${story}` : epic ? `Epic ${epic}` : 'Sprint';
        const outcome = deferredStories.size > 0 ? 'complete_with_deferrals' : 'complete';
        logger.log({ event: 'sprint_complete', storiesProcessed, storiesDeferred: deferredStories.size, epic, story });
        if (deferredStories.size > 0) {
          orchestratorEvents.emit('log', `${scope} complete with ${deferredStories.size} deferral(s). ${storiesProcessed} steps processed.`);
        } else {
          orchestratorEvents.emit('log', `${scope} complete! ${storiesProcessed} steps processed.`);
        }
        orchestratorEvents.emit('outcome', outcome);
        return buildResult(outcome);
      }

      orchestratorEvents.emit('log', `[${next.storyKey}] ${next.currentStatus} → ${next.skill}`);
      logger.log({ event: 'action_selected', skill: next.skill, story: next.storyKey, status: next.currentStatus });

      if (dryRun) {
        await runSkill(next.skill, next.storyKey, { projectRoot, dryRun: true, liveFile });
        logger.log({ event: 'dry_run_skip', skill: next.skill, story: next.storyKey });
        storiesProcessed++;
        break;
      }

      // Build cycle context for review-fix iterations
      const cycleNum = reviewCycles.get(next.storyKey) || 0;
      let cycleContext: import('./runner.js').CycleContext | undefined;
      if (cycleNum > 0) {
        const currentStatus = loadSprintStatus(statusFile);
        const storyDir = currentStatus.story_location
          ? resolve(projectRoot, currentStatus.story_location)
          : config.implementation_artifacts;
        const storyFile = resolve(storyDir, `${next.storyKey}.md`);
        cycleContext = {
          cycleNumber: cycleNum + 1,
          maxCycles: MAX_REVIEW_CYCLES,
          priorReviewFindings: extractReviewSection(storyFile),
          changedFilesSinceLastReview: changedFilesMap.get(next.storyKey),
        };
      }

      // Capture git SHA before dev-story on review cycles (for scoped reviews)
      if (next.skill === 'bmad-dev-story' && cycleNum > 0) {
        const sha = captureGitSnapshot(projectRoot);
        if (sha) preDevSnapshots.set(next.storyKey, sha);
      }

      // Execute with retry
      let success = false;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          orchestratorEvents.emit('log', `Retry ${attempt}/${maxRetries} for ${next.skill}...`);
          logger.log({ event: 'retry', skill: next.skill, story: next.storyKey, attempt });
        }

        const result = await runSkill(next.skill, next.storyKey, { projectRoot, timeoutMs, liveFile, maxBudgetUsd, cycleContext });
        logger.log({
          event: 'skill_result',
          skill: next.skill,
          story: next.storyKey,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });

        if (result.exitCode === 0) {
          success = true;
          break;
        }

        if (attempt === maxRetries) {
          // FAILURE #1: Skill failure after max retries
          const reason = `Skill '${next.skill}' failed after ${maxRetries + 1} attempts. Exit: ${result.exitCode}`;
          const decision = await handleFailure(next.storyKey, reason, next.skill);
          if (decision === 'halt') {
            return buildResult('halted', { haltReason: `User halted at '${next.storyKey}': ${reason}`, lastStory: next.storyKey });
          }
          if (decision === 'retry') {
            // User fixed manually — re-run the main loop to re-evaluate status
            break;
          }
          // 'continue' — story was deferred
          storiesProcessed++;
        }
      }

      // If skill failed and story was deferred or user chose retry, continue to next iteration
      if (deferredStories.has(next.storyKey)) continue;

      // After successful dev-story in a review cycle, capture changed files for scoped review
      if (success && next.skill === 'bmad-dev-story' && preDevSnapshots.has(next.storyKey)) {
        const baseSha = preDevSnapshots.get(next.storyKey)!;
        const changed = getChangedFilesSince(projectRoot, baseSha);
        if (changed.length > 0) {
          changedFilesMap.set(next.storyKey, changed);
          logger.log({ event: 'changed_files_captured', story: next.storyKey, count: changed.length });
        }
      }

      if (success) {
        const updatedStatus = loadSprintStatus(statusFile);
        const updatedValue = updatedStatus.development_status[next.storyKey];

        // After code review, status staying at 'review' means findings need fixing.
        // Transition back to 'in-progress' so dev-story can address them.
        if (next.skill === 'bmad-code-review' && updatedValue === 'review') {
          const cycles = (reviewCycles.get(next.storyKey) || 0) + 1;
          reviewCycles.set(next.storyKey, cycles);

          if (cycles > MAX_REVIEW_CYCLES) {
            // Review cycle limit exceeded — try soft-pass before deferring
            const storyDir = updatedStatus.story_location
              ? resolve(projectRoot, updatedStatus.story_location)
              : config.implementation_artifacts;
            const storyFile = resolve(storyDir, `${next.storyKey}.md`);
            const severity = evaluateSoftPass(storyFile);

            if (severity.critical === 0 && severity.high === 0) {
              // SOFT PASS: only Medium/Low remain — accept and move on
              updateStoryStatus(statusFile, next.storyKey, 'done');
              const msg = `Soft pass for '${next.storyKey}' — ${severity.medium}M/${severity.low}L remaining after ${cycles} cycles`;
              liveLog(liveFile, msg, 'result');
              orchestratorEvents.emit('log', `✓ ${msg}`);
              logger.log({ event: 'soft_pass', story: next.storyKey, cycle: cycles, medium: severity.medium, low: severity.low });
              commitStoryChanges(projectRoot, next.storyKey, 'bmad-code-review', 'review', 'done', logger, liveFile);
              storiesProcessed++;
              continue;
            }

            // Critical/High persist — defer
            const reason = `Review cycle limit reached (${cycles} attempts). ${severity.critical}C/${severity.high}H issues remain.`;
            const decision = await handleFailure(next.storyKey, reason, 'bmad-code-review');
            if (decision === 'halt') {
              return buildResult('halted', { haltReason: `User halted at '${next.storyKey}': ${reason}`, lastStory: next.storyKey });
            }
            if (decision === 'retry') continue; // re-evaluate from top of loop
            storiesProcessed++;
            continue;
          }

          liveLog(liveFile, `Review found issues — cycling back to dev for ${next.storyKey} (attempt ${cycles}/${MAX_REVIEW_CYCLES})`, 'info');
          orchestratorEvents.emit('log', `Review found issues for '${next.storyKey}' — cycling back to dev (attempt ${cycles}/${MAX_REVIEW_CYCLES})`);
          logger.log({ event: 'review_cycle', story: next.storyKey, cycle: cycles });

          // Commit review findings before cycling back
          commitStoryChanges(projectRoot, next.storyKey, next.skill, 'review', 'in-progress', logger, liveFile);

          updateStoryStatus(statusFile, next.storyKey, 'in-progress');
          storiesProcessed++;
          continue;
        }

        if (updatedValue === next.currentStatus) {
          // FAILURE #3: Stuck state — status unchanged after skill
          const reason = `Status unchanged after '${next.skill}'. Stuck state detected.`;
          const decision = await handleFailure(next.storyKey, reason, next.skill);
          if (decision === 'halt') {
            return buildResult('halted', { haltReason: `User halted at '${next.storyKey}': ${reason}`, lastStory: next.storyKey });
          }
          if (decision === 'retry') continue;
          storiesProcessed++;
          continue;
        }

        liveLog(liveFile, `✓ ${next.storyKey}: ${next.currentStatus} → ${updatedValue}`, 'result');
        orchestratorEvents.emit('log', `✓ ${next.storyKey}: ${next.currentStatus} → ${updatedValue}`);
        storiesProcessed++;

        // Commit changes after each story transition
        const sha = commitStoryChanges(projectRoot, next.storyKey, next.skill, next.currentStatus, updatedValue, logger, liveFile);
        if (sha) {
          orchestratorEvents.emit('log', `📦 Committed: ${sha} — ${next.skill} for ${next.storyKey}`);
        }

        // Quality gates after specific transitions
        // Use story_location from sprint status (BMAD's source of truth)
        const storyDir = updatedStatus.story_location
          ? resolve(projectRoot, updatedStatus.story_location)
          : config.implementation_artifacts;
        const gateResult = runQualityGates(next, updatedValue, projectRoot, storyDir, logger, testedStories, liveFile, gateMode, testGate ? testBaseline : undefined);
        if (gateResult) {
          // FAILURE #4/#5: Quality gate failure
          const decision = await handleFailure(next.storyKey, gateResult, next.skill);
          if (decision === 'halt') {
            return buildResult('halted', { haltReason: `User halted at '${next.storyKey}': ${gateResult}`, lastStory: next.storyKey });
          }
          if (decision === 'retry') continue;
          continue;
        }
      }
    }

    if (interrupted) {
      logger.log({ event: 'interrupted', storiesProcessed, storiesDeferred: deferredStories.size });
      return buildResult('interrupted');
    }

    const outcome = deferredStories.size > 0 ? 'complete_with_deferrals' : 'complete';
    return buildResult(outcome);
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    // Clean up ephemeral live output file
    try { if (existsSync(liveFile)) unlinkSync(liveFile); } catch { /* ignore */ }
    orchestratorEvents.emit('log', `Log file: ${logger.getFilePath()}`);
    logger.log({ event: 'run_end', storiesProcessed, storiesDeferred: deferredStories.size });
  }
}

function liveLog(liveFile: string, line: string, type: string) {
  try { appendFileSync(liveFile, JSON.stringify({ event: 'output', line, type }) + '\n'); } catch { /* ignore */ }
}

/**
 * Get the current git branch name. Returns null if not a git repo or detached HEAD.
 */
function getCurrentBranch(projectRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot, timeout: 5000 }).toString().trim();
  } catch { return null; }
}

/**
 * Check if a git repo exists at the given path.
 */
function isGitRepo(projectRoot: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: projectRoot, timeout: 5000 });
    return true;
  } catch { return false; }
}

/**
 * Generate a fun random branch name prefixed with bmad/.
 * Combines an adjective + noun for a memorable identifier.
 */
function generateBranchName(epicScope?: string): string {
  const adjectives = [
    'cosmic', 'electric', 'quantum', 'neon', 'atomic', 'stellar', 'turbo',
    'hyper', 'mega', 'ultra', 'super', 'blazing', 'swift', 'mighty', 'bold',
    'vivid', 'epic', 'grand', 'noble', 'fierce', 'clever', 'lucid', 'radiant',
    'golden', 'silver', 'crimson', 'azure', 'jade', 'amber', 'onyx',
  ];
  const nouns = [
    'phoenix', 'falcon', 'panther', 'thunder', 'horizon', 'summit', 'voyage',
    'nexus', 'forge', 'beacon', 'citadel', 'odyssey', 'aurora', 'tempest',
    'vanguard', 'zenith', 'catalyst', 'prism', 'vertex', 'orbit', 'pulse',
    'spark', 'titan', 'matrix', 'haven', 'quest', 'pioneer', 'dynamo',
    'comet', 'nebula', 'supernova', 'justice', 'liberty', 'maverick',
  ];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const scope = epicScope ? `${epicScope}/` : '';
  return `bmad/${scope}${adj}-${noun}`;
}

/**
 * Create and checkout a new git branch.
 */
function createAndCheckoutBranch(projectRoot: string, branchName: string): boolean {
  try {
    execFileSync('git', ['checkout', '-b', branchName], { cwd: projectRoot, timeout: 10000 });
    return true;
  } catch { return false; }
}

const PROTECTED_BRANCHES = ['main', 'master', 'develop', 'production', 'staging'];

/**
 * Capture the current git HEAD SHA. Returns null if not a git repo.
 */
function captureGitSnapshot(projectRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, timeout: 5000 }).toString().trim();
  } catch { return null; }
}

/**
 * Get files changed since a given git SHA (committed + uncommitted).
 */
function getChangedFilesSince(projectRoot: string, baseSha: string): string[] {
  try {
    const output = execFileSync('git', ['diff', '--name-only', baseSha], { cwd: projectRoot, timeout: 10000 }).toString().trim();
    return output ? output.split('\n') : [];
  } catch { return []; }
}

/**
 * Check if there are uncommitted changes (staged or unstaged) in the project.
 */
function hasUncommittedChanges(projectRoot: string): boolean {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, timeout: 10000 }).toString().trim();
    return output.length > 0;
  } catch { return false; }
}

/**
 * Create a git commit for a story transition.
 * Stages all changes and commits with a descriptive message.
 * Returns the commit SHA or null if nothing to commit.
 */
function commitStoryChanges(
  projectRoot: string,
  storyKey: string,
  skill: string,
  fromStatus: string,
  toStatus: string,
  logger: RunLogger,
  liveFile: string,
): string | null {
  if (!hasUncommittedChanges(projectRoot)) return null;

  try {
    // Stage all changes
    execFileSync('git', ['add', '-A'], { cwd: projectRoot, timeout: 10000 });

    // Build commit message based on the skill/transition
    let prefix: string;
    let description: string;
    if (skill === 'bmad-create-story') {
      prefix = 'chore';
      description = `create story file for ${storyKey}`;
    } else if (skill === 'bmad-dev-story' && toStatus === 'review') {
      prefix = 'feat';
      description = `implement ${storyKey}`;
    } else if (skill === 'bmad-dev-story' && fromStatus === 'in-progress') {
      prefix = 'fix';
      description = `address review findings for ${storyKey}`;
    } else if (skill === 'bmad-code-review') {
      prefix = 'chore';
      description = `code review for ${storyKey}`;
    } else {
      prefix = 'chore';
      description = `${skill} for ${storyKey}`;
    }

    const message = `${prefix}(${storyKey}): ${description}`;

    execFileSync('git', ['commit', '-m', message], { cwd: projectRoot, timeout: 30000 });

    // Get the SHA of the new commit
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot, timeout: 5000 }).toString().trim();

    liveLog(liveFile, `Git commit: ${sha} — ${message}`, 'result');
    logger.log({ event: 'git_commit', story: storyKey, sha, message });
    return sha;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log({ event: 'git_commit_failed', story: storyKey, error: msg });
    liveLog(liveFile, `Git commit failed: ${msg}`, 'stderr');
    return null;
  }
}

function runQualityGates(
  action: NextAction,
  newStatus: string,
  projectRoot: string,
  artifactsDir: string,
  logger: RunLogger,
  testedStories: Set<string>,
  liveFile: string,
  gateMode: GateMode,
  testBaseline?: Set<string> | null,
): string | null {
  // After dev-story completes (story moves to review), run test suite — but only once per story.
  // On review cycles (review found issues → dev fixes → review again), skip the test gate
  // since tests already passed and the dev-story just addressed review findings.
  // testBaseline is undefined when --test-gate is not set (disabled by default).
  if (testBaseline !== undefined && action.skill === 'bmad-dev-story' && newStatus === 'review' && !testedStories.has(action.storyKey)) {
    liveLog(liveFile, 'Running test suite gate...', 'info');
    orchestratorEvents.emit('log', '🧪 Running test suite gate...');
    const testResult = runTestGate(projectRoot, testBaseline);
    logger.log({ event: 'gate', gate: testResult.gate, passed: testResult.passed, details: testResult.details, gateMode });
    orchestratorEvents.emit('gate', testResult);
    liveLog(liveFile, `Test gate: ${testResult.passed ? 'PASSED' : 'FAILED'} — ${testResult.details}`, testResult.passed ? 'result' : 'stderr');

    if (!testResult.passed) {
      // Gate mode determines how test failures are handled:
      // strict: any new failure → defer
      // balanced: 3+ new failures → defer, fewer → warn and continue
      // lenient: warn and continue regardless
      if (gateMode === 'lenient') {
        orchestratorEvents.emit('log', `⚠ Test gate failed but continuing (lenient mode): ${testResult.details}`);
        logger.log({ event: 'gate_override', gate: 'test-suite', gateMode, details: testResult.details });
      } else if (gateMode === 'balanced') {
        const newFailureCount = extractNewFailureCount(testResult.details);
        if (newFailureCount < 3) {
          orchestratorEvents.emit('log', `⚠ Test gate: ${newFailureCount} new failure(s) — continuing (balanced mode, threshold: 3)`);
          logger.log({ event: 'gate_override', gate: 'test-suite', gateMode, newFailures: newFailureCount });
        } else {
          return `Test gate failed (${newFailureCount} new failures, balanced threshold: 3): ${testResult.details}`;
        }
      } else {
        // strict: any failure defers
        return `Test gate failed: ${testResult.details}`;
      }
    }
    testedStories.add(action.storyKey);
    if (testResult.passed) {
      orchestratorEvents.emit('log', `✓ Test gate passed: ${testResult.details}`);
    }
  }

  // After code-review completes — BMAD-aligned gate.
  // Trust the review workflow's own triage: if the review set status to 'done', it triaged
  // all findings (patch/defer/dismiss). We only need the severity gate as a fallback
  // when the review didn't change status (handled by stuck-state detection) or when
  // the story status moved to 'done' but we still want to log the findings.
  if (action.skill === 'bmad-code-review' && newStatus === 'done') {
    // Review triaged everything and marked story done — trust the BMAD review workflow
    const storyFile = resolve(artifactsDir, `${action.storyKey}.md`);
    const reviewResult = runReviewGate(storyFile);
    logger.log({ event: 'gate', gate: 'review-triage', passed: true, details: reviewResult.details });
    orchestratorEvents.emit('log', `✓ Review complete — BMAD triage accepted: ${reviewResult.details}`);
    // No blocking — review workflow already made the triage decisions
  }

  return null;
}

/** Extract new failure count from test gate details string like "3 NEW test failure(s)..." */
function extractNewFailureCount(details: string): number {
  const match = details.match(/(\d+)\s+NEW\s+test\s+failure/i);
  return match ? parseInt(match[1], 10) : 1;
}
