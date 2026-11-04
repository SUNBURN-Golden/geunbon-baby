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
  cleanup?: { status: 'complete' | 'incomplete'; reason?: string; log?: string; worktree: string; directory?: 'present' | 'absent' | 'unknown' };
  finalization?: { destination: 'done' | 'failed'; digest: string; summary: string };
  reviewProgress?: ReviewProgress;
  reviewHistory?: ReviewProgress[];
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
  /** Model print-mode stream artifacts; ordinary commands retain existing behavior. */
  captureStreams?: boolean;
  input?: { text: string; transport: 'stdin' | 'file' };
  /** Keep consuming stdout after this byte limit, without storing or logging it. */
  stdoutLimitBytes?: number;
}
export interface Result { code: number; output: string; answer: string; stdout?: string; stderr?: string; stdoutTruncated?: boolean }
export type Execute = (command: Command) => Promise<Result>;

export type Decision = 'APPROVE' | 'CHANGES';
export type AnswerSource = 'final-answer-file' | 'stdout' | 'combined' | 'stream-unknown';
export interface ReviewInvocation {
  log: string;
  status: 'issued' | 'completed';
  result?: Result;
  answerSource?: AnswerSource;
  outcome?: string;
}
export interface ReviewAttempt {
  cycle: number;
  modelIndex: number;
  original: ReviewInvocation;
  clarification?: ReviewInvocation;
}
export interface ReviewProgress {
  key: string;
  cycle: number;
  quotaPause?: { wakeAt: string; summary: string };
  attempts: ReviewAttempt[];
}
