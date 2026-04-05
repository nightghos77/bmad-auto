/**
 * Raw config as read from _bmad/bmm/config.yaml.
 * Path values contain {project-root} placeholders.
 */
export interface BmadConfig {
  project_name: string;
  user_name: string;
  user_skill_level: string;
  planning_artifacts: string;
  implementation_artifacts: string;
  project_knowledge: string;
  output_folder: string;
  communication_language: string;
  document_output_language: string;
}

/**
 * Config with all {project-root} placeholders resolved to absolute paths.
 */
export interface ResolvedConfig extends BmadConfig {
  projectRoot: string;
}

export type StoryStatus = 'backlog' | 'ready-for-dev' | 'in-progress' | 'review' | 'done' | 'deferred';

export type GateMode = 'strict' | 'balanced' | 'lenient';

export type EpicStatus = 'backlog' | 'in-progress' | 'done';

export interface SprintStatus {
  generated: string;
  last_updated: string;
  project: string;
  project_key: string;
  tracking_system: string;
  story_location: string;
  development_status: Record<string, string>;
}

export interface NextAction {
  storyKey: string;
  currentStatus: StoryStatus;
  skill: string;
}
