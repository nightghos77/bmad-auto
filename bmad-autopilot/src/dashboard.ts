import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { readFileSync, existsSync, readdirSync, statSync, watch } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { loadSprintStatus, getNextAction, isStoryKey, parseEpicNames, parseEpicDescriptions, humanizeStoryKey, parseStoryFromEpics } from './state.js';
import { runnerEvents } from './runner.js';
import { orchestratorEvents } from './orchestrator.js';
import type { SprintStatus, ResolvedConfig } from './types.js';

interface DashboardOptions {
  projectRoot: string;
  port: number;
}

export function startDashboard(options: DashboardOptions): { close: () => void } {
  const { projectRoot, port } = options;
  const config = loadConfig(projectRoot);
  const statusFile = resolve(config.implementation_artifacts, 'sprint-status.yaml');

  const sseClients = new Set<ServerResponse>();

  // Track current activity so new SSE clients get caught up
  let currentActivity: { skill: string; storyKey: string } | null = null;
  const recentOutput: { line: string; type: string }[] = [];

  function broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      client.write(payload);
    }
  }

  // Wire all events to SSE
  runnerEvents.on('skill_start', (d) => {
    currentActivity = { skill: d.skill, storyKey: d.storyKey };
    recentOutput.length = 0;
    broadcast('skill_start', d);
  });
  runnerEvents.on('skill_complete', (d) => { currentActivity = null; recentOutput.length = 0; broadcast('skill_complete', d); });
  runnerEvents.on('skill_error', (d) => broadcast('skill_error', d));
  runnerEvents.on('skill_timeout', (d) => { currentActivity = null; broadcast('skill_timeout', d); });
  runnerEvents.on('skill_output', (d) => {
    recentOutput.push({ line: d.line, type: d.type });
    if (recentOutput.length > 200) recentOutput.splice(0, recentOutput.length - 200);
    broadcast('skill_output', d);
  });
  orchestratorEvents.on('log', (msg: string) => broadcast('log', { message: msg }));
  orchestratorEvents.on('outcome', (outcome: string) => { currentActivity = null; broadcast('outcome', { outcome }); });
  orchestratorEvents.on('halt', (reason: string, story: string) => { currentActivity = null; broadcast('halt', { reason, story }); });
  orchestratorEvents.on('gate', (result: unknown) => broadcast('gate', result));

  // ─── File watchers for standalone dashboard mode ───
  // Watches the JSONL run log and the .live.jsonl streaming output file
  // so the dashboard can show activity from a separate bmad-auto process.
  const runsDir = resolve(config.output_folder, 'autopilot-runs');
  const liveFilePath = resolve(runsDir, '.live.jsonl');
  let logWatcher: ReturnType<typeof watch> | null = null;
  let liveWatcher: ReturnType<typeof watch> | null = null;
  let watchedFile = '';
  let watchedOffset = 0;
  let liveOffset = 0;

  function findLatestLog(): string | null {
    if (!existsSync(runsDir)) return null;
    // Search both top-level and epic-scoped subdirectories for the newest log
    const candidates: { path: string; mtime: number }[] = [];
    const addFiles = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.jsonl') && !f.startsWith('.')) {
          const full = resolve(dir, f);
          candidates.push({ path: full, mtime: statSync(full).mtimeMs });
        }
      }
    };
    addFiles(runsDir);
    // Check epic subdirectories (e.g., autopilot-runs/epic-1/)
    for (const entry of readdirSync(runsDir)) {
      const sub = resolve(runsDir, entry);
      try { if (statSync(sub).isDirectory()) addFiles(sub); } catch { /* skip */ }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0].path;
  }

  function processLogLine(line: string) {
    try {
      const entry = JSON.parse(line);
      switch (entry.event) {
        case 'run_start':
          broadcast('log', { message: `Run started` });
          break;
        case 'action_selected':
          if (!currentActivity || currentActivity.storyKey !== entry.story) {
            currentActivity = { skill: entry.skill, storyKey: entry.story };
            recentOutput.length = 0;
            broadcast('skill_start', { skill: entry.skill, storyKey: entry.story });
            broadcast('log', { message: `[${entry.story}] ${entry.status} → ${entry.skill}` });
          }
          break;
        case 'skill_result':
          if (entry.exitCode === 0) {
            currentActivity = null;
            recentOutput.length = 0;
            broadcast('skill_complete', { skill: entry.skill, storyKey: entry.story, durationMs: entry.durationMs });
          } else {
            broadcast('skill_error', { skill: entry.skill, storyKey: entry.story, exitCode: entry.exitCode });
          }
          break;
        case 'halt':
          currentActivity = null;
          broadcast('halt', { reason: entry.reason, story: entry.story });
          break;
        case 'sprint_complete':
        case 'run_end':
          currentActivity = null;
          broadcast('outcome', { outcome: 'complete' });
          break;
        case 'gate':
          broadcast('gate', { gate: entry.gate, passed: entry.passed, details: entry.details });
          break;
      }
    } catch { /* skip unparseable lines */ }
  }

  function processLiveLine(line: string) {
    try {
      const entry = JSON.parse(line);
      if (entry.event === 'output') {
        const d = { line: entry.line, type: entry.type };
        recentOutput.push(d);
        if (recentOutput.length > 200) recentOutput.splice(0, recentOutput.length - 200);
        broadcast('skill_output', d);
      } else if (entry.event === 'skill_start') {
        currentActivity = { skill: entry.skill, storyKey: entry.storyKey };
        recentOutput.length = 0;
        broadcast('skill_start', entry);
      } else if (entry.event === 'skill_complete') {
        currentActivity = null;
        recentOutput.length = 0;
        broadcast('skill_complete', entry);
      } else if (entry.event === 'skill_error') {
        broadcast('skill_error', entry);
      }
    } catch { /* skip */ }
  }

  function tailFile(filePath: string, offset: number, handler: (line: string) => void): number {
    if (!existsSync(filePath)) return offset;
    const content = readFileSync(filePath, 'utf8');
    // Handle file truncation (new skill started)
    if (content.length < offset) offset = 0;
    const newContent = content.slice(offset);
    const lines = newContent.split('\n').filter(l => l.trim());
    for (const line of lines) handler(line);
    return content.length;
  }

  function startFileWatchers() {
    const checkRunLog = () => {
      const latest = findLatestLog();
      if (!latest) return;
      if (latest !== watchedFile) {
        watchedFile = latest;
        watchedOffset = 0;
      }
      watchedOffset = tailFile(latest, watchedOffset, processLogLine);
    };

    const checkLive = () => {
      liveOffset = tailFile(liveFilePath, liveOffset, processLiveLine);
    };

    // Initial check
    checkRunLog();
    checkLive();

    // Poll-based tailing — fs.watch is unreliable on macOS for rapidly-written files.
    // 500ms gives near-realtime updates without excessive IO.
    setInterval(() => {
      checkRunLog();
      checkLive();
    }, 500);
  }

  startFileWatchers();

  function getStatusPayload() {
    const status = loadSprintStatus(statusFile);
    const next = getNextAction(status);
    const epicsFile = resolve(config.planning_artifacts, 'epics.md');
    const epicNames = parseEpicNames(epicsFile);
    const epicDescriptions = parseEpicDescriptions(epicsFile);
    const epics = buildEpicStructure(status, epicNames, epicDescriptions);
    return { status, next, epics, project: config.project_name };
  }

  function getStoryDetail(storyKey: string) {
    // Use story_location from sprint-status.yaml (BMAD's source of truth), fallback to config
    const sprintStatus = loadSprintStatus(statusFile);
    const storyDir = sprintStatus.story_location
      ? resolve(projectRoot, sprintStatus.story_location)
      : config.implementation_artifacts;
    const storyFile = resolve(storyDir, `${storyKey}.md`);
    let content = '';
    let exists = false;
    if (existsSync(storyFile)) {
      content = readFileSync(storyFile, 'utf8');
      exists = true;
    }

    // If no story file, fall back to extracting from epics.md
    if (!exists) {
      const epicsFile = resolve(config.planning_artifacts, 'epics.md');
      const epicData = parseStoryFromEpics(epicsFile, storyKey);
      if (epicData) {
        return {
          exists: true,
          source: 'epics' as const,
          title: epicData.title,
          status: sprintStatus.development_status[storyKey] || 'unknown',
          storySection: epicData.storySection,
          acSection: epicData.acSection,
          tasksSection: '',
          devNotes: '',
          storyKey,
        };
      }
    }

    // Parse sections from the markdown — try multiple heading variants for robustness
    const title = content.match(/^#\s+(.+)/m)?.[1] || storyKey;
    const storySection = extractSection(content, 'Story') || extractSection(content, 'User Story') || extractSection(content, 'Description');
    const acSection = extractSection(content, 'Acceptance Criteria') || extractSection(content, 'Criteria');
    const tasksSection = extractSection(content, 'Tasks / Subtasks') || extractSection(content, 'Tasks') || extractSection(content, 'Subtasks') || extractSection(content, 'Implementation Tasks');
    const devNotes = extractSection(content, 'Dev Notes') || extractSection(content, 'Dev Agent Record') || extractSection(content, 'Notes');
    const statusMatch = content.match(/^Status:\s*(.+)/m);
    const status = statusMatch ? statusMatch[1].trim() : 'unknown';

    // If story file exists but has no parsed sections, try epics.md fallback for description
    let epicFallback: { storySection?: string; acSection?: string } | null = null;
    if (exists && !storySection && !tasksSection) {
      const epicsFile = resolve(config.planning_artifacts, 'epics.md');
      epicFallback = parseStoryFromEpics(epicsFile, storyKey);
    }

    // Extract all ## headings found in the file for debugging
    const headingsFound = [...content.matchAll(/^##\s+(.+)/gm)].map(m => m[1]);

    return {
      exists, title, status, storyKey,
      storySection: storySection || epicFallback?.storySection || '',
      acSection: acSection || epicFallback?.acSection || '',
      tasksSection,
      devNotes,
      headingsFound,
    };
  }

  function getStoryCommits(storyKey: string) {
    try {
      const out = execSync(
        `git log --all --oneline --format="%H|||%h|||%s|||%an|||%ar" --grep="${storyKey}" -- . 2>/dev/null || true`,
        { cwd: projectRoot, encoding: 'utf8', timeout: 10000 }
      );
      const commits = out.trim().split('\n').filter(Boolean).map(line => {
        const [hash, short, message, author, date] = line.split('|||');
        return { hash, short, message, author, date };
      });
      // Also get recent commits that mention the story key in changed files
      const fileCommits = execSync(
        `git log --all --oneline --format="%H|||%h|||%s|||%an|||%ar" -20 -- . 2>/dev/null || true`,
        { cwd: projectRoot, encoding: 'utf8', timeout: 10000 }
      );
      const recentAll = fileCommits.trim().split('\n').filter(Boolean).map(line => {
        const [hash, short, message, author, date] = line.split('|||');
        return { hash, short, message, author, date };
      });
      // Deduplicate
      const seen = new Set(commits.map(c => c.hash));
      const related = recentAll.filter(c => !seen.has(c.hash) && c.message?.toLowerCase().includes(storyKey.toLowerCase()));
      return [...commits, ...related];
    } catch {
      return [];
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/';

    if (url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(getStatusPayload()));
      return;
    }

    if (url.startsWith('/api/story/')) {
      const storyKey = decodeURIComponent(url.slice('/api/story/'.length));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(getStoryDetail(storyKey)));
      return;
    }

    if (url.startsWith('/api/commits/')) {
      const storyKey = decodeURIComponent(url.slice('/api/commits/'.length));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(getStoryCommits(storyKey)));
      return;
    }

    if (url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
      sseClients.add(res);
      // Catch up new client with current activity
      if (currentActivity) {
        res.write(`event: skill_start\ndata: ${JSON.stringify(currentActivity)}\n\n`);
        for (const line of recentOutput.slice(-80)) {
          res.write(`event: skill_output\ndata: ${JSON.stringify(line)}\n\n`);
        }
      }
      req.on('close', () => sseClients.delete(res));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHTML(config.project_name));
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Dashboard error: port ${port} is already in use.`);
      console.error(`  Try: bmad-auto run --dashboard --port ${port + 1}\n`);
    } else {
      console.error(`\n  Dashboard error: ${err.message}\n`);
    }
  });

  server.listen(port, () => {
    console.log(`\n  BMAD Autopilot Dashboard: http://localhost:${port}\n`);
  });

  return {
    close: () => {
      for (const client of sseClients) client.end();
      sseClients.clear();
      server.close();
    },
  };
}

