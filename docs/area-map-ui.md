# Area Map UI

A web app for viewing and drawing user-defined geofence areas on a map. It is a
separate entrypoint from the OwnTracks ingestion API.

## Running it

```sh
just dev-app          # hot-reloading, reads config from .env
just start-app        # via the shared entrypoint dispatcher
docker compose -f compose.dev.yaml up -d app
```

Then open <http://localhost:3002>.

| Env var             | Default                  | Purpose                            |
| ------------------- | ------------------------ | ---------------------------------- |
| `APP_PORT`          | `3002`                   | Port the UI listens on             |
| `REDIS_URL`         | `redis://localhost:6379` | Where the geofence index lives     |
| `POSTGRES_PASSWORD` | unset                    | Set to own areas in Postgres       |
| `DB_PATH`           | `location-tracker.db`    | SQLite file when Postgres is unset |
| `OVERPASS_URL`      | public Overpass instance | Where visited places are looked up |

`ENCRYPTION_KEY` must also be set, because `loadConfig()` validates the whole
config schema up front. The map UI never uses the key itself.

## Routes

| Route                               | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `GET /?user=`                       | The page shell for one user: sidebar, draw panel, map      |
| `GET /fragments/areas?userId=`      | HTMX fragment — a user's areas plus their circles          |
| `GET /fragments/area-list?userId=`  | HTMX fragment — a user's areas as a table for the modal    |
| `GET /fragments/events?userId=`     | HTMX fragment — a user's latest area events plus points    |
| `GET /fragments/places?userId=`     | HTMX fragment — places a user stopped at; see below        |
| `POST /areas`                       | Create an area; the server assigns its `id`                |
| `PUT /areas/:userId/:areaId`        | Change an area's name and circle; see below                |
| `PATCH /areas/:userId/:areaId`      | Put an area in a category, or take it out                  |
| `DELETE /areas/:userId/:areaId`     | Delete an area                                             |
| `GET /categories?userId=`           | A user's categories, as JSON                               |
| `POST /categories`                  | Create a category; see [Categories](#categories)           |
| `PATCH /categories/:userId/:id`     | Rename and/or recolour a category                          |
| `DELETE /categories/:userId/:id`    | Delete a category; its areas stay, uncategorised           |
| `GET /users`                        | Known tracker IDs and area owners for the user selector    |
| `POST /users/recompute`             | Rebuild a user's event history; see below                  |
| `GET /_health`                      | `200` when both stores answer, `503` otherwise             |
| `GET /_metrics`                     | Prometheus metrics, same format as the ingestion API       |
| `/vendor/*`                         | MapLibre and HTMX, served from `node_modules`              |
| `/static/*`                         | `public/app.js`, its modules, and `public/app.css`         |

Both area write routes respond with that user's re-rendered areas fragment, so
the sidebar and the map update from a single round trip and cannot disagree. The
category routes, and `PATCH /areas`, are used from the List areas modal and answer
with its re-rendered list instead; the page then refreshes the Areas panel. All of
them answer with JSON instead when the request sends `Accept: application/json`.

## Selecting a user

The page shows **one user at a time**. A single User selector in the sidebar
header (`#user-scope`) decides whose areas, events, and places you see and who
Add area, Recompute events, and Find places act on. No panel has a user
dropdown of its own, and the map never mixes users. There is no "all users"
view.

- **Opening the page.** `/?user=AB` opens on AB: the server renders AB as the
  selected option, so the first fragment loads already carry it. Without
  `?user=`, the page restores the last user picked in this browser
  (`localStorage`); without that, it waits for `GET /users`, selects the sole
  user if there is only one, and otherwise asks you to pick.
- **Remembering it.** Every change updates `?user=` with `history.replaceState`
  (so it doesn't fill the back button) and the remembered user, so reloads and
  bookmarks keep the user. A `?user=` that isn't a tracked user shows a notice
  under the selector and falls back the same way; a stale remembered user is
  replaced silently.
- **Switching.** Every panel includes `#user-scope` and reloads on
  `change from:#user-scope`, with `hx-sync="this:replace"` so a request still in
  flight for the previous user is cancelled. The map drops the previous user's
  circles, events, places, and any open popup straight away, and frames the new
  user once, from whichever of their areas or events arrives first. Places
  results are cleared but not re-run: that panel only ever runs on request.
  Responses carry the user they are for, and one that arrives for anyone but the
  selected user is ignored and reloaded.
- **An open area draft.** Switching while drafting an area asks first, and
  declining keeps the current user. A draft is always saved for the user shown in
  its review step. If the poll drops the selected user altogether, the draft is
  discarded without asking, since there is no one left to save it for.
- **No user selected.** Every panel prompts you to select a user, the map is
  empty, and the user actions are disabled.

The selector lives in `public/user-scope.js`, which is tested with happy-dom
against the real page markup.

## Where areas live

**Postgres (or SQLite) owns areas. Redis is a derived index.**

The geofence evaluator needs a Redis GEO index to do membership checks inside Redis,
but Redis is not durable enough to be the record of truth — losing the volume would
lose every area. So writes go to the store first, then to the index:

```text
POST /areas ──► PostgresAreaRepository   (record of truth)
                        │
                        └──► RedisAreaProjection   (GEO index the Lua queries)
```

`SyncingAreaRepository` owns that fan-out. Reads always come from the store, so the
UI works even when Redis is down.

### Staying consistent

- **Boot rebuild.** Every entrypoint calls `initialize()` before serving traffic,
  which rewrites the whole index from the store, user by user. A lost Redis volume
  self-heals on the next restart.
- **Dirty marking.** A projection write that fails is logged, not fatal — the store
  is already correct. The user is added to `area:projection-dirty` and the next read
  re-projects them, so the index self-heals without a background process.
- **Membership is preserved.** A rebuild rewrites area definitions but deliberately
  leaves `geofence:inside` and `geofence:pending-exit` alone, so a user already
  inside an area does not re-enter it and fire a duplicate event. State for areas
  that no longer exist is pruned.
- **Edits never resurrect.** `updateArea` is a single `UPDATE … WHERE id AND
  user_id` that reports whether a row changed, so an edit racing a delete cannot
  re-insert the area the way the `addArea` upsert would. Only a successful update
  is projected.
- **Writes are serialized per user.** Every create, edit, and delete holds the
  user's lock from its store write until its index write is done. It is the same
  lock ingestion and recompute hold: a Postgres advisory lock, or SQLite's write
  lock. So writes reach the store and the index in the same order from every
  process: two edits of one area can't leave Redis on the older circle, and a
  delete can't be undone by an edit finishing after it.
  - The store write runs inside the lock's transaction (on Postgres it reuses the
    connection the lock reserved, so lock holders can never exhaust the pool), and
    commits when the lock is released. If anything fails, the commit included,
    the user is marked dirty, since Redis may already hold the change.
  - Waiting for the lock is bounded: 250 ms on Postgres, and 1 s on SQLite, both
    for the busy timeout and for queueing behind another writer in the same
    process. An edit that times out, for example during a long recompute, answers
    `503` and the form keeps the changes.
- **Repairs and the boot rebuild hold the lock too.** Writes commit only when
  they release the lock, after Redis already has the change, so an unlocked
  rebuild could read the old circle, write it back over the new one, and call
  the user clean. Each user is rebuilt from the store under their lock, and their
  dirty marker is cleared inside it. A repair runs on reads, which recompute makes
  while holding the lock, so it waits at most 100 ms and otherwise leaves the
  user dirty for the next read. The boot rebuild waits up to 5 s per user and
  marks any still-busy user dirty.

### The one-time cutover

Areas used to live only in Redis. On boot, if the store is empty **and** the index is
not, those areas are imported into the store before the rebuild — otherwise the first
rebuild after this change would delete them. The import is guarded on the store being
empty, so it can never overwrite real data and is safe to leave in place.

### Known gap

`replaceUserAreas` clears a user's keys and rewrites them, and the geofence Lua treats
a missing `area:maxradius` as "no areas". During a _repair_ (not the boot rebuild,
which finishes before the server listens) there is a brief window where a concurrent
location evaluation sees no areas and emits no events. Locations are still persisted;
only geofence events can be missed. Making the rebuild atomic would mean moving it
into Lua.

## How it fits together

HTMX is the data transport, not just a markup swapper. `GET /fragments/areas`
returns the selected user's list of areas **and** a `<script type="application/json">`
block holding their circles as GeoJSON. `public/app.js` listens for `htmx:afterSwap` and pushes that
JSON into the MapLibre GeoJSON source. One response drives both the sidebar and the
map, so they can never disagree, and there is no second JSON API to keep in sync.

The page polls every 30 seconds, so areas added elsewhere appear without a reload.

### Why areas are polygons, not circles

MapLibre's `circle` layer measures its radius in **pixels**, so it cannot represent a
geofence whose radius is in meters. `buildAreaMapView()`
(`src/application/build-area-map-view.ts`) approximates each area as a 64-vertex
polygon ring instead, scaling longitude by `cos(latitude)` so the shape stays correct
away from the equator. Keeping that math server-side also puts it under `bun test`.

### Colors

Each circle is drawn in its category's colour, and uncategorised circles in a
neutral grey; the swatches in the Areas panel and the List areas modal use the
same colours. A category stores a palette key (`blue`, `orange` or `aqua`), not a
hex value: `public/app.css` gives each key a shade for the light basemap and one
for the dark basemap, and `public/app.js` reads them when the map loads.

There are only three colours on purpose. On a map any two categories can sit side
by side, and these three, taken from the dataviz skill's reference palette, are
the only ones that stay distinguishable from one another in both themes,
colour-blind viewers included (checked with its validator across every pair).
Red, green and violet are left out because entered events, exited events and
visited places already use them. A fourth category reuses a colour, so colour is
never the only cue: the Areas panel groups areas under named headings, and each
area's popup names its category.

## Categories

A user can put each of their areas into one of their own categories, such as
"Home", "Work" or "Gym", or leave it uncategorised. Categories belong to one
tracked user, like areas: two users can each have a "Work" without sharing it.

- **Storage.** Categories live in `area_categories` (`id`, `user_id`, `name`,
  `color`), in the same store as areas, and `areas.category_id` points at one.
  Names are unique per user regardless of case. Categories never reach Redis: they
  don't affect whether someone is inside an area, so the geofence ignores them.
- **Creating one.** Either from the New area form's Category select (**New
  category…**), which creates it when the area is confirmed, or with **Add
  category** in the List areas modal. A new category takes the colour the user's
  categories use least, earliest in the palette on a tie, so their first three get
  three different colours.
