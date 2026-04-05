import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { SprintStatus, StoryStatus, NextAction } from './types.js';

const SKILL_MAP: Record<string, string> = {
  'backlog': 'bmad-create-story',
  'ready-for-dev': 'bmad-dev-story',
  'in-progress': 'bmad-dev-story',
  'review': 'bmad-code-review',
};

const STORY_KEY_PATTERN = /^\d+-\d+-.+$/;

/**
 * Check if a key represents a story (not an epic or retrospective).
 */
export function isStoryKey(key: string): boolean {
  return STORY_KEY_PATTERN.test(key) && !key.endsWith('-retrospective');
}

/**
 * Parse epic names from epics.md headings.
 * Supports both "# === Epic 1: Name ===" and "## Epic 1: Name" formats.
 * Returns a map of epic key → name (e.g., "epic-1" → "Core Orchestration Engine").
 */
export function parseEpicNames(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8');
  const names: Record<string, string> = {};
  // Match "# === Epic N: Name ===" or "## Epic N: Name" (with optional trailing ===)
  const pattern = /^\s*#{1,3}\s*(?:===\s*)?Epic\s+(\d+):\s*(.+?)\s*(?:===\s*)?$/gm;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const key = `epic-${match[1]}`;
    // First match per epic wins (heading takes priority over list items)
    if (!names[key]) {
      names[key] = match[2];
    }
  }
  return names;
}

/**
 * Parse epic descriptions from epics.md.
 * Extracts the paragraph immediately following each "## Epic N: Title" heading.
 * Returns a map of epic key → description (e.g., "epic-1" → "Build the foundational orchestrator...").
 */
export function parseEpicDescriptions(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8');
  const descriptions: Record<string, string> = {};
  // Match only "## Epic N: Title" (h2 level) section headings followed by a description paragraph.
  // Uses [^\n]+ for heading to avoid dotall crossing lines; (.+?) captures the description.
  const pattern = /^##\s+Epic\s+(\d+):[^\n]+\n\n(.+?)(?=\n\n###|\n\n---|\n\n##|\n\n\*\*|$)/gm;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const key = `epic-${match[1]}`;
    if (!descriptions[key]) {
      descriptions[key] = match[2].trim();
    }
  }
  return descriptions;
}

/**
 * Convert a story key slug into a human-readable title.
 * e.g., "1-2-sprint-status-state-machine" → "Sprint Status State Machine"
 */
