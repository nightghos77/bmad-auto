import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSprintStatus, getNextAction, isStoryKey, updateStoryStatus, getEpicKeys, getEpicStories, getEpicForStory, appendDeferredWork } from '../src/state.js';

describe('isStoryKey', () => {
  it('identifies valid story keys', () => {
    expect(isStoryKey('1-1-project-setup')).toBe(true);
    expect(isStoryKey('2-3-some-feature-name')).toBe(true);
    expect(isStoryKey('10-15-long-name-here')).toBe(true);
  });

  it('rejects epic keys', () => {
    expect(isStoryKey('epic-1')).toBe(false);
    expect(isStoryKey('epic-12')).toBe(false);
  });

  it('rejects retrospective keys', () => {
    expect(isStoryKey('epic-1-retrospective')).toBe(false);
    expect(isStoryKey('epic-3-retrospective')).toBe(false);
  });

  it('rejects other non-story keys', () => {
    expect(isStoryKey('project')).toBe(false);
    expect(isStoryKey('tracking_system')).toBe(false);
  });
});

describe('loadSprintStatus', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bmad-state-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses valid sprint-status.yaml', () => {
    const filePath = join(tempDir, 'sprint-status.yaml');
    writeFileSync(filePath, `
generated: 2026-04-02
last_updated: 2026-04-02
project: test
project_key: NOKEY
tracking_system: file-system
story_location: impl

development_status:
  epic-1: in-progress
  1-1-setup: done
  1-2-state: backlog
  epic-1-retrospective: optional
`);

    const status = loadSprintStatus(filePath);
    expect(status.project).toBe('test');
    expect(status.development_status['1-1-setup']).toBe('done');
    expect(status.development_status['1-2-state']).toBe('backlog');
  });

  it('throws on missing file', () => {
    expect(() => loadSprintStatus('/nonexistent/path.yaml')).toThrow(
      /Sprint status file not found/
    );
  });

  it('throws on malformed YAML', () => {
    const filePath = join(tempDir, 'bad.yaml');
    writeFileSync(filePath, '{{{{not yaml');

    expect(() => loadSprintStatus(filePath)).toThrow(/Malformed YAML/);
  });

  it('throws when development_status is missing', () => {
    const filePath = join(tempDir, 'no-status.yaml');
    writeFileSync(filePath, 'project: test\ngenerated: 2026-01-01\n');

    expect(() => loadSprintStatus(filePath)).toThrow(/missing 'development_status'/);
  });
});

describe('getNextAction', () => {
  function makeStatus(entries: Record<string, string>) {
    return {
      generated: '2026-04-02',
      last_updated: '2026-04-02',
      project: 'test',
      project_key: 'NOKEY',
      tracking_system: 'file-system',
      story_location: 'impl',
      development_status: entries,
    };
  }

  it('returns first backlog story with bmad-create-story skill', () => {
    const result = getNextAction(makeStatus({
      'epic-1': 'in-progress',
      '1-1-setup': 'done',
      '1-2-state': 'backlog',
      '1-3-runner': 'backlog',
      'epic-1-retrospective': 'optional',
    }));

    expect(result).toEqual({
      storyKey: '1-2-state',
      currentStatus: 'backlog',
      skill: 'bmad-create-story',
    });
  });

  it('returns ready-for-dev story with bmad-dev-story skill', () => {
    const result = getNextAction(makeStatus({
      'epic-1': 'in-progress',
      '1-1-setup': 'ready-for-dev',
    }));

    expect(result).toEqual({
      storyKey: '1-1-setup',
      currentStatus: 'ready-for-dev',
      skill: 'bmad-dev-story',
    });
  });

  it('returns in-progress story with bmad-dev-story skill', () => {
    const result = getNextAction(makeStatus({
      'epic-1': 'in-progress',
      '1-1-setup': 'in-progress',
    }));

    expect(result).toEqual({
      storyKey: '1-1-setup',
      currentStatus: 'in-progress',
      skill: 'bmad-dev-story',
    });
  });

  it('returns review story with bmad-code-review skill', () => {
    const result = getNextAction(makeStatus({
      'epic-1': 'in-progress',
      '1-1-setup': 'review',
    }));

    expect(result).toEqual({
      storyKey: '1-1-setup',
      currentStatus: 'review',
      skill: 'bmad-code-review',
    });
  });

  it('returns null when all stories are done', () => {
    const result = getNextAction(makeStatus({
      'epic-1': 'done',
      '1-1-setup': 'done',
      '1-2-state': 'done',
      'epic-1-retrospective': 'optional',
    }));

    expect(result).toBeNull();
  });

  it('skips epic and retrospective keys', () => {
    const result = getNextAction(makeStatus({
      'epic-1': 'backlog',
      'epic-1-retrospective': 'optional',
      '1-1-setup': 'done',
    }));

    expect(result).toBeNull();
  });

  it('returns first actionable in top-to-bottom order', () => {
    const result = getNextAction(makeStatus({
      'epic-1': 'in-progress',
      '1-1-setup': 'done',
      '1-2-state': 'done',
      '1-3-runner': 'ready-for-dev',
      '1-4-loop': 'backlog',
      'epic-1-retrospective': 'optional',
    }));

    expect(result?.storyKey).toBe('1-3-runner');
  });

  it('filters by epic when epicFilter is provided', () => {
    const result = getNextAction(makeStatus({
      'epic-1': 'in-progress',
      '1-1-setup': 'backlog',
      'epic-2': 'in-progress',
      '2-1-feature': 'backlog',
    }), 'epic-2');

    expect(result?.storyKey).toBe('2-1-feature');
  });

  it('returns null when all stories in filtered epic are done', () => {
    const result = getNextAction(makeStatus({
      'epic-1': 'done',
      '1-1-setup': 'done',
      'epic-2': 'in-progress',
      '2-1-feature': 'backlog',
    }), 'epic-1');

    expect(result).toBeNull();
  });
});

