// Typed predecessor input (parity row 1 gap): MS Project / P6 "4FS+2d, 5SS"
// text → predecessor specs, and the link changes that make a task's
// predecessors match. Reads what formatPredecessors writes (round-trips). The
// link diff, cycle check and undoable `setPredecessors` command are engine-side.
import {
  type DependencyType,
  type PredecessorSpec,
  parseDuration,
  parseElapsedDuration,
  type Task,
  type TaskId,
} from '@pyraxi/cpm-engine';
import { durationUnitsFor } from './editing/useEditState.js';

export type PredecessorParse =
  | { ok: true; preds: PredecessorSpec[] }
  | { ok: false; error: string };

// <ref><type?><lag?>: ref = row number, type FS/SS/FF/SF, lag = sign,
// number, optional e (elapsed), unit (d/day/days, h, m, w, mo, %) — e.g.
// "4", "4FS+3 days", "2SS-1.5d", "3FF+50%", "5+2ed". A bare link type is
// never a unit, so "EW-10SS" (formatPredecessors' SS link from "EW-10") reads
// as ref "EW-10" + SS, not ref "EW" with a -10 "SS" lag.
const TOKEN =
  /^(.+?)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(\d+(?:\.\d+)?)\s*(e)?\s*(%|(?!(?:FS|SS|FF|SF)$)[a-z]+)?)?$/i;

/**
 * Parse a predecessor cell. References are 1-based **row numbers** in `tasks`
 * (as {@link formatPredecessors} writes with `tasks`, MS Project's ID column);
 * each resolves to that task's own id. Or pass `resolve` to read references
 * as any text (a sheet's ID column, P6 `A1000`). `targetId` (the edited task)
 * rejects a self-reference.
 *
 * `resolve` contract: it is called with each whole entry first (`"EW-10"`,
 * `"3FS+2d"`) and then with the reference read out of it (`"EW"`, `"3"`), and
 * should return a task id only for an exact id match. The whole entry wins
 * when the split reference names no task or a different one (tasks `EW` and
 * `EW-10`: `EW-10` is that task, not `EW` with a 10-day lead); otherwise the
 * split reading keeps its type and lag.
 */
export function parsePredecessors(
  text: string,
  opts: { minutesPerDay?: number; targetId?: TaskId } & (
    | { tasks: readonly Task[]; resolve?: undefined }
    | {
        /** Text reference → task id. Tried with the whole entry first; match ids exactly. */
        resolve: (ref: string) => TaskId | undefined;
        tasks?: undefined;
      }
  ),
): PredecessorParse {
  const preds: PredecessorSpec[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[,;]/)) {
    const token = raw.trim();
    if (token === '') continue;
    const m = token.match(TOKEN);
    // A resolver may know the whole token as an id ("EW-10", a sheet / P6
    // activity id with a hyphen). It wins only when the split reference names
    // no task or a different one, so a tolerant resolver that also maps
    // "3FS+2d" to row 3 keeps the type and lag.
    const wholeToken = opts.resolve?.(token);
    const splitRef = m?.[1]?.trim();
    const splitSource =
      wholeToken !== undefined && splitRef !== undefined ? opts.resolve?.(splitRef) : undefined;
    const useWhole =
      wholeToken !== undefined &&
      (splitSource === undefined || String(splitSource) !== String(wholeToken));
    if (!useWhole && !m) return { ok: false, error: `can't read "${token}"` };
    const [, refRaw = token, typeRaw, sign, num, e, unit] = useWhole ? [] : (m ?? []);
    let ref = refRaw.trim();
    let type = typeRaw;
    let source: TaskId | undefined;
    if (useWhole) {
      source = wholeToken; // resolved whole: no type / lag to read
    } else if (opts.resolve) {
      source = splitSource ?? opts.resolve(ref);
      // An id that itself ends in FS / SS / FF / SF ("PROCESS"): the whole text.
      if (source === undefined && type !== undefined) {
        const whole = opts.resolve(`${ref}${type}`);
        if (whole !== undefined) {
          source = whole;
          ref = `${ref}${type}`;
          type = undefined;
        }
      }
      if (source === undefined) return { ok: false, error: `no task ${ref}` };
    } else {
      if (!/^\d+$/.test(ref)) return { ok: false, error: `can't read "${token}"` };
      source = opts.tasks[Number(ref) - 1]?.id;
      if (source === undefined) return { ok: false, error: `no row ${ref}` };
    }
    if (opts.targetId !== undefined && String(source) === String(opts.targetId)) {
      return { ok: false, error: 'a task can’t be its own predecessor' };
    }
    if (seen.has(String(source))) return { ok: false, error: `"${ref}" is listed twice` };
    seen.add(String(source));
    const spec: PredecessorSpec = {
      source,
      type: (type?.toUpperCase() ?? 'FS') as DependencyType,
      lag: 0,
    };
    if (num !== undefined) {
      const signed = (sign === '-' ? -1 : 1) * Number(num);
      if (unit === '%') {
        spec.lagPercent = signed;
      } else {
        const minutes = e
          ? parseElapsedDuration(`${num}${unit ?? ''}`)
          : parseDuration(`${num}${unit ?? ''}`, durationUnitsFor(opts.minutesPerDay));
        if (minutes === null) return { ok: false, error: `can't read the lag in "${token}"` };
        spec.lag = Math.sign(signed) * minutes;
      }
      if (e) spec.lagElapsed = true;
    }
    preds.push(spec);
  }
  return { ok: true, preds };
}