- **Changing an area's category.** The Category column in the List areas modal
  saves as soon as it changes. This is the only place to change it: the Edit area
  form changes the name and circle only, so it hides the Category select.
- **Renaming, recolouring and deleting.** In the Categories section of the List
  areas modal. Renaming never changes the colour. Deleting asks first, saying how
  many areas will become uncategorised, then clears it from those areas in the
  same transaction. That's done explicitly rather than by `ON DELETE SET NULL`,
  because SQLite here runs without `PRAGMA foreign_keys`.
- **Same user only.** An area can only be in its own user's categories. The
  database can't enforce that, so `POST /areas` and `PATCH /areas` check it and
  answer `422` otherwise.
- **The Areas panel** groups the user's areas under their categories, in name
  order, with uncategorised areas last. A user with no categories sees the plain
  list.
- **Seeds and the ingestion API** don't know about categories. Re-upserting an area
  without a category keeps the one it has, so re-running a seed never strips them.

## Drawing an area

"Add area" defaults to placing the circle on the map: click to place the centre, move out to size the
radius, then click again. Drag the blue centre marker to reposition the draft circle; the latitude and longitude fields
update as you drag. The circle stays visible while you edit latitude,
longitude, and radius in metres. Numeric edits update the preview immediately. Choose Enter
coordinates for manual placement; On the map is selected each time a new draft starts. Naming the
area does not interrupt map placement.

