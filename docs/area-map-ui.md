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

`ENCRYPTION_KEY` must also be set, because `loadConfig()` validates the whole
config schema up front. The map UI never uses the key itself.

## Routes

| Route                            | Purpose                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `GET /`                          | The page shell: legend sidebar, draw panel, map         |
| `GET /fragments/areas`           | HTMX fragment — legend markup plus the areas as GeoJSON |
| `GET /fragments/area-list`       | HTMX fragment — every area as a table for the modal     |
| `GET /fragments/events?userId=`  | HTMX fragment — a user's latest area events plus points |
| `POST /areas`                    | Create an area; the server assigns its `id`             |
| `DELETE /areas/:userId/:areaId`  | Delete an area                                          |
| `GET /users`                     | Known tracker IDs and area owners for the dropdowns     |
| `GET /_health`                   | `200` when both stores answer, `503` otherwise          |
| `GET /_metrics`                  | Prometheus metrics, same format as the ingestion API    |
| `/vendor/*`                      | MapLibre and HTMX, served from `node_modules`           |
| `/static/*`                      | `public/app.js` and `public/app.css`                    |

Both write routes respond with the re-rendered areas fragment, so the sidebar and
the map update from a single round trip and cannot disagree.

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
  which rewrites the whole index from the store. A lost Redis volume self-heals on
  the next restart.
- **Dirty marking.** A projection write that fails is logged, not fatal — the store
  is already correct. The user is added to `area:projection-dirty` and the next read
  re-projects them, so the index self-heals without a background process.
- **Membership is preserved.** A rebuild rewrites area definitions but deliberately
  leaves `geofence:inside` and `geofence:pending-exit` alone, so a user already
  inside an area does not re-enter it and fire a duplicate event. State for areas
  that no longer exist is pruned.

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
returns the legend `<ul>` **and** a `<script type="application/json">` block holding
the full view model. `public/app.js` listens for `htmx:afterSwap` and pushes that
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

Each user's color is derived from a hash of their user ID, so it depends only on
their own ID and survives other users being added or removed. Unchecking a legend row
applies a MapLibre `filter` on the `userId` property.

## Drawing an area

"Add area" defaults to placing the circle on the map: click to place the centre, move out to size the
radius, then click again. Drag the blue centre marker to reposition the draft circle; the latitude and longitude fields
update as you drag. The circle stays visible while you edit latitude,
longitude, and radius in metres. Numeric edits update the preview immediately. Choose Enter
coordinates for manual placement; On the map is selected each time a new draft starts. Naming the
area or selecting its user does not interrupt map placement.

Both Add area and Recompute events use a User dropdown populated from distinct
stored location tracker IDs and existing area owners. Users without areas can
create their first one. A sole user is automatically selected; multiple users
require an explicit choice, and an empty list disables submission. User polling
preserves valid selections and does not replace the draft form.

Choose Review area to check the name, selected user, coordinates, and radius.
The centre marker is locked during review and saving. Back to editing unlocks it and keeps the
draft; Cancel discards it. Only Confirm and create sends
a creation request. Confirmation is disabled during that request to prevent
repeated clicks. Successful creation returns a JSON acknowledgement before the
legend refresh, so a failed legend read cannot be mistaken for a failed save.
Validation and store errors preserve the draft for correction.

The draw panel sits outside the polled `#areas` element, so background area
refreshes preserve the draft circle, entered fields, and review step. Deleting a
saved area remains available in its map popup. Editing an already saved area's
geometry is a separate feature.

## Security

There is **no authentication**, by design: the app is meant to run inside a Tailscale
network. Binding it to a public interface would expose every user's home and work
locations — and now also let anyone who reaches it create and delete areas.

Area names and user IDs are untrusted input, so they are HTML-escaped in the legend,
`<`-escaped inside the JSON block, and rendered into map popups via `textContent`
rather than `innerHTML`. The server assigns every area's `id`, so a client cannot
overwrite an existing area by posting a known one.

## Offline behavior

HTMX and MapLibre are served from the app itself, so no CDN is required. The
basemap tiles do come from `tile.openstreetmap.org`, so without internet access from
the **browser** the area circles still render, but over a blank background.

## Listing areas

**List areas**, in the Areas panel header, opens a modal table of every area:
name, user (with their map color), centre, and radius, grouped by user and then
sorted by name. The table is fetched each time the modal opens. **Show** closes
the modal and zooms the map to that area's circle. **Delete** asks for
confirmation, then refreshes the legend, the map, and the table together.

## Viewing events

The Recent events panel lists the selected user's 100 most recent `area.entered` and
`area.exited` events, newest first, and plots each one on the map as a green
(entered) or red (exited) point. It uses the same pattern as the areas: the
`/fragments/events` response carries the list markup and an `events-data` JSON
block, and `public/app.js` pushes that block into a MapLibre source.

The panel reloads when its User dropdown changes, after a successful recompute,
and on the 30-second poll. The map frames a user's events once, when that user
is first selected, so a poll never moves the view. Click a list row to fly to
that event, or a point to see its area and time. Times are rendered in UTC by
the server and converted to the viewer's local time in the browser.

## Recomputing event history

Enter a tracker ID in the Recompute events form and confirm. Replay uses all stored
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
