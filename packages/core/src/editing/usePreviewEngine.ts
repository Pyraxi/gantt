import type { Project } from '@pyraxi/cpm-engine';
import { schedule } from '@pyraxi/cpm-engine';
import { useEffect, useRef, useState } from 'react';
import { type ActiveCell, parseFieldValue } from './useEditState.js';

export function usePreviewEngine(
  committed: Project,
  activeCell: ActiveCell | null,
  dirtyValue: string,
  debounceMs = 80,
): Project | null {
  const [ghostProject, setGhostProject] = useState<Project | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const CPM_IRRELEVANT_FIELDS = new Set(['text', 'progress', 'scheduleMode']);
    if (activeCell === null || CPM_IRRELEVANT_FIELDS.has(activeCell.field)) {
      setGhostProject(null);
      return;
    }

    if (timerRef.current !== null) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      const patch = parseFieldValue(activeCell.field, dirtyValue);
      if (Object.keys(patch).length === 0) {
        setGhostProject(null); // invalid input — suppress ghost
        return;
      }
      const patchedTasks = committed.tasks.map((t) =>
        t.id === activeCell.taskId ? { ...t, ...patch } : t,
      );
      setGhostProject(schedule({ ...committed, tasks: patchedTasks }));
    }, debounceMs);

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [committed, activeCell, dirtyValue, debounceMs]);

  // Clear immediately when cell deactivates (don't wait for debounce timeout).
  useEffect(() => {
    if (activeCell === null) setGhostProject(null);
  }, [activeCell]);

  return ghostProject;
}
