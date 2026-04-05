import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface LogEntry {
  ts: string;
  event: string;
  skill?: string;
  story?: string;
  [key: string]: unknown;
}

export class RunLogger {
  private filePath: string;
  readonly runId: string;
  readonly runsDir: string;

  /**
   * @param outputDir - Base output directory (e.g., _bmad-output)
   * @param scope - Optional scope for log organization (e.g., "epic-1", "1-4-password-reset-flow")
   */
  constructor(outputDir: string, scope?: string) {
    this.runId = randomUUID().split('-')[0];
    this.runsDir = scope
      ? resolve(outputDir, 'autopilot-runs', scope)
      : resolve(outputDir, 'autopilot-runs');
    if (!existsSync(this.runsDir)) {
      mkdirSync(this.runsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.filePath = resolve(this.runsDir, `${timestamp}-${this.runId}.jsonl`);
  }

  log(entry: Omit<LogEntry, 'ts'>): void {
    const line: LogEntry = {
      ...entry,
      ts: new Date().toISOString(),
    };
    appendFileSync(this.filePath, JSON.stringify(line) + '\n');
  }

  getFilePath(): string {
    return this.filePath;
  }
}
