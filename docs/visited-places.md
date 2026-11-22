# Visited Places

The **Places visited** panel in the map UI works out where a user has been from
their stored locations: the spots they stopped at, how often, for how long, and
what each spot probably is, such as "Fresh Market, Grocery store, 6 visits".

Pick a user and a period (7, 30 or 90 days, or all time) and choose **Find
places**. The panel lists places busiest first, sums visits by kind of place
("Grocery store 6 · Café 3"), and plots each place as a purple point sized by
its visit count. Click a row to fly to it, or a point to see its summary.

It runs only on request, never on the 30-second poll: each run reads the whole
period and may look places up online.

## How it works

```text
listLocations(user, period)
        │
        ▼
detectVisits        stays of 5+ min within 100 m        src/application/detect-visits.ts
        │
        ▼
group into places   visits within 75 m of each other    src/application/infer-visited-places.ts
        │
        ├─► inside one of the user's areas?  → named after the area, never looked up
        │
        └─► otherwise → PlaceFinder (OpenStreetMap)       src/infrastructure/places/
                         nearest named place = best guess, the rest = "Or nearby"
```

### Finding visits

A visit is a run of fixes that stays within 100 m of its own centre for at least
5 minutes. Three rules make that hold up against real phone data:

- **Inaccurate fixes are ignored.** A fix reporting worse than 200 m accuracy
  (`acc`) is skipped, so a cell-tower fix cannot end a visit.
- **One stray fix does not end a visit.** The user only counts as gone after two
  fixes in a row land outside the stay, so a single GPS jump mid-visit does not
  split it in two.
- **A quiet phone still counts as being there.** OwnTracks reports rarely while
  the phone is not moving, so a whole grocery trip can be a single fix followed
  by silence. When the next fix finally arrives from somewhere else, the user is
  assumed to have left just in time to get there at 18 km/h (5 m/s), but never
  before they were last seen at the stay.

The last rule has a cost: a phone that was switched off at a spot and turned back
on somewhere else much later is credited with the whole gap at that spot.

Visits stream through, so the whole history is never held in memory.

### Grouping and naming places

Visits whose centres are within 75 m join the same place, so five grocery trips
become one place with five visits. Each place is then named:

1. **Your own areas first.** A place inside one of the user's areas takes the
   area's name ("Home", "Work"), the smallest area winning when they overlap.
   These places are **never sent to the place finder**, so the spots people
   usually label (home, work) stay off third-party servers.
2. **Then what is nearby.** Other places are looked up with the
   [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API), which
   returns named shops, restaurants, parks and so on within 100 m. The nearest
   is the best guess and up to four more are listed as alternatives. OpenStreetMap
   tags are turned into plain categories (`shop=supermarket` → Grocery store,
   `leisure=fitness_centre` → Gym), and street furniture such as parking lots,
   benches and ATMs is ignored.

Every name is a guess. A visit to a friend's flat above a café reads as the
café.

### Being polite to a shared server

The public Overpass instance is free and shared, and is sometimes slow. A run:

- looks places up **one at a time**, busiest first,
- looks up at most **15** places, and starts no new lookup once **20 seconds**
  have passed,
- **stops at the first failure** (a 429 or 504 usually means "back off"),
- **caches** results in memory, by coordinates rounded to about 11 m, so running
  it again picks up where the last run stopped. Failures are not cached.

Places that were not reached show "Not looked up yet; run again to identify
more". A failed lookup shows "Lookup failed; try again later".

## Configuration

| Env var        | Default                                   | Purpose                                         |
| -------------- | ----------------------------------------- | ----------------------------------------------- |
| `OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Where places are looked up. Empty turns it off. |

Looking places up sends the coordinates of each place outside your areas to that
server. To keep them private, point `OVERPASS_URL` at a
[self-hosted Overpass instance](https://wiki.openstreetmap.org/wiki/Overpass_API/Installation),
or set it to an empty value: visits and areas still work, and other places show as
"Unknown place".

The visit thresholds (100 m, 5 minutes, 200 m accuracy, 75 m grouping) are
defaults in code (`DEFAULT_VISIT_DETECTION_OPTIONS` and `inferVisitedPlaces`
options), not environment variables.

## Route

| Route                                  | Purpose                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| `GET /fragments/places?userId=&days=`  | HTMX fragment: places list, category summary, map points |

`days` is `7`, `30`, `90` or `all`, and defaults to `30`. Like the other fragments, the response carries the list
markup and a `places-data` JSON block that `public/visited-places.js` pushes into
its MapLibre source. An error response carries no data block, so the map keeps the
last result.

## Licensing

Place names and categories come from OpenStreetMap, © OpenStreetMap contributors,
available under the
[Open Database License](https://www.openstreetmap.org/copyright). The panel shows
that credit whenever it lists a looked-up name.

## Known limitations

- Phone switched off at one spot and on again elsewhere: the gap counts as a stay
  at the first spot (see above).
- Neighbouring shops less than 75 m apart can merge into one place. Their names
  then appear as the guess and its alternatives.
- The cache lives in memory, so a restart forgets it.
- Visits are worked out on every run, not stored. A long "All time" history takes
  as long to read as a recompute does.