describe('epic helpers', () => {
  it('getEpicForStory returns correct epic key', () => {
    expect(getEpicForStory('1-4-password-reset')).toBe('epic-1');
    expect(getEpicForStory('12-3-some-feature')).toBe('epic-12');
  });

  it('getEpicKeys returns only epic keys', () => {
    const status = {
      generated: '', last_updated: '', project: '', project_key: '',
      tracking_system: '', story_location: '',
      development_status: {
        'epic-1': 'in-progress', '1-1-setup': 'done', 'epic-1-retrospective': 'optional',
        'epic-2': 'backlog', '2-1-feature': 'backlog', 'epic-2-retrospective': 'optional',
      },
    };
    expect(getEpicKeys(status)).toEqual(['epic-1', 'epic-2']);
  });

  it('getEpicStories returns stories for a specific epic', () => {
    const status = {
      generated: '', last_updated: '', project: '', project_key: '',
      tracking_system: '', story_location: '',
      development_status: {
        'epic-1': 'in-progress', '1-1-setup': 'done', '1-2-state': 'backlog',
        'epic-1-retrospective': 'optional',
        'epic-2': 'backlog', '2-1-feature': 'backlog',
      },
    };
    expect(getEpicStories(status, 'epic-1')).toEqual(['1-1-setup', '1-2-state']);
    expect(getEpicStories(status, 'epic-2')).toEqual(['2-1-feature']);
  });
});

describe('updateStoryStatus', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bmad-update-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('updates target story status and preserves comments', () => {
    const filePath = join(tempDir, 'sprint-status.yaml');
    const original = `# generated: 2026-04-02
# last_updated: 2026-04-02
# project: test

generated: 2026-04-02
last_updated: 2026-04-02
project: test

development_status:
  epic-1: in-progress
  1-1-setup: done
  1-2-state: backlog
  epic-1-retrospective: optional
`;
    writeFileSync(filePath, original);

    updateStoryStatus(filePath, '1-2-state', 'ready-for-dev');

    const updated = readFileSync(filePath, 'utf8');
    expect(updated).toContain('1-2-state: ready-for-dev');
    expect(updated).toContain('1-1-setup: done');
    expect(updated).toContain('# generated: 2026-04-02');
    expect(updated).toContain('epic-1-retrospective: optional');
  });

  it('throws when story key not found', () => {
    const filePath = join(tempDir, 'sprint-status.yaml');
    writeFileSync(filePath, `
generated: 2026-04-02
last_updated: 2026-04-02

development_status:
  epic-1: backlog
  1-1-setup: backlog
`);

    expect(() => updateStoryStatus(filePath, '9-9-nonexistent', 'done')).toThrow(
      /Story key '9-9-nonexistent' not found/
    );
  });
});

describe('getNextAction skips deferred stories', () => {
  function makeStatus(entries: Record<string, string>) {
    return {
      generated: '2026-04-02',
      last_updated: '2026-04-02',
      project: 'test',
      project_key: 'NOKEY',
      tracking_system: 'file-system',
      story_location: 'impl',
      development_status: entries,
    };
  }

  it('skips deferred stories and returns next actionable', () => {
    const result = getNextAction(makeStatus({
      'epic-1': 'in-progress',
      '1-1-setup': 'deferred',
      '1-2-state': 'backlog',
      '1-3-runner': 'backlog',
    }));

    expect(result?.storyKey).toBe('1-2-state');
  });

  it('returns null when all non-done stories are deferred', () => {
    const result = getNextAction(makeStatus({
      'epic-1': 'in-progress',
      '1-1-setup': 'done',
      '1-2-state': 'deferred',
      '1-3-runner': 'deferred',
    }));

    expect(result).toBeNull();
  });
});

describe('appendDeferredWork', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bmad-defer-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates deferred-work.md with header when file does not exist', () => {
    appendDeferredWork(tempDir, '1-2-state', 'epic-1', 'Skill failed', 'bmad-dev-story');

    const filePath = join(tempDir, 'deferred-work.md');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('# Deferred Work');
    expect(content).toContain('### 1-2-state');
    expect(content).toContain('**Epic**: epic-1');
    expect(content).toContain('**Reason**: Skill failed');
    expect(content).toContain('**Last skill**: bmad-dev-story');
  });

  it('appends to existing deferred-work.md', () => {
    const filePath = join(tempDir, 'deferred-work.md');
    writeFileSync(filePath, '# Deferred Work\n\n### 1-1-setup\n- Existing entry\n\n');

    appendDeferredWork(tempDir, '1-2-state', 'epic-1', 'Review cycle limit');

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('### 1-1-setup');
    expect(content).toContain('### 1-2-state');
    expect(content).toContain('**Reason**: Review cycle limit');
  });

  it('omits skill line when skillName is not provided', () => {
    appendDeferredWork(tempDir, '1-3-runner', 'epic-1', 'Stuck state');

    const content = readFileSync(join(tempDir, 'deferred-work.md'), 'utf8');
    expect(content).not.toContain('**Last skill**');
    expect(content).toContain('**Reason**: Stuck state');
  });
});
