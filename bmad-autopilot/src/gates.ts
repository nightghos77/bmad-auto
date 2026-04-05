import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface GateResult {
  passed: boolean;
  gate: string;
  details: string;
}

/**
 * Detect the test command for a project.
 */
export function detectTestCommand(projectRoot: string): string | null {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg.scripts?.test) return 'npm test';
  }

  // Python
  if (existsSync(resolve(projectRoot, 'pytest.ini')) ||
      existsSync(resolve(projectRoot, 'pyproject.toml'))) {
    return 'pytest';
  }

  return null;
}

/**
 * Parse failing test names from test output.
 */
function parseFailingTests(output: string): Set<string> {
  const failures = new Set<string>();
  // Match vitest/jest FAIL lines: "FAIL path/to/test.ts > Suite > Test Name"
  for (const match of output.matchAll(/FAIL\s+(.+?)\s*$/gm)) {
    failures.add(match[1].trim());
  }
  // Also match "✗" or "×" markers
  for (const match of output.matchAll(/[✗×]\s+(.+?)\s*$/gm)) {
    failures.add(match[1].trim());
  }
  return failures;
}

/**
 * Run tests and return the raw output + exit code.
 */
function runTests(projectRoot: string, testCmd: string): { exitCode: number; output: string } {
  try {
    const [cmd, ...args] = testCmd.split(' ');
    const stdout = execFileSync(cmd, args, {
      cwd: projectRoot,
      timeout: 5 * 60 * 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true' },
    });
    return { exitCode: 0, output: stdout.toString('utf8') };
  } catch (err: unknown) {
    const error = err as { status?: number; stderr?: Buffer; stdout?: Buffer };
    const output = (error.stdout?.toString('utf8') || '') + (error.stderr?.toString('utf8') || '');
    return { exitCode: error.status ?? 1, output };
  }
}

/**
 * Capture the current test baseline — which tests are already failing.
 * Returns null if tests all pass or no test command exists.
 */
export function captureTestBaseline(projectRoot: string): Set<string> | null {
  const testCmd = detectTestCommand(projectRoot);
  if (!testCmd) return null;

  const result = runTests(projectRoot, testCmd);
  if (result.exitCode === 0) return null; // all green, no baseline needed

  return parseFailingTests(result.output);
}

/**
 * Run the project's test suite as a quality gate.
 * If a baseline of pre-existing failures is provided, only NEW failures cause a halt.
 */
export function runTestGate(projectRoot: string, baseline?: Set<string> | null): GateResult {
  const testCmd = detectTestCommand(projectRoot);
  if (!testCmd) {
    return {
      passed: true,
      gate: 'test-suite',
      details: 'No test command detected — skipping gate.',
    };
  }

  const result = runTests(projectRoot, testCmd);

  if (result.exitCode === 0) {
    return {
      passed: true,
      gate: 'test-suite',
      details: `Test suite passed (${testCmd}).`,
    };
  }

  // Tests failed — check if these are NEW failures or pre-existing
  const currentFailures = parseFailingTests(result.output);

  if (baseline && baseline.size > 0) {
    const newFailures = new Set<string>();
    for (const f of currentFailures) {
      if (!baseline.has(f)) newFailures.add(f);
    }

    if (newFailures.size === 0) {
      return {
        passed: true,
        gate: 'test-suite',
        details: `Test suite has ${currentFailures.size} pre-existing failure(s) (unchanged). No new failures introduced.`,
      };
    }

    const failList = [...newFailures].slice(0, 5).join('\n');
    return {
      passed: false,
      gate: 'test-suite',
      details: `${newFailures.size} NEW test failure(s) introduced (${currentFailures.size} total, ${baseline.size} pre-existing):\n${failList}`,
    };
  }

  // No baseline — any failure halts
  const lastLines = result.output.split('\n').slice(-20).join('\n');
  return {
    passed: false,
    gate: 'test-suite',
    details: `Test suite failed:\n${lastLines}`,
  };
}

/**
 * Severity counts from a story's review section.
 */
export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * Count review severity markers in a story file.
 * Returns zeroes if the file doesn't exist or has no review section.
 */
export function evaluateSoftPass(storyFilePath: string): SeverityCounts {
  if (!existsSync(storyFilePath)) {
    return { critical: 0, high: 0, medium: 0, low: 0 };
  }

  const content = readFileSync(storyFilePath, 'utf8');

  const reviewMatch = content.match(/##\s*Senior Developer Review/i) ||
                       content.match(/##\s*Review Findings/i);
  if (!reviewMatch) {
    return { critical: 0, high: 0, medium: 0, low: 0 };
  }

  return {
    critical: (content.match(/\[Critical\]/gi) || []).length,
    high: (content.match(/\[High\]/gi) || []).length,
    medium: (content.match(/\[Medium\]/gi) || []).length,
    low: (content.match(/\[Low\]/gi) || []).length,
  };
}

/**
 * Extract the "Senior Developer Review (AI)" section from a story file.
 * Returns null if not found. Used for passing review context between cycles.
 */
export function extractReviewSection(storyFilePath: string): string | null {
  if (!existsSync(storyFilePath)) return null;

  const content = readFileSync(storyFilePath, 'utf8');
  const startMatch = content.match(/##\s*Senior Developer Review/i) ||
                      content.match(/##\s*Review Findings/i);
  if (!startMatch || startMatch.index === undefined) return null;

  const startIdx = startMatch.index;
  // Find the next ## heading after the review section
  const rest = content.slice(startIdx + startMatch[0].length);
  const nextHeading = rest.match(/\n##\s+/);
  const section = nextHeading && nextHeading.index !== undefined
    ? content.slice(startIdx, startIdx + startMatch[0].length + nextHeading.index)
    : content.slice(startIdx);

  // Cap at 2000 chars to control prompt size
  if (section.length > 2000) {
    return section.slice(0, 2000) + '\n[... truncated]';
  }
  return section;
}

/**
 * Parse code review findings from a story file and gate on severity.
 */
export function runReviewGate(storyFilePath: string): GateResult {
  if (!existsSync(storyFilePath)) {
    return {
      passed: true,
      gate: 'code-review-severity',
      details: 'Story file not found — skipping review gate.',
    };
  }

  const { critical, high, medium, low } = evaluateSoftPass(storyFilePath);

  // No review section means no findings
  if (critical === 0 && high === 0 && medium === 0 && low === 0) {
    const content = existsSync(storyFilePath) ? readFileSync(storyFilePath, 'utf8') : '';
    const hasReview = /##\s*Senior Developer Review/i.test(content) || /##\s*Review Findings/i.test(content);
    if (!hasReview) {
      return {
        passed: true,
        gate: 'code-review-severity',
        details: 'No review findings section found — gate passes.',
      };
    }
  }

  if (critical > 0 || high > 0) {
    return {
      passed: false,
      gate: 'code-review-severity',
      details: `Review found ${critical} Critical, ${high} High, ${medium} Medium, ${low} Low issues. HALT: Critical/High findings require human attention.`,
    };
  }

  return {
    passed: true,
    gate: 'code-review-severity',
    details: `Review clean: ${medium} Medium, ${low} Low issues (auto-pass threshold).`,
  };
}