function extractSection(content: string, heading: string): string {
  const regex = new RegExp(`^##\\s+${heading}[\\s\\S]*?(?=^##\\s|$(?!\\n))`, 'm');
  const match = content.match(regex);
  if (!match) return '';
  return match[0].replace(new RegExp(`^##\\s+${heading}\\s*\\n?`), '').trim();
}

function buildEpicStructure(status: SprintStatus, epicNames: Record<string, string> = {}, epicDescriptions: Record<string, string> = {}) {
  const entries = Object.entries(status.development_status);
  const epics: { key: string; name: string; description: string; status: string; stories: { key: string; title: string; status: string }[] }[] = [];
  let current: typeof epics[0] | null = null;

  for (const [key, value] of entries) {
    if (key.startsWith('epic-') && !key.endsWith('-retrospective')) {
      current = { key, name: epicNames[key] || '', description: epicDescriptions[key] || '', status: value, stories: [] };
      epics.push(current);
    } else if (!key.endsWith('-retrospective') && isStoryKey(key) && current) {
      current.stories.push({ key, title: humanizeStoryKey(key), status: value });
    }
  }
  return epics;
}

function getDashboardHTML(projectName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BMAD Autopilot \u2014 ${projectName}</title>
<style>
:root {
  --bg: #0d1117; --surface: #161b22; --surface2: #1c2129; --border: #30363d;
  --text: #e6edf3; --text-dim: #8b949e; --accent: #58a6ff;
  --green: #3fb950; --yellow: #d29922; --red: #f85149;
  --blue: #58a6ff; --cyan: #39d2c0; --purple: #bc8cff; --orange: #db6d28;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  background:var(--bg); color:var(--text); line-height:1.5; }

/* Header */
.header { background:var(--surface); border-bottom:1px solid var(--border);
  padding:12px 24px; display:flex; align-items:center; justify-content:space-between;
  position:sticky; top:0; z-index:100; }
.header h1 { font-size:18px; font-weight:600; display:flex; align-items:center; gap:8px; }
.header .right { display:flex; align-items:center; gap:16px; }
.header .project { color:var(--text-dim); font-size:13px; }
.conn-dot { width:8px; height:8px; border-radius:50%; background:var(--red); display:inline-block; }
.conn-dot.connected { background:var(--green); }

/* Overall progress bar in header */
.overall-progress { display:flex; align-items:center; gap:8px; }
.overall-bar { width:120px; height:6px; background:var(--border); border-radius:3px; overflow:hidden; }
.overall-fill { height:100%; background:var(--green); border-radius:3px; transition:width .5s; }
.overall-text { font-size:12px; color:var(--text-dim); }

/* Layout: activity hero on top, then 2-col below */
.layout { max-width:1400px; margin:0 auto; padding:16px 24px; }
.card { background:var(--surface); border:1px solid var(--border); border-radius:8px; overflow:hidden; margin-bottom:16px; }
.card-header { padding:10px 16px; border-bottom:1px solid var(--border); font-weight:600;
  font-size:13px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-dim);
  display:flex; align-items:center; gap:8px; cursor:default; }
.card-body { padding:16px; }
.two-col { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
@media (max-width:900px) { .two-col { grid-template-columns:1fr; } }

/* Hero: status + activity combined */
.hero { display:grid; grid-template-columns:280px 1fr; gap:0; margin-bottom:16px; }
@media (max-width:900px) { .hero { grid-template-columns:1fr; } }
.hero-status { background:var(--surface); border:1px solid var(--border); border-radius:8px 0 0 8px;
  padding:16px 20px; display:flex; flex-direction:column; justify-content:center; gap:8px; }
@media (max-width:900px) { .hero-status { border-radius:8px 8px 0 0; } }
.hero-activity { background:var(--surface); border:1px solid var(--border); border-left:none;
  border-radius:0 8px 8px 0; padding:16px; min-height:180px; }
@media (max-width:900px) { .hero-activity { border-left:1px solid var(--border); border-top:none; border-radius:0 0 8px 8px; } }
.hero-outcome { font-size:20px; font-weight:700; display:flex; align-items:center; gap:8px; }
.hero-stat { font-size:13px; color:var(--text-dim); }
.hero-stat strong { color:var(--text); }
.hero-next { font-size:12px; color:var(--cyan); margin-top:4px; }
.current-step { margin-top:2px; }
.step-story { font-size:12px; color:var(--text-dim); display:block; line-height:1.4; }
.step-task { font-size:11px; margin-top:4px; display:flex; align-items:center; gap:6px; }
.step-task-progress { color:var(--cyan); font-weight:600; white-space:nowrap; }
.step-task-current { color:var(--yellow); font-style:italic; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:200px; }

/* Activity panel */
.activity-header { font-size:14px; font-weight:600; color:var(--cyan); display:flex; align-items:center; gap:8px; margin-bottom:4px; }
.activity-story { font-size:12px; color:var(--text-dim); margin-bottom:8px; }
.activity-output { max-height:200px; overflow-y:auto; font-family:'SF Mono','Fira Code',monospace;
  font-size:11px; line-height:1.5; background:var(--bg); border-radius:4px; padding:8px; }
.activity-line { color:var(--text-dim); padding:2px 0; line-height:1.4; word-break:break-word; }
.activity-line.assistant { color:var(--text); padding:3px 0; }
.activity-line.tool { color:var(--purple); padding:4px 0; border-left:2px solid var(--purple); padding-left:8px; margin:2px 0; }
.activity-line.tool_result { color:var(--text-dim); font-size:11px; padding-left:10px; max-height:3.2em; overflow:hidden; opacity:.7; }
.activity-line.stderr { color:var(--red); }
.activity-line.result { color:var(--green); font-weight:600; padding:4px 0; border-left:2px solid var(--green); padding-left:8px; margin:2px 0; }
.activity-line.info { color:var(--accent); font-size:11px; }

/* Activity split: tasks panel + output side by side */
.activity-split { display:grid; grid-template-columns:240px 1fr; gap:8px; }
@media (max-width:900px) { .activity-split { grid-template-columns:1fr; } }
.activity-tasks-panel { background:var(--surface2); border:1px solid var(--border); border-radius:4px;
  max-height:200px; overflow-y:auto; }
.activity-tasks-header { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.5px;
  color:var(--text-dim); padding:6px 10px; border-bottom:1px solid var(--border); }
.activity-tasks-body { padding:6px 10px; font-size:11px; line-height:1.5; }
.activity-tasks-body .task-done { color:var(--green); }
.activity-tasks-body .task-current { color:var(--yellow); font-weight:600; background:rgba(210,153,34,.12);
  border-left:2px solid var(--yellow); padding-left:6px; margin:1px 0; border-radius:2px; }
.activity-tasks-body .task-todo { color:var(--text-dim); }
.spinner { display:inline-block; width:12px; height:12px; border:2px solid var(--border);
  border-top-color:var(--cyan); border-radius:50%; animation:spin 1s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }

/* Epic accordion */
.epic { border:1px solid var(--border); border-radius:6px; margin-bottom:8px; overflow:hidden; }
.epic-bar { display:flex; align-items:center; gap:10px; padding:10px 14px;
  cursor:pointer; user-select:none; transition:background .15s; }
.epic-bar:hover { background:rgba(255,255,255,.03); }
.epic-chevron { font-size:10px; color:var(--text-dim); transition:transform .2s; min-width:14px; }
.epic-chevron.open { transform:rotate(90deg); }
.epic-name { font-weight:600; font-size:14px; flex:1; }
.epic-stats { font-size:12px; color:var(--text-dim); display:flex; align-items:center; gap:8px; }
.epic-minibar { width:60px; height:4px; background:var(--border); border-radius:2px; overflow:hidden; }
.epic-minifill { height:100%; background:var(--green); border-radius:2px; }
.epic-body { border-top:1px solid var(--border); }
.epic-body.collapsed { display:none; }
.epic-description { padding:8px 14px 4px 38px; color:var(--text-dim); font-size:13px; font-style:italic;
  line-height:1.5; border-bottom:1px solid var(--border); }
.badge { font-size:11px; padding:2px 8px; border-radius:10px; font-weight:500; }

/* Stories inside epic */
.story-row { display:flex; align-items:center; gap:10px; padding:8px 14px 8px 28px;
  font-size:13px; cursor:pointer; transition:background .15s; user-select:none; border-bottom:1px solid rgba(48,54,61,.3); }
.story-row:last-child { border-bottom:none; }
.story-row:hover { background:rgba(255,255,255,.04); }
.story-row.active { background:rgba(57,210,192,.08); border-left:3px solid var(--cyan); padding-left:25px; }
.story-row.selected { background:rgba(188,140,255,.08); }
.story-key { font-family:'SF Mono','Fira Code',monospace; font-size:12px; }
.story-status { margin-left:auto; font-size:11px; padding:2px 7px; border-radius:10px; font-weight:500; }
.story-skill { font-size:10px; color:var(--cyan); font-style:italic; }
.story-arrow { color:var(--text-dim); font-size:10px; transition:transform .2s; }
.story-arrow.open { transform:rotate(90deg); }

/* Status colors */
.status-done { background:rgba(63,185,80,.15); color:var(--green); }
.status-in-progress { background:rgba(57,210,192,.15); color:var(--cyan); }
.status-review { background:rgba(210,153,34,.15); color:var(--yellow); }
.status-ready-for-dev { background:rgba(88,166,255,.15); color:var(--blue); }
.status-backlog { background:rgba(139,148,158,.1); color:var(--text-dim); }
.status-deferred { background:rgba(219,109,40,.15); color:var(--orange); }
.status-optional { background:rgba(139,148,158,.08); color:var(--text-dim); }

/* Story detail slide-down */
.story-detail { background:var(--surface2); padding:14px 14px 14px 28px; border-bottom:1px solid var(--border);
  font-size:12px; animation:slideIn .2s ease; }
@keyframes slideIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
.story-detail h3 { font-size:14px; margin-bottom:8px; color:var(--accent); }
.detail-section { margin-bottom:10px; }
.detail-label { font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.5px;
  color:var(--text-dim); margin-bottom:3px; }
.detail-body { white-space:pre-wrap; font-family:'SF Mono','Fira Code',monospace;
  font-size:11px; line-height:1.6; max-height:160px; overflow-y:auto;
  padding:8px; background:var(--bg); border-radius:4px; }
.commit-row { display:flex; align-items:center; gap:8px; padding:3px 0;
  border-bottom:1px solid rgba(48,54,61,.4); font-size:11px; }
.commit-row:last-child { border-bottom:none; }
.commit-hash { font-family:'SF Mono','Fira Code',monospace; color:var(--purple); min-width:56px; }
.commit-msg { flex:1; }
.commit-meta { color:var(--text-dim); font-size:10px; white-space:nowrap; }
.task-done { color:var(--green); }
.task-current { color:var(--yellow); font-weight:600; background:rgba(210,153,34,.1);
  border-left:2px solid var(--yellow); padding-left:6px; margin:1px 0; border-radius:2px; }
.task-todo { color:var(--text-dim); }
.no-data { color:var(--text-dim); font-style:italic; }

/* Gates */
.gate-result { display:flex; align-items:center; gap:8px; padding:8px 12px;
  border-radius:6px; margin-bottom:6px; font-size:13px; }
.gate-result.passed { background:rgba(63,185,80,.1); color:var(--green); }
.gate-result.failed { background:rgba(248,81,73,.1); color:var(--red); }

/* Log */
.log-body { max-height:300px; overflow-y:auto; font-family:'SF Mono','Fira Code',monospace;
  font-size:12px; padding:10px 14px; }
.log-line { padding:1px 0; color:var(--text-dim); white-space:pre-wrap; word-break:break-all; }
.log-line.error { color:var(--red); }
.log-line.success { color:var(--green); }
.log-line.info { color:var(--accent); }
.log-time { opacity:.4; margin-right:6px; font-size:10px; }

/* Current Work card highlight */
.current-work-card { border-color:var(--cyan); }
.current-work-card .card-header { color:var(--cyan); }

.empty-state { color:var(--text-dim); text-align:center; padding:20px; font-size:13px; }
@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.5; } }
.pulse { animation:pulse 2s ease-in-out infinite; }
</style>
</head>
<body>

