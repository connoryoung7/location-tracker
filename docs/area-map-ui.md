# Area Map UI

A read-only web app that plots every user-defined geofence area on a map. It is a
separate entrypoint from the OwnTracks ingestion API and reads areas directly out of
Redis.

## Running it

```sh
just dev-app          # hot-reloading, reads REDIS_URL from .env
just start-app        # via the shared entrypoint dispatcher
docker compose -f compose.dev.yaml up -d app
```

Then open <http://localhost:3002>.

| Env var     | Default                  | Purpose                    |
| ----------- | ------------------------ | -------------------------- |
| `APP_PORT`  | `3002`                   | Port the UI listens on     |
| `REDIS_URL` | `redis://localhost:6379` | Where the areas are stored |

`ENCRYPTION_KEY` must also be set, because `loadConfig()` validates the whole
config schema up front. The map UI never uses the key itself.

## Routes

| Route                  | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `GET /`                | The page shell: legend sidebar plus map container       |
| `GET /fragments/areas` | HTMX fragment — legend markup plus the areas as GeoJSON |
| `GET /_health`         | `200` when Redis answers, `503` otherwise               |
| `GET /_metrics`        | Prometheus metrics, same format as the ingestion API    |
| `/vendor/*`            | MapLibre and HTMX, served from `node_modules`           |
| `/static/*`            | `public/app.js` and `public/app.css`                    |

Areas are created through the **ingestion API** (`POST /areas` on port 3001), not
here — this iteration is display-only.

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

Each user gets a color from a fixed palette, indexed by the sorted position of their
user ID, so a user keeps the same color across refreshes regardless of the order
Redis returns their areas in. Unchecking a legend row applies a MapLibre `filter` on
the `userId` property.

## Enumerating users

Areas are stored per user (`area:meta:{userId}`), and Redis holds no index of users.
`RedisAreaRepository.listAllAreas()` discovers them with `SCAN MATCH area:meta:*`,
deduplicates the keys (SCAN can return one twice), then reuses `listAreas(userId)`
for each. This is O(keyspace) per call — fine at the scale this project targets, but
it is the thing to replace first if the area count grows.

## Security

There is **no authentication**, by design: the app is meant to run inside a Tailscale
network. Binding it to a public interface would expose every user's home and work
locations.

Area names and user IDs originate from the unauthenticated `POST /areas` endpoint, so
they are treated as untrusted input throughout: HTML-escaped in the legend, `<`
-escaped inside the JSON block, and rendered with `setText` (never `setHTML`) in map
popups.

## Offline behavior

HTMX and MapLibre are served from the app itself, so no CDN is required. The
basemap tiles do come from `tile.openstreetmap.org`, so without internet access from
the **browser** the area circles still render, but over a blank background.
