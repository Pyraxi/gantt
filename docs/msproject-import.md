# Importing an MS Project programme

`parseMspdi` reads MS Project's XML format (MSPDI): File → Save As → XML in MS Project, or an `.mpp` converted by MPXJ. It keeps everything `schedule()` needs to land on MS Project's own dates:

- tasks and the outline;
- links with type and lag (working, elapsed and percent lags);
- constraints;
- calendars (working week and exceptions), including task and resource calendars;
- progress (% complete, actual dates, status date).

Anything it can't map is listed in `droppedFields`, rather than lost silently.

```ts
import { parseMspdi, schedule } from '@pyraxi/cpm-engine';

const { project, droppedFields } = parseMspdi(xml);
const scheduled = schedule(project);
```

## Keep these from the file

- **Constraints.** Programmes are often anchored by a Start No Earlier Than on the first task, or on its summary, which applies to every task under it. Without them, the programme starts at the file's project start date, which is often years stale.
- **The calendar.** Use the file's working week (often 8:00–12:00 plus 13:00–17:00, an 8-hour day) and its exceptions, such as a Christmas shutdown. Durations in MSPDI are working minutes, so a calendar with a different day length shortens or stretches every task.

## Add the public holidays the file is missing

MS Project calendars are often not kept up to date, so they can miss a year's public holidays and schedule work on them. To keep the file's calendar and add the New Zealand public holidays it lacks:

```ts
import { nzPublicHolidays, parseMspdi, schedule, type Project } from '@pyraxi/cpm-engine';

function withNzHolidays(project: Project, years: number[], region?: 'wellington'): Project {
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const holidays = nzPublicHolidays(years, region);
  return {
    ...project,
    calendars: project.calendars.map((calendar) => {
      if (calendar.id !== project.defaultCalendarId) return calendar;
      const listed = new Set(calendar.exceptions.map((e) => key(e.date)));
      return {
        ...calendar,
        exceptions: [...calendar.exceptions, ...holidays.filter((h) => !listed.has(key(h.date)))],
      };
    }),
  };
}

const { project } = parseMspdi(xml);
const scheduled = schedule(withNzHolidays(project, [2026, 2027], 'wellington'));
```

A day the file already lists keeps the file's entry, so a shutdown or a working-day override is never replaced. Dates then differ from MS Project only where MS Project scheduled work on a public holiday.

## Milestones

MS Project shows a milestone at its predecessor's finish, e.g. Fri 5:00 pm. The engine currently places it at the next working moment, Mon 8:00 am. It's the same working time, so float and successors don't change, but the date shown differs. To display MS Project's date, show a milestone at the previous working moment:

```ts
import { snapToPreviousWorkingMoment } from '@pyraxi/cpm-engine';

const shown = task.type === 'milestone' ? snapToPreviousWorkingMoment(task.start, calendar) : task.start;
```