<div class="header">
  <h1>\u2699 BMAD Autopilot</h1>
  <div class="right">
    <div class="overall-progress">
      <div class="overall-bar"><div class="overall-fill" id="overall-fill" style="width:0%"></div></div>
      <span class="overall-text" id="overall-text">0%</span>
    </div>
    <span class="project">${projectName}</span>
    <span class="conn-dot" id="conn-dot" title="Disconnected"></span>
  </div>
</div>

<div class="layout">
  <!-- Hero: Status + Current Activity side by side -->
  <div class="hero">
    <div class="hero-status">
      <div class="hero-outcome" id="hero-outcome">\u23f3 Connecting...</div>
      <div class="current-step" id="current-step-display"></div>
      <div class="hero-stat">Stories done: <strong id="stories-count">0</strong> / <strong id="stories-total">0</strong></div>
      <div class="hero-stat">Elapsed: <strong id="elapsed-time">0s</strong></div>
      <div class="hero-next" id="next-action-display"></div>
    </div>
    <div class="hero-activity" id="activity-container">
      <div class="empty-state">Idle \u2014 waiting for orchestrator</div>
    </div>
  </div>

  <!-- Current Work: active epic pulled out separately -->
  <div class="card current-work-card" id="current-work-card" style="display:none">
    <div class="card-header">\ud83d\udd25 Current Work</div>
    <div class="card-body" id="current-work-container" style="padding:8px"></div>
  </div>

  <!-- Sprint Board: remaining epics -->
  <div class="card">
    <div class="card-header">\ud83d\udccb Sprint Board <span style="font-size:10px;color:var(--text-dim);text-transform:none;letter-spacing:0;margin-left:4px">click epic to expand \u00b7 click story to inspect</span></div>
    <div class="card-body" id="board-container" style="padding:8px">
      <div class="empty-state">Loading...</div>
    </div>
  </div>

  <!-- Gates + Log side by side -->
  <div class="two-col">
    <div class="card">
      <div class="card-header">\ud83d\udee1 Quality Gates</div>
      <div class="card-body" id="gates-container">
        <div class="empty-state">No gates executed yet</div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">\ud83d\udcdc Event Log</div>
      <div class="log-body" id="log-container">
        <div class="empty-state">Waiting for events...</div>
      </div>
    </div>
  </div>
