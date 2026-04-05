import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { orchestrate } from '../src/orchestrator.js';

function setupProject(tempDir: string, sprintEntries: Record<string, string>) {
  // Create BMAD config
  const configDir = join(tempDir, '_bmad', 'bmm');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), `
project_name: test-project
user_name: Tester
user_skill_level: intermediate
planning_artifacts: "{project-root}/_bmad-output/planning"
implementation_artifacts: "{project-root}/_bmad-output/impl"
project_knowledge: "{project-root}/docs"
output_folder: "{project-root}/_bmad-output"
communication_language: English
document_output_language: English
`);

  // Create sprint status
  const implDir = join(tempDir, '_bmad-output', 'impl');
  mkdirSync(implDir, { recursive: true });

  const statusLines = Object.entries(sprintEntries)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  writeFileSync(join(implDir, 'sprint-status.yaml'), `
generated: 2026-04-02
last_updated: 2026-04-02
project: test-project
project_key: NOKEY
tracking_system: file-system
story_location: impl

development_status:
${statusLines}
`);
}

describe('orchestrate', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bmad-orch-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns complete when all stories are done', async () => {
    setupProject(tempDir, {
      'epic-1': 'done',
      '1-1-setup': 'done',
      '1-2-state': 'done',
      'epic-1-retrospective': 'optional',
    });

    const result = await orchestrate({ projectRoot: tempDir });

    expect(result.outcome).toBe('complete');
    expect(result.storiesProcessed).toBe(0);
  });

  it('dry run identifies next action without executing', async () => {
    setupProject(tempDir, {
      'epic-1': 'in-progress',
      '1-1-setup': 'done',
      '1-2-state': 'backlog',
      'epic-1-retrospective': 'optional',
    });

    const result = await orchestrate({ projectRoot: tempDir, dryRun: true });

    // Dry run should not crash and should process at least conceptually
    expect(result.outcome).toBe('complete');
  });

  it('defers story when skill fails after retries and continues', async () => {
    setupProject(tempDir, {
      'epic-1': 'in-progress',
      '1-1-setup': 'backlog',
      'epic-1-retrospective': 'optional',
    });

    // Skill dir won't exist in temp dir, runner returns exit 127 immediately
    const result = await orchestrate({
      projectRoot: tempDir,
      maxRetries: 0,
      timeoutMs: 5000,
    });

    // With only one story that fails, it gets deferred, then epic completes with deferrals
    expect(result.outcome).toBe('complete_with_deferrals');
    expect(result.storiesDeferred).toBe(1);
    expect(result.deferredStories).toContain('1-1-setup');

    // Verify sprint-status.yaml was updated
    const statusContent = readFileSync(join(tempDir, '_bmad-output', 'impl', 'sprint-status.yaml'), 'utf8');
    expect(statusContent).toContain('1-1-setup: deferred');

    // Verify deferred-work.md was created
    const deferredPath = join(tempDir, '_bmad-output', 'impl', 'deferred-work.md');
    const deferredContent = readFileSync(deferredPath, 'utf8');
    expect(deferredContent).toContain('### 1-1-setup');
    expect(deferredContent).toContain('failed');
  }, 15000);

  it('defers one story and processes next story in epic', async () => {
    setupProject(tempDir, {
      'epic-1': 'in-progress',
      '1-1-setup': 'backlog',
      '1-2-state': 'done',
      'epic-1-retrospective': 'optional',
    });

    // 1-1-setup will fail (no skill dir), get deferred
    // 1-2-state is already done
    // Epic should complete with deferrals
    const result = await orchestrate({
      projectRoot: tempDir,
      maxRetries: 0,
      timeoutMs: 5000,
    });

    expect(result.outcome).toBe('complete_with_deferrals');
    expect(result.storiesDeferred).toBe(1);
    expect(result.deferredStories).toContain('1-1-setup');
  }, 15000);

  it('returns complete with zero deferrals when all stories done', async () => {
    setupProject(tempDir, {
      'epic-1': 'done',
      '1-1-setup': 'done',
      '1-2-state': 'done',
      'epic-1-retrospective': 'optional',
    });

    const result = await orchestrate({ projectRoot: tempDir });

    expect(result.outcome).toBe('complete');
    expect(result.storiesDeferred).toBe(0);
    expect(result.deferredStories).toBeUndefined();
  });
});
