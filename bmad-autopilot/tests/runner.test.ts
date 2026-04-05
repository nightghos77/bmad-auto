import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSkill, runnerEvents } from '../src/runner.js';

describe('runSkill', () => {
  beforeEach(() => {
    runnerEvents.removeAllListeners();
  });

  it('returns dry run result without invoking subprocess', async () => {
    const result = await runSkill('bmad-dev-story', '1-1-setup', {
      projectRoot: '/tmp',
      dryRun: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBe(0);
    expect(result.output).toContain('[DRY RUN]');
    expect(result.output).toContain('bmad-dev-story');
    expect(result.skill).toBe('bmad-dev-story');
    expect(result.storyKey).toBe('1-1-setup');
  });

  it('emits skill_dry_run event in dry run mode', async () => {
    const handler = vi.fn();
    runnerEvents.on('skill_dry_run', handler);

    await runSkill('bmad-create-story', '2-1-ui', {
      projectRoot: '/tmp',
      dryRun: true,
    });

    expect(handler).toHaveBeenCalledWith({
      skill: 'bmad-create-story',
      storyKey: '2-1-ui',
    });
  });

  it('returns error when skill directory not found', async () => {
    const errorHandler = vi.fn();
    runnerEvents.on('skill_error', errorHandler);

    const result = await runSkill('nonexistent-skill', '1-1-test', {
      projectRoot: '/tmp/nonexistent',
      timeoutMs: 5000,
    });

    expect(result.exitCode).toBe(127);
    expect(result.output).toContain('not found');
    expect(errorHandler).toHaveBeenCalled();
  });

  it('returns correct structure for all result fields', async () => {
    const result = await runSkill('nonexistent-skill', '3-2-test', {
      projectRoot: '/tmp/no-project',
    });

    // Verify result shape
    expect(result).toHaveProperty('skill', 'nonexistent-skill');
    expect(result).toHaveProperty('storyKey', '3-2-test');
    expect(result).toHaveProperty('exitCode');
    expect(result).toHaveProperty('durationMs');
    expect(result).toHaveProperty('output');
    expect(typeof result.exitCode).toBe('number');
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.output).toBe('string');
  });
});