</div>

<script>
const state = {
  connected:false, outcome:'idle', storiesProcessed:0, startTime:Date.now(),
  currentSkill:null, currentStory:null, logs:[], gates:[], epics:[],
  haltReason:null, next:null, expandedStories:{}, expandedEpics:{},
  storyCache:{}, commitsCache:{}, activityLines:[], totalStories:0,
  activeStoryDetail:null, activeStoryRefreshTimer:null,
};

// ----- DATA -----
async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    state.epics = d.epics;
    state.next = d.next;
    state.totalStories = d.epics.reduce((sum,e) => sum + e.stories.length, 0);
    // Auto-expand epics that have active work
    for (const e of d.epics) {
      const hasActive = e.stories.some(s => s.status !== 'done' && s.status !== 'backlog') || e.status === 'in-progress';
      const hasCurrentStory = e.stories.some(s => s.key === state.currentStory);
      if (hasActive || hasCurrentStory) state.expandedEpics[e.key] = true;
      // Don't auto-collapse epics user manually expanded
    }
    renderBoard();
    renderOutcome();
    renderOverall();
  } catch(e) { console.error('loadStatus:', e); }
}

async function loadStoryDetail(k) {
  // Bypass cache for the active story (file is being modified in real-time)
  if (state.storyCache[k] && k!==state.currentStory) return state.storyCache[k];
  try { const r = await fetch('/api/story/'+encodeURIComponent(k)); const d = await r.json(); state.storyCache[k]=d; return d; } catch { return null; }
}
async function loadStoryCommits(k) {
  if (state.commitsCache[k]) return state.commitsCache[k];
  try { const r = await fetch('/api/commits/'+encodeURIComponent(k)); const d = await r.json(); state.commitsCache[k]=d; return d; } catch { return []; }
}