The area is drafted for the page-wide user (see [Selecting a user](#selecting-a-user)),
so a user without any areas can create their first one. Add area is disabled
until a user is selected. User polling preserves the selection and does not
replace the draft form.

The Category select offers None, the user's categories, and **New category…**,
which asks for a name; see [Categories](#categories). A place proposed through
**Save as area** starts with no category.

Choose Review area to check the name, user, category, coordinates, and radius.
The centre marker is locked during review and saving. Back to editing unlocks it and keeps the
draft; Cancel discards it. Only Confirm and create sends
a creation request. Confirmation is disabled during that request to prevent
repeated clicks. Successful creation returns a JSON acknowledgement before the
legend refresh, so a failed legend read cannot be mistaken for a failed save.
Validation and store errors preserve the draft for correction.

The draw panel sits outside the polled `#areas` element, so background area
refreshes preserve the draft circle, entered fields, and review step. Deleting a
saved area remains available in its map popup.

## Editing an area

**Edit**, in an area's map popup or its row in the List areas table, opens the
area in the same form, now headed **Edit area**. It starts on the edit step with
the name, centre, and radius filled in and the circle on the map. Drag the centre
marker or change the numbers, or switch Place circle to On the map to redraw the
circle from scratch. Review area, then **Save changes**. Cancel leaves the area
as it was. Opening an area replaces any draft in progress, and switching users
discards an edit as it does a draft.

The form sends `PUT /areas/:userId/:areaId` with the new `name`, `lat`, `lon`,
and `radius` (validated like a new area). The area keeps its ID, owner and
category (see [Categories](#categories)): the
owner is taken from the URL and an edit can never move an area to another user.
An unknown or since-deleted area answers `404` and is never created, even when
the delete races the edit (see [Staying consistent](#staying-consistent)), so the
form keeps your changes and says the area no longer exists.

What an edit does to events:

- **Live geofencing** follows the new circle from the user's next location. The
  geofence index keeps who is inside the area, so someone still inside the moved
  circle sees no event, someone it no longer covers gets the usual exit, and
  someone it now covers gets an enter.
- **Past events show the new name** in Recent events and on the map, because
  events are always labelled with their area's current name (see
  [Named after the area as it is now](#named-after-the-area-as-it-is-now)).
  Saving an edit refreshes Recent events straight away.
- **Past events are never rewritten.** Each keeps the name it was stored with
  and the circle it was worked out against. Recompute events rebuilds them from
  the current areas if you want history to follow a moved circle.

## Security

There is **no authentication**, by design: the app is meant to run inside a Tailscale
network. Binding it to a public interface would expose every user's home and work
locations — and now also let anyone who reaches it create and delete areas.

Area names, category names and user IDs are untrusted input, so they are
HTML-escaped in the sidebar, the List areas modal and the `?user=` preselection,
`<`-escaped inside the JSON block, and rendered into the user selector, the
Category select and map popups via `textContent` rather than `innerHTML`. The
server assigns every area's and category's `id`, so a client cannot overwrite an
existing one by posting a known ID; an edit must name an area that already
exists, under the user it belongs to.

## Offline behavior

HTMX and MapLibre are served from the app itself, so no CDN is required. The
basemap tiles do come from `tile.openstreetmap.org`, so without internet access from
the **browser** the area circles still render, but over a blank background.

## Listing areas

The Areas panel lists the selected user's areas by name, grouped by category;
click one to zoom the map to it. **List areas**, in the panel header, opens a
modal table of the same areas with their category, centre and radius, sorted by
name, followed by the user's categories; see [Categories](#categories). The table is fetched each
time the modal opens. **Show** closes the modal and zooms the map to that area's
circle. **Edit** closes the modal and opens the area for editing (see
[Editing an area](#editing-an-area)). **Delete** asks for confirmation, then
refreshes the Areas panel, the map, and the table together.

## Viewing events

The Recent events panel lists the selected user's 100 most recent `area.entered` and
`area.exited` events, newest first, and plots each one on the map as a green
(entered) or red (exited) point. It uses the same pattern as the areas: the
`/fragments/events` response carries the list markup and an `events-data` JSON
block, and `public/app.js` pushes that block into a MapLibre source.

The panel reloads when the page-wide user changes, after a successful recompute,
and on the 30-second poll. Polls never move the view; see
[Selecting a user](#selecting-a-user) for how a newly selected user is framed. Click a list row to fly to
that event, or a point to see its area and time.

### Named after the area as it is now

Each event is labelled with its area's **current** name, looked up by area ID in
the selected user's areas, so renaming "Hom" to "Home" relabels the area's whole
history. Nothing is rewritten: `area_events.area_name` keeps the name the area
had when the event happened, and is shown only when the area has since been
deleted, falling back to the area ID for events stored with no name. If the areas
can't be loaded, the events are still listed, under their stored names.

Push notifications are sent as each event happens, so they carry the name the
area had at that moment.

### Grouped by day

The list is broken into one section per day, newest day first, and shows only
days that have events. Each section has a heading (`Today`, `Yesterday`, or a
date such as `Thu, Nov 19`, with the year added outside the current one) and an
event count. The heading stays pinned while that day's events scroll past.

Days are the **viewer's** days. `public/app.js` puts the browser's IANA time zone
into a hidden `tz` field in `#user-scope`, which htmx sends with every request, and
`buildAreaEventView()` groups and formats times in that zone, so an event at
22:00 in New York is not filed under the next day just because it is past
midnight in UTC. An unknown or missing zone falls back to UTC. `Yesterday` is
worked out from calendar dates rather than "24 hours ago", so it stays correct
on daylight-saving days. Labels are always in `en-US` so they don't depend on
the server's locale.

## Visited places

The Places visited panel finds where the selected user stopped for 5 minutes or
more and names each spot from their areas or from nearby OpenStreetMap places.
Changing the user clears its results. Any place that is not yet an area offers
**Save as area** in its list row and its map popup, which opens a pre-filled
draft in the New area form for review. See [visited-places.md](visited-places.md).

## Recomputing event history

Choose Recompute events and confirm; it rebuilds the selected user's history. Replay uses all stored
locations in timestamp order (database ID breaks ties) and the user's current
areas. It replaces only that user's events in one database transaction. Historical
notifications and Redis pub/sub messages are not resent. Date ranges are not yet
exposed. Locations stream from SQLite or are fetched in pages from Postgres;
produced events are held in memory until replacement.

Ingestion and replay serialize work per user. All ingestion processes must run
this version.

With Postgres, they use a transaction-scoped advisory lock on the same connection
as the repository operations. A crash rolls back uncommitted writes and releases
the lock automatically. Rebuilt events and their final inside/pending-exit state
commit together in `geofence_replay_state`. Before evaluating the next live location,
ingestion applies that state to Redis and acknowledges it in the ingestion
transaction. A failed Redis restoration leaves the handoff available for retry;
a crash before ingestion commits also retains it. No manual lock cleanup is
needed for Postgres. Startup creates the recovery table automatically.

SQLite uses a database write transaction and stores recovery state alongside the
events. SQLite serializes writers database-wide; lock acquisition times out after
one second. Process death rolls back uncommitted work and releases the lock.
Neither backend requires manual Redis lock cleanup. Live locations are persisted
before geofence work; Redis outages and busy geofence locks are logged and do not
discard locations. A failed restoration retains its recovery record for retry.
Postgres lock acquisition times out after 250ms to bound connection pool pressure.
The geofence state transition remains under the database lock for consistency.

To run the Postgres recovery tests, point `TEST_POSTGRES_URL` at a **throwaway**
database and `REDIS_URL` at a test Redis instance, then run `bun test`. The Postgres
suite clears its location, event, and replay-state tables. It kills a separate
worker process to verify rollback and automatic lock release, and verifies retry
after a failed Redis restoration.

Successful runs log duration and before/after counts, and expose
`geofence_recompute_duration_ms`, `geofence_recompute_locations_total`, and
`geofence_recompute_events_total` at `/_metrics`.
