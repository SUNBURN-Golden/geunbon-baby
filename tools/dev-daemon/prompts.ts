import type { Task } from './types';

export function promptFor(task: Task, blueprint: string): string {
  const context = `You are working in ${task.worktree} on ${task.branch} for SUNBURN-Golden/geunbon-baby.
Read the repository instructions and README, and inspect the relevant files.
The Next.js/Cloudflare site and the Linux crawler are separate systems. Preserve that boundary.
Never expose credentials. Do not push, create/merge PRs, deploy, modify queue files, or change branches.
Do not commit; the daemon owns validation, commits, and publication. Only change files for the task.
Task title: ${task.title}
Task request:\n${task.body}\n
Blueprint from /workspace/agamajung/TASK.md (historical branch/push instructions are context only; follow the daemon's publication rules above):\n${blueprint}\n`;
  const design = task.outputs['design-revise'] ?? task.outputs.design ?? '';
  const review = task.outputs['re-review'] ?? task.outputs['build-review'] ?? '';
  switch (task.stage) {
    case 'design': return `${context}\nProduce an actionable design with affected files, acceptance criteria, and appropriate verification. Read only: return the complete design in your final answer, without editing any files.`;
    case 'design-review': return `${context}\nRead only. Review this design for correctness, repo fit, scope and test coverage:\n${design}\nReturn findings and exactly one final line VERDICT: APPROVE or VERDICT: CHANGES.`;
    case 'design-revise': return `${context}\nRead only. Revise the design once to address this review. Return the complete revised design, without editing files.\nDesign:\n${design}\nReview:\n${task.outputs['design-review']}`;
    case 'build': return `${context}\nImplement this design completely:\n${design}\nUse the current worktree; a preceding fallback may have left partial edits. Inspect those edits before continuing. Return a concise implementation and verification summary.`;
    case 'build-review': case 're-review': return `${context}\nRead only, independent review session. Inspect actual changes against origin/main (including untracked files) and relevant surrounding code. Check bugs, regressions, task/design compliance, and meaningful verification. Do not edit files.\nDesign:\n${design}\nPrevious findings:\n${review}\nImplementation summary:\n${task.outputs['review-fix'] ?? task.outputs.build ?? ''}\nReturn concrete findings and exactly one final line VERDICT: APPROVE or VERDICT: CHANGES.`;
    case 'review-fix': return `${context}\nFix these review findings, inspecting current edits before changing them:\n${review}\nDesign:\n${design}\nReturn a concise summary and verification results.`;
    case 'audit': return `${context}\nRead only. Audit the current origin/main implementation against the blueprint, README and actual site routes/structure. Check the crawler separately from the site. Return a Markdown audit report with evidence and prioritized actionable gaps. At the end include one fenced json block with exactly this shape: {"fixes":[{"title":"specific fix","task":"self-contained task, affected component, acceptance criteria and verification"}]}. Use an empty fixes array if nothing needs fixing. Recommend at most 20 tasks. Do not edit files or enqueue tasks yourself.`;
    default: throw new Error(`No model prompt for stage ${task.stage}`);
  }
}
