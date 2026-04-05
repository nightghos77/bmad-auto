import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectTestCommand, runTestGate, runReviewGate } from '../src/gates.js';

describe('detectTestCommand', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bmad-gates-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects npm test from package.json', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run' },
    }));
    expect(detectTestCommand(tempDir)).toBe('npm test');
  });

  it('returns null when no test framework found', () => {
    expect(detectTestCommand(tempDir)).toBeNull();
  });
});

describe('runTestGate', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bmad-gates-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes when no test command detected', () => {
    const result = runTestGate(tempDir);
    expect(result.passed).toBe(true);
    expect(result.details).toContain('skipping');
  });
});

describe('runReviewGate', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bmad-review-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes when no review section exists', () => {
    const storyPath = join(tempDir, 'story.md');
    writeFileSync(storyPath, '# Story\n\n## Tasks\n- [x] Done\n');
    const result = runReviewGate(storyPath);
    expect(result.passed).toBe(true);
  });

  it('fails when Critical findings exist', () => {
    const storyPath = join(tempDir, 'story.md');
    writeFileSync(storyPath, `# Story

## Senior Developer Review

### Action Items
- [ ] [Critical] SQL injection in user input handler
- [ ] [High] Missing auth check on /admin endpoint
- [x] [Low] Typo in variable name
`);
    const result = runReviewGate(storyPath);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('1 Critical');
    expect(result.details).toContain('1 High');
  });

  it('passes when only Medium/Low findings exist', () => {
    const storyPath = join(tempDir, 'story.md');
    writeFileSync(storyPath, `# Story

## Senior Developer Review

### Action Items
- [ ] [Medium] Could optimize query
- [ ] [Low] Consider renaming variable
`);
    const result = runReviewGate(storyPath);
    expect(result.passed).toBe(true);
    expect(result.details).toContain('1 Medium');
  });

  it('passes when story file does not exist', () => {
    const result = runReviewGate('/nonexistent/story.md');
    expect(result.passed).toBe(true);
  });
});
