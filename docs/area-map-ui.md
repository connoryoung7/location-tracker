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
| `POST /areas`                    | Create an area; the server assigns its `id`             |
| `DELETE /areas/:userId/:areaId`  | Delete an area                                          |
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

"Add area" puts the map in draw mode: click to place the centre, move out to size the
radius, click again to fix it, then name it and pick a user. The dashed preview circle
is computed in the browser purely for feedback — the geometry that gets stored is
always recomputed server-side from the submitted lat/lon/radius.

The draw panel deliberately sits **outside** the polled `#areas` element. The 30s poll
replaces that element wholesale, which would discard half-typed input.

Deleting is done from an area's popup on the map. Editing geometry is not supported
yet: changing a radius has to recompute geofence membership for that area, which is
more than the current upsert does.

The user field is free text because a brand-new tracker ID has no areas yet, so a
dropdown built from existing areas could never bootstrap the first one. It must match
the OwnTracks `tid` for geofencing to apply to that device.

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
