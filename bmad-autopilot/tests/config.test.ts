import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bmad-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeConfig(content: string) {
    const configDir = join(tempDir, '_bmad', 'bmm');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), content);
  }

  it('resolves {project-root} placeholders in all path values', () => {
    writeConfig(`
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

    const config = loadConfig(tempDir);

    expect(config.project_name).toBe('test-project');
    expect(config.planning_artifacts).toBe(join(tempDir, '_bmad-output/planning'));
    expect(config.implementation_artifacts).toBe(join(tempDir, '_bmad-output/impl'));
    expect(config.project_knowledge).toBe(join(tempDir, 'docs'));
    expect(config.output_folder).toBe(join(tempDir, '_bmad-output'));
    expect(config.projectRoot).toBe(tempDir);
  });

  it('throws descriptive error when config file does not exist', () => {
    expect(() => loadConfig(tempDir)).toThrow(
      /BMAD not configured.*config\.yaml not found/
    );
  });

  it('throws error when required fields are missing', () => {
    writeConfig(`
user_name: Tester
communication_language: English
`);

    expect(() => loadConfig(tempDir)).toThrow(
      /required field 'project_name' is missing/
    );
  });

  it('produces absolute paths from resolved config', () => {
    writeConfig(`
project_name: abs-test
planning_artifacts: "{project-root}/planning"
implementation_artifacts: "{project-root}/impl"
user_name: Tester
user_skill_level: beginner
project_knowledge: "{project-root}/docs"
output_folder: "{project-root}/out"
communication_language: English
document_output_language: English
`);

    const config = loadConfig(tempDir);

    // All resolved paths should be absolute (start with /)
    expect(config.planning_artifacts.startsWith('/')).toBe(true);
    expect(config.implementation_artifacts.startsWith('/')).toBe(true);
    expect(config.projectRoot.startsWith('/')).toBe(true);
  });

  it('resolves projectRoot to absolute path even when given relative path', () => {
    // Create config in current working directory structure
    writeConfig(`
project_name: relative-test
planning_artifacts: "{project-root}/planning"
implementation_artifacts: "{project-root}/impl"
user_name: Tester
user_skill_level: beginner
project_knowledge: "{project-root}/docs"
output_folder: "{project-root}/out"
communication_language: English
document_output_language: English
`);

    const config = loadConfig(tempDir);
    expect(config.projectRoot).toMatch(/^\//);
  });
});
