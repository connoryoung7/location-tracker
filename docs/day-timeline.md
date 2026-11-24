# Day Timeline

The **Day timeline** panel in the map UI shows one of a user's days: where they
stopped, the trips between those stops, and each trip's route on the map. Pick a
day (today by default) and choose **Show day**. Click a row to frame that stop or
trip on the map, or drag **Play back the day** to move a marker through the day,
second by second.

It answers the design questions in issue #26. Like Places visited, it runs only
on request: each run reads one day of locations, and may look places up online.

## How it works

```text
listLocations(user, day − 12 h … day + 2 h)
        │
        ▼
inferVisitedPlaces     stops (5+ min within 100 m), named    src/application/infer-visited-places.ts
        │
        ▼
buildDayTimeline       stops in time order, trips between    src/application/build-day-timeline.ts
        │
        ▼
buildDayTimelineView   rows, map features, playback track    src/application/build-day-timeline-view.ts
```

### Stops

A stop is a visit exactly as [Visited places](visited-places.md) finds it: a run
of fixes within 100 m of its centre for at least 5 minutes. The same rules apply.
Fixes worse than 200 m are ignored, one stray fix does not end a stop, and a
phone that goes quiet is taken to have stayed put until just before its next fix
from somewhere else. Stops are named the same way too: after the user's own area
(never looked up online), else the nearest named OpenStreetMap place, else
"Unknown place".

### Trips

A trip is the movement from one stop's departure to the next stop's arrival.

- **Route:** the first stop's centre, every fix on the way (with the same 200 m
  accuracy cut-off), then the next stop's centre.
- **Distance:** measured along that route. **Duration:** arrival less departure.
- **No fixes on the way** (the phone was quiet): the route is a straight line
  between the stops, drawn dashed, and the distance reads "about".
- **Still moving at the last fix:** the trip ends at that fix and reads "no stop
  yet".
- **Already moving when the history starts:** the trip starts at the first fix.

### Days

A day is a calendar day in the viewer's time zone, sent by the browser, so it is
23 or 25 hours long on a daylight-saving change. Where clocks jump forward at
midnight itself (Havana, for one), 00:00 never happens and the day starts at the
jump; where they fall back across midnight (Amman in 2021), or even back into
the day before (Casey in 2010), 00:00 happens twice and the day starts at the
first. A date a zone skipped altogether (Samoa's 2011-12-30) is an empty day. Locations are read from 12 hours
before the day to 2 hours after it, so a stay that began the evening before (home
overnight) is found whole, and the day's last stop can see when it ended. Stops
are clipped to the day ("Until 7:42 AM", "From 10:00 PM", "All day"); a trip
that crosses midnight is shown whole on both days, and playback places it where
it was at midnight, so the slider has a position from the day's first second.

### Computed, not stored

Nothing is persisted and there is no schema change: each run works the day out
from the stored locations. One day is at most a few thousand fixes, read once and
held in memory. A `trips` table built as locations arrive is the follow-up if
browsing many days, or listing trips across days, ever needs to be fast.

## Route

| Route                                         | Purpose                                         |
| --------------------------------------------- | ----------------------------------------------- |
| `GET /fragments/timeline?userId=&date=&tz=`   | HTMX fragment: the day's rows, playback, map    |

`date` is `YYYY-MM-DD` and must be a real date; `tz` is an IANA zone and falls
back to UTC when unknown. The response carries the list and a `timeline-data`
JSON block naming its user, which `public/day-timeline.js` draws and the user
switcher checks. An error response carries no data block, so the map keeps the
last day shown.

## Licensing

Place names come from OpenStreetMap, © OpenStreetMap contributors, available
under the [Open Database License](https://www.openstreetmap.org/copyright). The
panel credits it whenever a looked-up name is shown.

## Known limitations

- Phone switched off at one spot and on again elsewhere: the gap counts as time
  at the first spot, as in Visited places.
- Playback moves in straight lines between fixes, so a sparse trip cuts corners.
  It takes the short way over the 180° meridian, but the route line drawn on the
  map does not yet, and would cross the whole map there.
- Routes are drawn from every fix, unsimplified. Fine for a day; a longer range
  would want simplification first.
- Trips are not linked to areas, so editing an area changes a stop's name the
  next time the day is shown, but nothing is stored to update.