// ----- SSE -----
let currentES = null;
function connectSSE() {
  if (currentES) { currentES.close(); currentES=null; }
  const es = new EventSource('/api/events');
  currentES = es;
  es.addEventListener('connected', () => {
    state.connected=true;
    document.getElementById('conn-dot').classList.add('connected');
    document.getElementById('conn-dot').title='Connected';
    // Server sends current activity state on connect — UI will update via skill_start/skill_output events
  });
  es.addEventListener('skill_start', (e) => {
    const d=JSON.parse(e.data); state.currentSkill=d.skill; state.currentStory=d.storyKey;
    state.outcome='running'; state.activityLines=[]; state.activeStoryDetail=null;
    addLog('\u25b6 '+d.skill+' \u2192 '+d.storyKey,'info');
    for (const ep of state.epics) { if (ep.stories.some(s=>s.key===d.storyKey)) state.expandedEpics[ep.key]=true; }
    // Fetch story detail for the active story (bypass cache to get fresh data)
    fetchActiveStoryDetail(d.storyKey);
    renderActivity(); renderBoard(); renderOutcome();
  });
  es.addEventListener('skill_output', (e) => {
    const d=JSON.parse(e.data);
    if (!d.line) return;
    state.activityLines.push({line:d.line,type:d.type});
    if (state.activityLines.length>300) state.activityLines=state.activityLines.slice(-300);
    // If we were idle but got output, we're running
    if (!state.currentSkill) { state.outcome='running'; renderOutcome(); }
    renderActivityOutput();
  });
  es.addEventListener('skill_complete', (e) => {
    const d=JSON.parse(e.data); state.storiesProcessed++; state.currentSkill=null;
    state.activeStoryDetail=null;
    if (state.activeStoryRefreshTimer) { clearInterval(state.activeStoryRefreshTimer); state.activeStoryRefreshTimer=null; }
    delete state.storyCache[d.storyKey]; delete state.commitsCache[d.storyKey];
    addLog('\u2713 '+d.skill+' done ('+Math.round(d.durationMs/1000)+'s)','success');
    loadStatus(); renderActivity(); renderOutcome();
  });
  es.addEventListener('skill_error', (e) => {
    const d=JSON.parse(e.data);
    addLog('\u2717 '+d.skill+' failed (exit '+d.exitCode+')','error'); renderActivity();
  });
  es.addEventListener('skill_timeout', (e) => { const d=JSON.parse(e.data); addLog('\u23f1 '+d.skill+' timed out','error'); });
  es.addEventListener('log', (e) => {
    const d=JSON.parse(e.data);
    addLog(d.message, d.message.includes('HALT')?'error':d.message.includes('\u2713')?'success':'');
  });
  es.addEventListener('outcome', (e) => {
    const d=JSON.parse(e.data); state.outcome=d.outcome; state.currentSkill=null; state.currentStory=null;
    loadStatus(); renderOutcome(); renderActivity();
  });
  es.addEventListener('halt', (e) => {
    const d=JSON.parse(e.data); state.outcome='halted'; state.haltReason=d.reason;
    state.currentStory=d.story; state.currentSkill=null;
    addLog('HALTED: '+d.reason,'error'); loadStatus(); renderOutcome(); renderActivity();
  });
  es.addEventListener('gate', (e) => { state.gates.push(JSON.parse(e.data)); renderGates(); });
  es.onerror = () => {
    state.connected=false; document.getElementById('conn-dot').classList.remove('connected');
    document.getElementById('conn-dot').title='Reconnecting...';
    es.close(); currentES=null;
    setTimeout(connectSSE, 3000);
  };
}

