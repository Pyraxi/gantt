import type { Project, TaskId } from '../types.js';

/**
 * If `parentId` names an existing leaf (`type: 'task'`), return a new Project
 * with that task flipped to `type: 'summary'`. No-op (returns the input
 * reference) when parentId is undefined, names no task, or names a task that
 * is already a summary/milestone. Mirrors the leaf→summary promotion
 * ReparentTaskCommand performs on indent (commands.ts).
 *
 * Lives in this leaf module (imports only `../types.js`) so both `commands.ts`
 * and `factories.ts` can use it without forming an import cycle.
 */
export function promoteParentIfLeaf(project: Project, parentId: TaskId | undefined): Project {
  if (parentId === undefined) return project;
  const parent = project.tasks.find((t) => t.id === parentId);
  if (!parent || parent.type !== 'task') return project;
  return {
    ...project,
    tasks: project.tasks.map((t) => (t.id === parentId ? { ...t, type: 'summary' as const } : t)),
  };
}
