import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SkillRunResult {
  skill: string;
  storyKey: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface CycleContext {
  cycleNumber: number;
  maxCycles: number;
  priorReviewFindings?: string | null;
  changedFilesSinceLastReview?: string[];
}

export interface RunnerOptions {
  projectRoot: string;
  timeoutMs?: number;
  dryRun?: boolean;
  maxBudgetUsd?: number;
  cycleContext?: CycleContext;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export const runnerEvents = new EventEmitter();

/**
 * Path to the shared live output file for cross-process dashboard communication.
 * Returns null if the runs directory can't be determined.
 */
export function getLiveOutputPath(outputDir: string): string {
  const runsDir = resolve(outputDir, 'autopilot-runs');
  if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
  return resolve(runsDir, '.live.jsonl');
}

function writeLive(liveFile: string | null, entry: Record<string, unknown>) {
  if (!liveFile) return;
  try { appendFileSync(liveFile, JSON.stringify(entry) + '\n'); } catch { /* ignore */ }
}

function clearLive(liveFile: string | null) {
  if (!liveFile) return;
  try { writeFileSync(liveFile, ''); } catch { /* ignore */ }
}

/**
 * Check if a directory contains a valid BMAD skill (workflow.md or workflow.yaml+instructions.xml).
 */
function isSkillDir(dir: string): boolean {
  return existsSync(resolve(dir, 'workflow.md')) ||
    (existsSync(resolve(dir, 'workflow.yaml')) && existsSync(resolve(dir, 'instructions.xml')));
}

/**
 * Locate the skill directory. Supports both BMAD v6.2+ (.claude/skills/bmad-{name}/workflow.md)
 * and v6.0 (_bmad/bmm/workflows/4-implementation/{name}/workflow.yaml+instructions.xml).
 *
 * Search order per root:
 * 1. .claude/skills/{skill}/                     (v6.2+ with bmad- prefix)
 * 2. _bmad/bmm/workflows/4-implementation/{name}/ (v6.0 without prefix)
 * 3. _bmad/bmm/4-implementation/{name}/           (v6.2 _bmad layout)
 *
 * Roots checked: target project → bmad-autopilot parent → grandparent
 */
function findSkillDir(skill: string, projectRoot: string): string | null {
  // Strip 'bmad-' prefix for v6.0 lookups (bmad-dev-story → dev-story)
  const shortName = skill.startsWith('bmad-') ? skill.slice(5) : skill;

  function checkRoot(root: string): string | null {
    // v6.2+ layout: .claude/skills/bmad-{name}/
    const claude = resolve(root, '.claude', 'skills', skill);
    if (isSkillDir(claude)) return claude;

    // v6.0 layout: _bmad/bmm/workflows/4-implementation/{name}/
    const bmadWorkflows = resolve(root, '_bmad', 'bmm', 'workflows', '4-implementation', shortName);
    if (isSkillDir(bmadWorkflows)) return bmadWorkflows;

    // v6.2 _bmad layout: _bmad/bmm/4-implementation/bmad-{name}/
    const bmadDirect = resolve(root, '_bmad', 'bmm', '4-implementation', skill);
    if (isSkillDir(bmadDirect)) return bmadDirect;

    return null;
  }

  // 1. Target project
  const inProject = checkRoot(projectRoot);
  if (inProject) return inProject;

  // 2. Relative to this file (bmad-autopilot lives inside a BMAD project)
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const bmadRoot = resolve(thisDir, '..', '..');
  const inBmadRoot = checkRoot(bmadRoot);
  if (inBmadRoot) return inBmadRoot;

  // 3. One more level up
  const inParent = checkRoot(resolve(bmadRoot, '..'));
  if (inParent) return inParent;

  return null;
}

/**
 * Build the prompt for a skill invocation.
 * Supports both workflow.md (v6.2+) and workflow.yaml+instructions.xml (v6.0).
 * When cycleContext is provided, injects review cycle history to help convergence.
 */
function buildSkillPrompt(skill: string, storyKey: string, skillDir: string, cycleContext?: CycleContext): string {
  let workflow: string;

  const workflowMd = resolve(skillDir, 'workflow.md');
  const instructionsXml = resolve(skillDir, 'instructions.xml');
  const workflowYaml = resolve(skillDir, 'workflow.yaml');

  if (existsSync(workflowMd)) {
    // v6.2+ format: workflow.md contains the full instructions
    workflow = readFileSync(workflowMd, 'utf8');
  } else if (existsSync(instructionsXml)) {
    // v6.0 format: workflow.yaml (config) + instructions.xml (actual workflow)
    const yamlContent = existsSync(workflowYaml) ? readFileSync(workflowYaml, 'utf8') : '';
    const xmlContent = readFileSync(instructionsXml, 'utf8');
    workflow = `--- WORKFLOW CONFIG ---\n${yamlContent}\n--- WORKFLOW INSTRUCTIONS ---\n${xmlContent}`;
  } else {
    throw new Error(`No workflow.md or instructions.xml found in ${skillDir}`);
  }

  let cycleSection = '';
  if (cycleContext && cycleContext.cycleNumber > 1) {
    const changedFiles = cycleContext.changedFilesSinceLastReview?.length
      ? cycleContext.changedFilesSinceLastReview.join('\n  ')
      : '(not available)';

    if (skill.includes('dev-story')) {
      cycleSection = `
--- CYCLE CONTEXT ---
This is review-fix cycle ${cycleContext.cycleNumber} of ${cycleContext.maxCycles}.
You are addressing review findings from the previous cycle. Focus ONLY on unchecked [AI-Review] tasks.
Do NOT re-implement already-completed tasks. Do NOT refactor working code unless a review finding requires it.
${cycleContext.priorReviewFindings ? `\nPrior review findings:\n${cycleContext.priorReviewFindings}` : ''}
Files changed since last review:
  ${changedFiles}
--- END CYCLE CONTEXT ---
`;
    } else if (skill.includes('code-review')) {
      cycleSection = `
--- CYCLE CONTEXT ---
This is review cycle ${cycleContext.cycleNumber} of ${cycleContext.maxCycles}.
Previous review findings were already addressed by the developer. Focus your review ONLY on:
1. Whether the prior findings were actually fixed
2. Any NEW issues introduced by the fixes
Do NOT re-review code that was already approved in previous cycles.
Do NOT raise new findings on unchanged code.

Files changed since last review (scope your review to these):
  ${changedFiles}
${cycleContext.priorReviewFindings ? `\nPrior review section for reference:\n${cycleContext.priorReviewFindings}` : ''}
--- END CYCLE CONTEXT ---
`;
    }
  }

  return `You are running the BMAD skill "${skill}" for story "${storyKey}".

Execute the following workflow completely. The target story key is: ${storyKey}

If the workflow asks for story selection, automatically select: ${storyKey}
If the workflow references other files in the skill directory, they are available via the --add-dir path.

--- WORKFLOW START ---
${workflow}
--- WORKFLOW END ---
${cycleSection}
Begin execution now. Target story: ${storyKey}`;
}

/**
 * Invoke a BMAD skill via the Claude Code CLI as a subprocess.
 * Streams stdout/stderr line-by-line via runnerEvents so UI can show live output.
 */
export async function runSkill(
  skill: string,
  storyKey: string,
  options: RunnerOptions & { liveFile?: string }
): Promise<SkillRunResult> {
  const { projectRoot, timeoutMs = DEFAULT_TIMEOUT_MS, dryRun = false, liveFile, maxBudgetUsd, cycleContext } = options;

  if (dryRun) {
    runnerEvents.emit('skill_dry_run', { skill, storyKey });
    return {
      skill, storyKey, exitCode: 0, durationMs: 0,
      output: `[DRY RUN] Would invoke: ${skill}`,
    };
  }

  // Find the skill directory
  const skillDir = findSkillDir(skill, projectRoot);
  if (!skillDir) {
    const msg = `Skill '${skill}' not found. Checked:\n` +
      `  - ${resolve(projectRoot, '.claude/skills', skill)}/workflow.md\n` +
      `  - BMAD install relative to autopilot package\n` +
      `Install BMAD skills in the project or ensure bmad-autopilot is inside a BMAD project.`;
    runnerEvents.emit('skill_error', {
      skill, storyKey, exitCode: 127, stderr: msg,
      timestamp: new Date().toISOString(),
    });
    return { skill, storyKey, exitCode: 127, durationMs: 0, output: msg };
  }

  const prompt = buildSkillPrompt(skill, storyKey, skillDir, cycleContext);

  // Build args: use -p with stdin piping for the prompt (avoids CLI arg length limits).
  // --output-format stream-json + --verbose gives us structured streaming output.
  const args = [
    '--dangerously-skip-permissions',
    '-p',
    '--add-dir', skillDir,
    '--output-format', 'stream-json',
    '--verbose',
  ];

  // Budget control: configurable per invocation, omit for unlimited (Pro Max accounts)
  if (maxBudgetUsd !== undefined && maxBudgetUsd > 0) {
    args.push('--max-budget-usd', String(maxBudgetUsd));
  }

  return new Promise<SkillRunResult>((resolvePromise) => {
    clearLive(liveFile || null);
    writeLive(liveFile || null, { event: 'skill_start', skill, storyKey });
    runnerEvents.emit('skill_start', { skill, storyKey, timestamp: new Date().toISOString() });
    runnerEvents.emit('skill_output', {
      skill, storyKey, line: `Skill dir: ${skillDir}`, type: 'info',
      raw: '', timestamp: new Date().toISOString(),
    });
    const startTime = Date.now();
    const outputChunks: string[] = [];
    let killed = false;

    const child = spawn('claude', args, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Pipe prompt via stdin instead of CLI arg — avoids shell arg length limits
    // and allows the full prompt to be passed cleanly
    child.stdin.write(prompt);
    child.stdin.end();

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
    }, timeoutMs);

    let stdoutBuffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      outputChunks.push(text);
      stdoutBuffer += text;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseStreamLine(line);
        if (!parsed.display) continue; // skip empty/noise lines
        writeLive(liveFile || null, { event: 'output', line: parsed.display, type: parsed.type });
        runnerEvents.emit('skill_output', {
          skill, storyKey, line: parsed.display, type: parsed.type,
          raw: line, timestamp: new Date().toISOString(),
        });
      }
    });

    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrBuffer += text;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        runnerEvents.emit('skill_output', {
          skill, storyKey, line: line.trim(), type: 'stderr',
          raw: line, timestamp: new Date().toISOString(),
        });
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (stdoutBuffer.trim()) {
        const parsed = parseStreamLine(stdoutBuffer);
        runnerEvents.emit('skill_output', {
          skill, storyKey, line: parsed.display, type: parsed.type,
          raw: stdoutBuffer, timestamp: new Date().toISOString(),
        });
      }

      const output = outputChunks.join('');
      const exitCode = killed ? 124 : (code ?? 1);

      if (killed) {
        runnerEvents.emit('skill_timeout', {
          skill, storyKey, timeoutMs, timestamp: new Date().toISOString(),
        });
        resolvePromise({ skill, storyKey, exitCode: 124, durationMs, output: `Skill timed out after ${timeoutMs}ms` });
        return;
      }

      if (exitCode === 0) {
        writeLive(liveFile || null, { event: 'skill_complete', skill, storyKey, durationMs });
        runnerEvents.emit('skill_complete', {
          skill, storyKey, durationMs, timestamp: new Date().toISOString(),
        });
      } else {
        const lastStderr = stderrBuffer.split('\n').slice(-50).join('\n');
        writeLive(liveFile || null, { event: 'skill_error', skill, storyKey, exitCode });
        runnerEvents.emit('skill_error', {
          skill, storyKey, exitCode, stderr: lastStderr,
          timestamp: new Date().toISOString(),
        });
      }

      resolvePromise({ skill, storyKey, exitCode, durationMs, output: exitCode === 0 ? output : stderrBuffer });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      runnerEvents.emit('skill_error', {
        skill, storyKey, exitCode: 1, stderr: err.message,
        timestamp: new Date().toISOString(),
      });
      resolvePromise({ skill, storyKey, exitCode: 1, durationMs, output: err.message });
    });
  });
}