export function humanizeStoryKey(key: string): string {
  // Strip leading epic-story number prefix (e.g., "1-2-" or "15-3-")
  const slug = key.replace(/^\d+-\d+-/, '');
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Extract a story's description and acceptance criteria from epics.md.
 * Maps story key "3-1-case-chat-interface" to "### Story 3.1:" heading.
 * Returns { title, storySection, acSection } or null if not found.
 */
export function parseStoryFromEpics(
  epicsFilePath: string,
  storyKey: string
): { title: string; storySection: string; acSection: string } | null {
  if (!existsSync(epicsFilePath)) return null;

  // Extract epic.story numbers from key (e.g., "3-1-..." → "3.1")
  const match = storyKey.match(/^(\d+)-(\d+)-/);
  if (!match) return null;
  const storyNum = `${match[1]}.${match[2]}`;

  const raw = readFileSync(epicsFilePath, 'utf8');

  // Find the "### Story N.M: Title" heading and extract content until next heading
  const headingPattern = new RegExp(
    `^###\\s+Story\\s+${storyNum.replace('.', '\\.')}:\\s*(.+)$`,
    'm'
  );
  const headingMatch = raw.match(headingPattern);
  if (!headingMatch) return null;

  const title = `Story ${storyNum}: ${headingMatch[1].trim()}`;
  const startIdx = raw.indexOf(headingMatch[0]) + headingMatch[0].length;

  // Extract until next "###" or "##" heading or end of file
  const rest = raw.slice(startIdx);
  const nextHeading = rest.search(/^#{2,3}\s+/m);
  const section = nextHeading > 0 ? rest.slice(0, nextHeading).trim() : rest.trim();

  // Split into story (user story) and acceptance criteria
  const acSplit = section.indexOf('**Acceptance Criteria:**');
  let storySection = '';
  let acSection = '';

  if (acSplit >= 0) {
    storySection = section.slice(0, acSplit).trim();
    acSection = section.slice(acSplit + '**Acceptance Criteria:**'.length).trim();
  } else {
    storySection = section;
  }

  return { title, storySection, acSection };
}

/**
 * Load and parse sprint-status.yaml.
 */
export function loadSprintStatus(filePath: string): SprintStatus {
  if (!existsSync(filePath)) {
    throw new Error(`Sprint status file not found: ${filePath}`);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read sprint status file: ${filePath} — ${err}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Malformed YAML in sprint status file: ${filePath} — ${err}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid sprint status: ${filePath} did not parse as a YAML object.`);
  }

  const obj = parsed as Record<string, unknown>;
  if (!obj.development_status || typeof obj.development_status !== 'object') {
    throw new Error(
      `Invalid sprint status: ${filePath} is missing 'development_status' section.`
    );
  }

  return obj as unknown as SprintStatus;
}

/**
 * Get the epic key for a story key (e.g., "1-4-password-reset" → "epic-1").
 */
export function getEpicForStory(storyKey: string): string {
  const epicNum = storyKey.split('-')[0];
  return `epic-${epicNum}`;
}

/**
 * Get all story keys belonging to an epic.
 */
export function getEpicStories(status: SprintStatus, epicKey: string): string[] {
  const epicNum = epicKey.replace('epic-', '');
  return Object.keys(status.development_status)
    .filter(key => isStoryKey(key) && key.startsWith(`${epicNum}-`));
}

/**
 * List all epic keys in the sprint status.
 */
export function getEpicKeys(status: SprintStatus): string[] {
  return Object.keys(status.development_status)
    .filter(key => key.startsWith('epic-') && !key.endsWith('-retrospective'));
}

/**
 * Determine the next actionable story and which skill to invoke.
 * If epicFilter is provided, only considers stories in that epic.
 * Returns null if all (filtered) stories are done.
 */
export function getNextAction(status: SprintStatus, epicFilter?: string): NextAction | null {
  const entries = Object.entries(status.development_status);

  for (const [key, value] of entries) {
    if (!isStoryKey(key)) continue;

    // If filtering by epic, skip stories outside it
    if (epicFilter) {
      const epicNum = epicFilter.replace('epic-', '');
      if (!key.startsWith(`${epicNum}-`)) continue;
    }

    const skill = SKILL_MAP[value];
    if (skill) {
      return {
        storyKey: key,
        currentStatus: value as StoryStatus,
        skill,
      };
    }
  }

  return null;
}

/**
 * Update a story's status in sprint-status.yaml, preserving comments and structure.
 */
export function updateStoryStatus(
  filePath: string,
  storyKey: string,
  newStatus: StoryStatus
): void {
  const raw = readFileSync(filePath, 'utf8');

  // Replace the specific story line, preserving indentation
  const pattern = new RegExp(`^(\\s*${escapeRegex(storyKey)}:\\s*)\\S+`, 'm');
  if (!pattern.test(raw)) {
    throw new Error(`Story key '${storyKey}' not found in ${filePath}`);
  }

  let updated = raw.replace(pattern, `$1${newStatus}`);

  // Update last_updated (both comment and field)
  const today = new Date().toISOString().split('T')[0];
  updated = updated.replace(
    /^(last_updated:\s*)\S+/m,
    `$1${today}`
  );
  updated = updated.replace(
    /^(# last_updated:\s*)\S+/m,
    `$1${today}`
  );

  writeFileSync(filePath, updated, 'utf8');
}

/**
 * Append a deferral entry to deferred-work.md in the implementation artifacts directory.
 * Creates the file with a header if it doesn't exist. This is an append-only log
 * for human review — the orchestrator uses sprint-status.yaml status for skip logic.
 */
export function appendDeferredWork(
  artifactsDir: string,
  storyKey: string,
  epicKey: string,
  reason: string,
  skillName?: string
): void {
  const filePath = `${artifactsDir}/deferred-work.md`;
  const timestamp = new Date().toISOString();

  if (!existsSync(filePath)) {
    writeFileSync(filePath, '# Deferred Work\n\nStories deferred during automated pipeline execution.\n\n', 'utf8');
  }

  const entry = [
    `### ${storyKey}`,
    `- **Deferred**: ${timestamp}`,
    `- **Epic**: ${epicKey}`,
    skillName ? `- **Last skill**: ${skillName}` : null,
    `- **Reason**: ${reason}`,
    `- **Action**: Manual intervention required`,
    '',
    '',
  ].filter(Boolean).join('\n');

  appendFileSync(filePath, entry, 'utf8');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