// ----- ACTIVE STORY DETAIL -----
async function fetchActiveStoryDetail(storyKey) {
  // Clear any existing refresh timer
  if (state.activeStoryRefreshTimer) { clearInterval(state.activeStoryRefreshTimer); state.activeStoryRefreshTimer=null; }
  // Bypass cache — story file is being actively modified by Claude
  try {
    const r = await fetch('/api/story/'+encodeURIComponent(storyKey));
    const d = await r.json();
    state.activeStoryDetail = d;
    state.storyCache[storyKey] = d;
    renderActivity(); renderOutcome();
  } catch { /* ignore */ }
  // Periodically refresh the active story (tasks get checked off during dev-story)
  state.activeStoryRefreshTimer = setInterval(async ()=>{
    if (!state.currentStory) return;
    try {
      const r = await fetch('/api/story/'+encodeURIComponent(state.currentStory));
      const d = await r.json();
      state.activeStoryDetail = d;
      state.storyCache[state.currentStory] = d;
      renderActiveStoryTasks();
    } catch { /* ignore */ }
  }, 8000);
}

function renderActiveStoryTasks() {
  const el = document.getElementById('active-tasks');
  if (!el || !state.activeStoryDetail) return;
  const d = state.activeStoryDetail;
  if (d.tasksSection) {
    el.innerHTML = renderTasks(d.tasksSection);
  }
  // Also update hero task progress
  renderOutcome();
}