function parseStreamLine(line: string): { display: string; type: string } {
  try {
    const obj = JSON.parse(line);

    // ── Top-level assistant message wrapper ──
    // {"type":"assistant","message":{...},"content":[...]}
    if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
      const content = obj.message.content || obj.content;
      if (!content) return { display: '', type: 'assistant' };
      const parts = Array.isArray(content) ? content : [content];
      const lines: { display: string; type: string }[] = [];
      for (const part of parts) {
        if (typeof part === 'string') {
          if (part.trim()) lines.push({ display: part, type: 'assistant' });
        } else if (part.type === 'text' && part.text?.trim()) {
          lines.push({ display: part.text, type: 'assistant' });
        } else if (part.type === 'tool_use') {
          lines.push(formatToolUse(part));
        }
      }
      if (lines.length === 0) return { display: '', type: 'assistant' };
      // Return first meaningful line (multi-content gets split in stdout chunks)
      return lines[0];
    }

    // ── Simple assistant content (no wrapper) ──
    if (obj.type === 'assistant' && obj.content) {
      const text = typeof obj.content === 'string'
        ? obj.content
        : obj.content.map((c: { text?: string }) => c.text || '').join('');
      return { display: text, type: 'assistant' };
    }

    // ── Direct tool_use event ──
    if (obj.type === 'tool_use') {
      return formatToolUse(obj);
    }

    // ── User message wrapper (contains tool results going back to Claude) ──
    if (obj.type === 'user' && obj.message?.role === 'user') {
      const content = obj.message.content || [];
      const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
      for (const part of parts) {
        if (part.type === 'tool_result') {
          const text = typeof part.content === 'string'
            ? part.content
            : Array.isArray(part.content)
              ? part.content.map((c: { text?: string }) => c.text || '').join(' ')
              : JSON.stringify(part.content);
          const clean = text.replace(/\\n/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
          if (part.is_error) return { display: `Error: ${clean}`, type: 'stderr' };
          return { display: clean, type: 'tool_result' };
        }
      }
      return { display: '', type: 'raw' };
    }

    // ── Direct tool_result event ──
    if (obj.type === 'tool_result') {
      const content = typeof obj.content === 'string'
        ? obj.content
        : JSON.stringify(obj.content);
      const clean = content.replace(/\\n/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
      return { display: clean, type: 'tool_result' };
    }

    // ── Final result ──
    if (obj.type === 'result') {
      return { display: `Done: ${(obj.result || '').slice(0, 300)}`, type: 'result' };
    }

    // ── System messages ──
    if (obj.type === 'system') {
      const sub = obj.subtype || '';
      if (sub === 'rate_limit_event') return { display: '', type: 'raw' };
      return { display: `${obj.description || obj.message || sub}`.slice(0, 200), type: 'info' };
    }

    return { display: '', type: 'raw' };
  } catch {
    // Non-JSON line — show as plain text
    return { display: line, type: 'text' };
  }
}

function formatToolUse(obj: Record<string, unknown>): { display: string; type: string } {
  const name = (obj.name as string) || 'unknown';
  const input = (obj.input as Record<string, unknown>) || {};
  let detail = '';
  if (name === 'Read' || name === 'Write') detail = (input.file_path as string) || '';
  else if (name === 'Edit') detail = (input.file_path as string) || '';
  else if (name === 'Grep') detail = `"${input.pattern || ''}"${input.path ? ' in ' + input.path : ''}`;
  else if (name === 'Glob') detail = (input.pattern as string) || '';
  else if (name === 'Bash') detail = ((input.command as string) || '').slice(0, 120);
  else if (name === 'Agent') detail = (input.description as string) || '';
  else {
    const summary = Object.entries(input).slice(0, 2).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(', ');
    if (summary) detail = summary;
  }
  return { display: detail ? `${name} → ${detail}` : name, type: 'tool' };
}
