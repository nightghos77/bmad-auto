import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { BmadConfig, ResolvedConfig } from './types.js';

const CONFIG_RELATIVE_PATH = '_bmad/bmm/config.yaml';
const MANIFEST_RELATIVE_PATH = '_bmad/_config/manifest.yaml';

const MIN_SUPPORTED_VERSION = '6.0.0';

export interface BmadVersionInfo {
  version: string;
  format: 'v6.2+' | 'v6.0' | 'unknown';
  supported: boolean;
}

/**
 * Detect the BMAD Method version installed in a project.
 * Reads _bmad/_config/manifest.yaml for the version field.
 */
export function detectBmadVersion(projectRoot: string): BmadVersionInfo {
  const absoluteRoot = resolve(projectRoot);
  const manifestPath = resolve(absoluteRoot, MANIFEST_RELATIVE_PATH);

  if (!existsSync(manifestPath)) {
    return { version: 'unknown', format: 'unknown', supported: false };
  }

  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const installation = parsed?.installation as Record<string, unknown> | undefined;
    const version = String(installation?.version || 'unknown');

    // Determine format by checking which layout exists
    const hasClaudeSkills = existsSync(resolve(absoluteRoot, '.claude', 'skills'));
    const hasWorkflowsDir = existsSync(resolve(absoluteRoot, '_bmad', 'bmm', 'workflows'));

    let format: BmadVersionInfo['format'] = 'unknown';
    if (hasClaudeSkills) format = 'v6.2+';
    else if (hasWorkflowsDir) format = 'v6.0';

    // Parse version for comparison (strip alpha/beta suffixes for major.minor check)
    const cleanVersion = version.replace(/-.*$/, '');
    const supported = compareVersions(cleanVersion, MIN_SUPPORTED_VERSION) >= 0;

    return { version, format, supported };
  } catch {
    return { version: 'unknown', format: 'unknown', supported: false };
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const REQUIRED_FIELDS: (keyof BmadConfig)[] = [
  'project_name',
  'planning_artifacts',
  'implementation_artifacts',
];

/**
 * Load and resolve BMAD config from a project root directory.
 * Replaces all {project-root} placeholders with the absolute project root path.
 */
export function loadConfig(projectRoot: string): ResolvedConfig {
  const absoluteRoot = resolve(projectRoot);
  const configPath = resolve(absoluteRoot, CONFIG_RELATIVE_PATH);

  if (!existsSync(configPath)) {
    throw new Error(
      `BMAD not configured: config.yaml not found at ${configPath}. Run bmad-init first.`
    );
  }

  const raw = readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `Invalid config: ${configPath} did not parse as a YAML object.`
    );
  }

  // Validate required fields
  for (const field of REQUIRED_FIELDS) {
    if (!(field in parsed) || !parsed[field]) {
      throw new Error(
        `Invalid config: required field '${field}' is missing in ${configPath}.`
      );
    }
  }

  // Resolve {project-root} placeholders in all string values
  const resolved: Record<string, unknown> = { projectRoot: absoluteRoot };
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      resolved[key] = value.replace(/\{project-root\}/g, absoluteRoot);
    } else {
      resolved[key] = value;
    }
  }

  return resolved as unknown as ResolvedConfig;
}