function parseTaskProgress(tasksSection) {
  if (!tasksSection) return null;
  const lines = tasksSection.split('\\n');
  let done=0, total=0, currentTask=null;
  for (const l of lines) {
    const isDone = l.includes('[x]')||l.includes('[X]');
    const isTodo = l.includes('[ ]');
    // Only count top-level tasks (lines starting with - [ ] or - [x], not indented subtasks)
    const isTopLevel = /^-\\s+\\[/.test(l.trim());
    const isAnyTask = isDone || isTodo;
    if (isAnyTask) {
      total++;
      if (isDone) done++;
      // First unchecked task = current task
      if (isTodo && !currentTask) {
        currentTask = l.replace(/^[\\s-]*\\[[ xX]\\]\\s*/, '').replace(/^\\d+\\.\\d+[:\\s]*/, '').trim();
        // Truncate long task names
        if (currentTask.length>80) currentTask=currentTask.substring(0,77)+'...';
      }
    }
  }
  if (total===0) return null;
  return { done, total, currentTask, pct: Math.round(done/total*100) };
}

function skillLabel(skill) {
  const labels = {
    'bmad-create-story':'Create Story','bmad-dev-story':'Dev Story',
    'bmad-code-review':'Code Review','bmad-sprint-status':'Sprint Status',
    'bmad-check-implementation-readiness':'Implementation Check',
  };
  return labels[skill] || skill;
}

// ----- RENDER -----
function addLog(msg,cls) {
  state.logs.push({time:new Date().toLocaleTimeString(),message:msg,cls:cls||''});
  renderLogs();
}

function renderOverall() {
  const done = state.epics.reduce((s,e)=>s+e.stories.filter(st=>st.status==='done').length,0);
  const pct = state.totalStories>0 ? Math.round(done/state.totalStories*100) : 0;
  document.getElementById('overall-fill').style.width=pct+'%';
  document.getElementById('overall-text').textContent=pct+'%';
  document.getElementById('stories-total').textContent=state.totalStories;
}

function renderOutcome() {
  const el=document.getElementById('hero-outcome');
  const nextEl=document.getElementById('next-action-display');
  const stepEl=document.getElementById('current-step-display');
  const m = {running:['\u25b6','Running','var(--cyan)'],complete:['\u2705','Sprint Complete','var(--green)'],
    halted:['\u26d4','HALTED','var(--red)'],interrupted:['\u23f8','Interrupted','var(--yellow)']};
  const o = m[state.outcome]||['\u23f3','Idle','var(--text-dim)'];

  if (state.currentSkill && state.outcome==='running') {
    // Show prominent current step
    el.innerHTML='<span style="color:'+o[2]+'">\u25b6 '+esc(skillLabel(state.currentSkill))+'</span>';
    const storyTitle = state.activeStoryDetail?.title || state.currentStory || '...';
    let stepHTML='<span class="step-story">'+esc(state.currentStory)+' \u2014 '+esc(storyTitle)+'</span>';
    // Show current task progress
    const tp = parseTaskProgress(state.activeStoryDetail?.tasksSection);
    if (tp) {
      stepHTML+='<div class="step-task">';
      stepHTML+='<span class="step-task-progress">'+tp.done+'/'+tp.total+' tasks</span>';
      if (tp.currentTask) stepHTML+=' <span class="step-task-current">\u25b8 '+esc(tp.currentTask)+'</span>';
      else if (tp.done===tp.total) stepHTML+=' <span style="color:var(--green)">\u2713 All tasks done</span>';
      stepHTML+='</div>';
    }
    if (stepEl) stepEl.innerHTML=stepHTML;
  } else {
    el.innerHTML='<span style="color:'+o[2]+'">'+o[0]+' '+o[1]+'</span>';
    if (stepEl) stepEl.innerHTML='';
  }
  document.getElementById('stories-count').textContent=state.storiesProcessed;
  if (state.next && state.outcome!=='complete') {
    nextEl.innerHTML='Next: '+esc(skillLabel(state.next.skill))+' \u2192 '+state.next.storyKey;
  } else if (state.outcome==='complete') {
    nextEl.innerHTML='\u2705 All stories done!';
  } else { nextEl.innerHTML=''; }
}

function renderActivity() {
  const c=document.getElementById('activity-container');
  if (state.outcome==='halted') {
    c.innerHTML='<div class="activity-header" style="color:var(--red)">\u26d4 Halted</div>'+
      '<div class="activity-story">'+esc(state.haltReason||'')+'</div>'+activityHTML();
    return;
  }
  if (!state.currentSkill) {
    c.innerHTML='<div class="empty-state">'+(state.outcome==='complete'?'\u2705 Sprint complete':'Idle \u2014 waiting for orchestrator')+'</div>';
    return;
  }
  // Build activity with optional task sidebar
  let h='<div class="activity-header"><span class="spinner"></span> '+esc(skillLabel(state.currentSkill))+'</div>';
  h+='<div class="activity-story">'+esc(state.currentStory||'...');
  if (state.activeStoryDetail?.title) h+=' \u2014 '+esc(state.activeStoryDetail.title);
  h+='</div>';
  // Show tasks panel + output side by side
  const hasTasks = state.activeStoryDetail?.tasksSection;
  if (hasTasks) {
    h+='<div class="activity-split">';
    h+='<div class="activity-tasks-panel"><div class="activity-tasks-header">\u2705 Tasks</div>';
    h+='<div class="activity-tasks-body" id="active-tasks">'+renderTasks(state.activeStoryDetail.tasksSection)+'</div></div>';
    h+=activityHTML();
    h+='</div>';
  } else {
    h+=activityHTML();
  }
  c.innerHTML=h;
}

function formatLine(l) {
  const t = l.type||'';
  const text = esc(l.line);
  if (t==='tool') return '<div class="activity-line tool">\u{1F527} '+text+'</div>';
  if (t==='tool_result') return '<div class="activity-line tool_result">'+text+'</div>';
  if (t==='result') return '<div class="activity-line result">\u2705 '+text+'</div>';
  if (t==='stderr') return '<div class="activity-line stderr">\u26a0 '+text+'</div>';
  if (t==='info') return '<div class="activity-line info">'+text+'</div>';
  if (t==='assistant') return '<div class="activity-line assistant">'+text+'</div>';
  return '<div class="activity-line">'+text+'</div>';
}

function activityHTML() {
  if (!state.activityLines.length) return '<div class="activity-output"><span style="color:var(--text-dim)">Waiting for output...</span></div>';
  const vis=state.activityLines.slice(-80);
  let h='<div class="activity-output" id="activity-output">';
  for (const l of vis) h+=formatLine(l);
  return h+'</div>';
}

function renderActivityOutput() {
  const el=document.getElementById('activity-output');
  if (el) {
    const vis=state.activityLines.slice(-80);
    let h='';
    for (const l of vis) h+=formatLine(l);
    el.innerHTML=h; el.scrollTop=el.scrollHeight;
  } else renderActivity();
}

function renderBoard() {
  const c=document.getElementById('board-container');
  const cwCard=document.getElementById('current-work-card');
  const cwContainer=document.getElementById('current-work-container');
  if (!state.epics.length) { c.innerHTML='<div class="empty-state">No sprint data</div>'; cwCard.style.display='none'; return; }

  // Split: active epic goes to Current Work, rest to Sprint Board
  const activeEpic = state.epics.find(e => e.status==='in-progress' || e.stories.some(s=>s.key===state.currentStory));
  const restEpics = state.epics.filter(e => e !== activeEpic);

  // Render Current Work (active epic)
  if (activeEpic) {
    cwCard.style.display='';
    // Force-expand the active epic
    state.expandedEpics[activeEpic.key]=true;
    cwContainer.innerHTML=renderEpicHTML(activeEpic);
  } else {
    cwCard.style.display='none';
  }

  // Render remaining epics in Sprint Board
  if (!restEpics.length) { c.innerHTML='<div class="empty-state">All epics shown above</div>'; } else {
    let h='';
    for (const epic of restEpics) h+=renderEpicHTML(epic);
    c.innerHTML=h;
  }
  // Load detail for all expanded stories and the active story
  const toLoad = new Set(Object.keys(state.expandedStories).filter(k=>state.expandedStories[k]));
  if (state.currentStory) toLoad.add(state.currentStory);
  for (const sk of toLoad) loadDetail(sk);
}

function renderEpicHTML(epic) {
  const done=epic.stories.filter(s=>s.status==='done').length;
  const total=epic.stories.length;
  const pct=total>0?Math.round(done/total*100):0;
  const isOpen=!!state.expandedEpics[epic.key];
  const hasActive=epic.stories.some(s=>s.key===state.currentStory);

  let h='<div class="epic">';
  h+='<div class="epic-bar" onclick="toggleEpic(\\''+epic.key+'\\')"> ';
  h+='<span class="epic-chevron'+(isOpen?' open':'')+'">\u25b6</span>';
  h+='<span>'+sIcon(epic.status)+'</span>';
  h+='<span class="epic-name">'+epic.key+(epic.name ? ': '+esc(epic.name) : '')+'</span>';
  if (hasActive) h+='<span class="spinner" style="width:10px;height:10px"></span>';
  h+='<span class="epic-stats">';
  h+='<span class="badge status-'+epic.status+'">'+epic.status+'</span>';
  h+='<span class="epic-minibar"><span class="epic-minifill" style="width:'+pct+'%"></span></span>';
  h+='<span>'+done+'/'+total+'</span>';
  h+='</span></div>';

  h+='<div class="epic-body'+(isOpen?'':' collapsed')+'">';
  if (epic.description) h+='<div class="epic-description">'+esc(epic.description)+'</div>';
  for (const s of epic.stories) {
    const isAct=s.key===state.currentStory;
    const isExp=!!state.expandedStories[s.key];
    const showDetail=isExp||isAct;
    let rc='story-row'; if (isAct) rc+=' active'; if (isExp) rc+=' selected';
    h+='<div class="'+rc+'" onclick="toggleStory(\\''+s.key+'\\',event)">';
    h+='<span class="story-arrow'+(showDetail?' open':'')+'">\u25b6</span>';
    h+='<span>'+sIcon(s.status)+'</span>';
    h+='<span class="story-key">'+s.key+(s.title ? ' — '+esc(s.title) : '')+'</span>';
    if (isAct&&state.currentSkill) h+='<span class="story-skill pulse">'+state.currentSkill+'</span>';
    h+='<span class="story-status status-'+s.status+'">'+s.status+'</span></div>';
    if (showDetail) h+='<div class="story-detail" id="detail-'+s.key+'"><div class="empty-state">Loading...</div></div>';
  }
  h+='</div></div>';
  return h;
}

function toggleEpic(key) {
  state.expandedEpics[key]=!state.expandedEpics[key];
  renderBoard();
}
function toggleStory(key,ev) {
  ev.stopPropagation();
  state.expandedStories[key] = !state.expandedStories[key];
  renderBoard();
}

async function loadDetail(sk) {
  const el=document.getElementById('detail-'+sk);
  if (!el) return;
  const [detail,commits]=await Promise.all([loadStoryDetail(sk),loadStoryCommits(sk)]);
  if (!detail||!detail.exists) {
    // For done stories without a story file, show commits instead of "not created"
    let h='<div class="no-data">No story file — ';
    const storyStatus = state.epics.flatMap(e=>e.stories).find(s=>s.key===sk);
    h += storyStatus && storyStatus.status==='done' ? 'completed before autopilot was used.' : 'story file not created yet.';
    h += '</div>';
    if (commits && commits.length) {
      h+='<div class="detail-section"><div class="detail-label">\ud83d\udcdd Commits ('+commits.length+')</div>';
      h+='<div style="max-height:140px;overflow-y:auto">';
      for (const c of commits) h+='<div class="commit-row"><span class="commit-hash">'+esc(c.short||'')+'</span><span class="commit-msg">'+esc(c.message||'')+'</span><span class="commit-meta">'+esc(c.author||'')+' \u00b7 '+esc(c.date||'')+'</span></div>';
      h+='</div></div>';
    }
    el.innerHTML=h; return;
  }
  let h='<h3>'+esc(detail.title)+'</h3>';
  // Show status badge
  if (detail.status && detail.status!=='unknown') h+='<span class="badge status-'+detail.status+'" style="margin-bottom:8px;display:inline-block">'+esc(detail.status)+'</span> ';
  if (detail.source==='epics') h+='<span style="color:var(--text-dim);font-size:12px;font-style:italic">Source: epics.md</span>';
  h+='<div style="margin-top:6px"></div>';
  if (detail.storySection) h+=sec('\ud83d\udcd6 User Story',esc(detail.storySection));
  if (detail.tasksSection) h+=sec('\u2705 Tasks',renderTasks(detail.tasksSection));
  if (detail.acSection) h+=sec('\ud83c\udfaf Acceptance Criteria',esc(detail.acSection));
  // If no sections found but file exists, show helpful message
  if (!detail.storySection && !detail.tasksSection && !detail.acSection) {
    const isActive = sk===state.currentStory;
    h+='<div class="no-data">'+(isActive?'Story file is being populated by '+esc(state.currentSkill||'skill')+'...':'No description sections found in story file.')+'</div>';
  }
  h+='<div class="detail-section"><div class="detail-label">\ud83d\udcdd Commits ('+commits.length+')</div>';
  if (!commits.length) { h+='<div class="no-data">No commits found</div>'; }
  else { h+='<div style="max-height:140px;overflow-y:auto">';
    for (const c of commits) h+='<div class="commit-row"><span class="commit-hash">'+esc(c.short||'')+'</span><span class="commit-msg">'+esc(c.message||'')+'</span><span class="commit-meta">'+esc(c.author||'')+' \u00b7 '+esc(c.date||'')+'</span></div>';
    h+='</div>'; }
  h+='</div>';
  el.innerHTML=h;
}

function sec(label,body) {
  return '<div class="detail-section"><div class="detail-label">'+label+'</div><div class="detail-body">'+body+'</div></div>';
}
function renderTasks(t) {
  let foundCurrent=false;
  return t.split('\\n').map(l=>{
    const d=l.includes('[x]')||l.includes('[X]'); const td=l.includes('[ ]');
    let cls='';
    if (d) cls='task-done';
    else if (td && !foundCurrent) { cls='task-current'; foundCurrent=true; }
    else if (td) cls='task-todo';
    return '<div class="'+cls+'">'+esc(l)+'</div>';
  }).join('');
}

function renderGates() {
  const c=document.getElementById('gates-container');
  if (!state.gates.length) { c.innerHTML='<div class="empty-state">No gates yet</div>'; return; }
  let h='';
  for (const g of state.gates) {
    const cls=g.passed?'passed':'failed'; const ic=g.passed?'\u2713':'\u2717';
    h+='<div class="gate-result '+cls+'"><strong>'+ic+' '+esc(g.gate)+'</strong><span style="margin-left:auto;font-size:12px">'+esc(g.details)+'</span></div>';
  }
  c.innerHTML=h;
}

function renderLogs() {
  const c=document.getElementById('log-container');
  const vis=state.logs.slice(-100);
  let h='';
  for (const l of vis) h+='<div class="log-line '+l.cls+'"><span class="log-time">'+l.time+'</span>'+esc(l.message)+'</div>';
  c.innerHTML=h; c.scrollTop=c.scrollHeight;
}

function sIcon(s) {
  return {done:'\u2705','in-progress':'\ud83d\udd04',review:'\ud83d\udd0d','ready-for-dev':'\ud83d\udccb',backlog:'\u23f3',deferred:'\u23ed',optional:'\u26aa'}[s]||'\u23f3';
}
function esc(s) { return s?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''; }

setInterval(()=>{
  if (state.outcome==='running') {
    const s=Math.floor((Date.now()-state.startTime)/1000); const m=Math.floor(s/60);
    document.getElementById('elapsed-time').textContent=m>0?m+'m '+(s%60)+'s':s+'s';
  }
},1000);

loadStatus(); connectSSE();
// Poll status periodically to stay in sync
setInterval(loadStatus, 10000);
</script>
</body>
</html>`;
}
