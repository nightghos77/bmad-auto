import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunLogger } from '../src/logger.js';

describe('RunLogger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bmad-logger-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates log file in autopilot-runs directory', () => {
    const logger = new RunLogger(tempDir);
    logger.log({ event: 'test' });
    expect(logger.getFilePath()).toContain('autopilot-runs');
  });

  it('writes valid JSONL entries with timestamps', () => {
    const logger = new RunLogger(tempDir);
    logger.log({ event: 'skill_start', skill: 'bmad-dev-story', story: '1-1-test' });
    logger.log({ event: 'skill_complete', skill: 'bmad-dev-story', story: '1-1-test', durationMs: 5000 });

    const content = readFileSync(logger.getFilePath(), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const entry1 = JSON.parse(lines[0]);
    expect(entry1.event).toBe('skill_start');
    expect(entry1.ts).toBeTruthy();
    expect(entry1.skill).toBe('bmad-dev-story');

    const entry2 = JSON.parse(lines[1]);
    expect(entry2.event).toBe('skill_complete');
    expect(entry2.durationMs).toBe(5000);
  });

  it('generates unique run IDs', () => {
    const logger1 = new RunLogger(tempDir);
    const logger2 = new RunLogger(tempDir);
    expect(logger1.runId).not.toBe(logger2.runId);
  });
});
