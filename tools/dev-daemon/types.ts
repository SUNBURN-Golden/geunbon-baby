export type Provider = 'claude' | 'codex' | 'glm' | 'devin';
export type Stage = 'prepare' | 'design' | 'design-review' | 'design-revise' | 'build' |
  'build-review' | 'review-fix' | 're-review' | 'validate' | 'commit' | 'publish' | 'merge' | 'audit' | 'audit-enqueue' | 'done' | 'failed';
export type ModelKey = 'fable' | 'astra6' | 'opus55' | 'sol61' | 'sonnet' | 'glm' | 'swe2';
export interface Model { provider: Provider; id: string; note?: string }
export interface Choice { model: ModelKey; effort?: 'medium' | 'high' }
export interface ModelsConfig { models: Record<ModelKey, Model> }
export interface Task {
  id: string;
  file: string;
  title: string;
  body: string;
  branch: string;
  worktree: string;
  kind: 'task' | 'audit';
  stage: Stage;
  round: number;
  outputs: Partial<Record<Stage, string>>;
  attempts: number;
  wakeAt?: string;
  summary?: string;
  verdict?: 'APPROVE' | 'CHANGES';
  pr?: string;
  commit?: string;
  reviewedFingerprint?: string;
  validatedTree?: string;
  validatedParent?: string;
  auditAt?: number;
}
export interface State {
  version: 1;
  mergedPrs: number;
  auditedThrough: number;
  active?: Task;
  updatedAt: string;
}
export interface Command {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log: string;
  answerFile?: string;
}
export interface Result { code: number; output: string; answer: string; stdout?: string; stderr?: string }
export type Execute = (command: Command) => Promise<Result>;
