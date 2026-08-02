# Plan — Per-User Geofencing for Predefined Areas (Issue #18 / LT-18)

## Context

**Why:** Issue #18 asks for server-side geofencing so the system can react when a
user enters or leaves a predefined circular area. Today the app only _persists_
device-reported OwnTracks `transition` events (the phone computes those
client-side); it does not compute geofence membership itself and has no notion of
server-defined areas.

**What we're building:** An `AreaRepository` that stores per-user circular
geofences (`lat`, `lon`, `radius`), plus a geofence engine that — **inside Redis,
not in the Bun app** — decides which of a user's areas contain each incoming
location, diffs that against prior state, and emits **enter** / **exit** events.
Exit events fire only after the user has been outside for a threshold cushion
(default 60s), to avoid flapping. Traccar's geofence transition model is the
reference: areas + enter/leave events, per account.

**Hard constraints from the issue:**

- Areas are circular: `lat`, `lon` (issue says "lng"; we use `lon` to match the
  existing domain vocabulary), `radius` (meters).
- Enter/exit **events** are emitted.
- An **exit cushion** (~60s) before firing the exit event.
- The membership computation happens **in Redis** — the Bun app must _not_ loop
  over areas doing point-in-circle math.
- Geofences are **per-user**; only a user's own areas apply to them.

**Confirmed design decisions (from clarification):**

1. **User key = `tid`** (already on every `LocationPayload`; areas store a
   matching `userId`).
2. **Area store = Redis-only** with persistence (AOF) enabled — Redis is the
   source of truth; no SQL mirror.
3. **Exit trigger = on next location update** past the cushion. A device that
   goes silent right after leaving delays its exit event; documented as a known
   limitation (a background sweeper is out of scope — see Future Work).
4. **Event sinks = Redis Pub/Sub + DB persistence + NotificationSender**, fanned
   out through a re-introduced `EventPublisher` port (also closes issue #6).

---

## Architecture Overview

Everything follows the existing ports/adapters layout (`@/domain/ports.ts`
interfaces implemented by `@/infrastructure/*` and `@/repository/*` adapters,
wired in `@/entrypoints/http.ts`, invoked from `@/application/handlers/*`).

Ingestion path stays the same:
`POST /pub` → `server.ts` (Zod validate) → `handlePayload` → `handleLocation`.
We add one step in `handleLocation`: after saving the location, call the
**geofence evaluator** and publish whatever events it returns.

```text
LocationPayload (tid, lat, lon, tst)
        │
        ▼
 handleLocation ──► repo.saveLocation (unchanged)
        │
        ▼
 geofence.evaluate(tid, lon, lat, tst)     ← runs a Lua script IN Redis
        │  returns GeofenceEvent[]
        ▼
 for each event: eventPublisher.publish(event)
        │
        ├─► RedisEventPublisher   (PUBLISH geofence:events)
        ├─► DbEventPublisher      (INSERT into area_events)
        └─► NotificationEventPublisher ──► NotificationSender
```

### Why the geofencing lives in a Redis Lua script

To honor "do NOT have the Bun app handle which areas a user is in," the entire
membership + state-diff + cushion logic runs as a **single atomic Lua script**
(`EVALSHA`, with an `EVAL`/`SCRIPT LOAD` fallback on `NOSCRIPT`). The Bun app
passes `(userId, lon, lat, tst, thresholdSeconds)` in and gets a list of typed
events out. Redis does all the geometry (via GEO commands) and owns all the
per-user state. This is atomic (no read-modify-write races across concurrent
location updates for the same user) and keeps the app a thin relay.

---

## Redis Data Model (per user, keyed by `tid`)

| Key | Type | Purpose | Written by |
| --- | --- | --- | --- |
| `geo:areas:{userId}` | GEO sorted set | Area centers (member = `areaId`, at `lon`/`lat`) | `AreaRepository` via `GEOADD` |
| `area:meta:{userId}` | HASH | `areaId` → JSON `{ name, radius }` (radius not stored by GEO) | `AreaRepository` |
| `area:maxradius:{userId}` | string | Largest radius among the user's areas (bounds the GEOSEARCH) | `AreaRepository` maintains on add/remove |
| `geofence:inside:{userId}` | SET | `areaId`s the user is currently considered inside | Lua script |
| `geofence:pending-exit:{userId}` | HASH | `areaId` → `tst` when it first went outside (cushion timer) | Lua script |

Note: Redis GEO commands take **(longitude, latitude)** order — the code must pass
`lon` before `lat`. Membership is **inclusive** (`distance <= radius`).

### `AreaRepository` behavior (Redis adapter)

- `addArea(area)` → `GEOADD geo:areas:{userId} lon lat areaId`, `HSET area:meta`,
  recompute/raise `area:maxradius`.
- `removeArea(userId, areaId)` → `ZREM` + `HDEL` meta + recompute maxradius +
  `SREM geofence:inside` + `HDEL geofence:pending-exit` (clean up stale state).
- `listAreas(userId)` / `getArea(userId, areaId)` → read GEO pos + meta.
- `healthCheck()` → `PING` (mirrors `LocationRepository.healthCheck`).

### Geofence evaluation Lua algorithm (runs in Redis)

Input: `userId, lon, lat, tst, thresholdSeconds`. Steps:

1. If `geo:areas:{userId}` is empty → return `[]`.
2. `maxR = GET area:maxradius:{userId}`.
3. `candidates = GEOSEARCH geo:areas:{userId} FROMLONLAT lon lat BYRADIUS maxR m WITHDIST`
   → list of `(areaId, distanceMeters)`. (Anything outside `maxR` cannot be
   inside any area, since every radius ≤ maxR.)
4. `nowInside = { areaId : distance <= radius(areaId) }` (radius from `area:meta`).
5. `prev = SMEMBERS geofence:inside:{userId}`.
6. **Enters:** for `areaId ∈ nowInside \ prev` → `SADD inside`,
   `HDEL pending-exit areaId`, emit `('entered', areaId, tst)`.
7. **Exits / cushion:** for each `areaId ∈ prev`:
   - still in `nowInside` → `HDEL pending-exit areaId` (came back / never left); no event.
   - outside & no pending timer → `HSET pending-exit areaId = tst`; no event.
   - outside & `tst - pendingSince >= thresholdSeconds` → `SREM inside`,
     `HDEL pending-exit`, emit `('exited', areaId, tst)`.
   - outside & within cushion → no event (stays "inside" until confirmed).
8. Return the flat event list; the adapter maps it to typed `GeofenceEvent`s.

This yields the required semantics: no duplicate enters, no exit until ≥ threshold
seconds continuously outside, and re-entry within the cushion silently cancels the
pending exit (no exit, no re-enter).

---

## Domain & Ports (new / changed)

**`@/domain/types.ts`** — add:

- `Area = { id: string; userId: string; name: string; lat: number; lon: number; radius: number }`
  (JSDoc each field to match the file's style). The pre-existing unused
  `Geofence = { waypoint; isInside }` type is waypoint-shaped and won't be reused;
  leave it or remove it — it does not model our per-user `Area`.

**`@/domain/schemas.ts`** — add `AreaSchema` (Zod: `lat` ∈ [-90,90], `lon` ∈
[-180,180], `radius` > 0, `userId`/`id`/`name` non-empty) for validating
the area-management API input. Follows the hand-maintained schema convention.

**`@/domain/events.ts`** (re-introduce; was removed in a prior refactor):

- `PubSubEvent = { _type: string }`
- `AreaEnteredEvent = PubSubEvent & { _type: 'area.entered'; userId; areaId; areaName?; lat; lon; tst }`
- `AreaExitedEvent = PubSubEvent & { _type: 'area.exited'; ... same shape ... }`
- `GeofenceEvent = AreaEnteredEvent | AreaExitedEvent`
- `DomainEvent = GeofenceEvent` (union kept open for future events)

Naming follows `.claude/skills/naming` — `<Subject><VerbPast>Event` types with
`<entity>.<verb>` `_type` strings.

**`@/domain/ports.ts`** — add:

- `AreaRepository` — `addArea`, `removeArea`, `listAreas`, `getArea`, `healthCheck`.
- `GeofenceEvaluator` — `evaluate(userId: string, lon: number, lat: number, tst: number): Promise<GeofenceEvent[]>`.
- `EventPublisher` — `publish(event: DomainEvent): void | Promise<void>` (re-add; closes #6).
- `saveAreaEvent(event: GeofenceEvent): void | Promise<void>` added to the existing
  `LocationRepository` interface (mirrors how `saveTransition` lives there).
- `NotificationSender` already exists — no change to the interface.

---

## Infrastructure & Repository Adapters (new files)

Following existing naming (`kebab.role.ts`, `class QualifierRole`):

| File | Class | Implements |
| --- | --- | --- |
| `@/infrastructure/redis/client.ts` | `createRedisClient(url)` factory (`Bun.RedisClient`) | — |
| `@/repository/area-repository/redis.repository.ts` | `RedisAreaRepository` | `AreaRepository` |
| `@/infrastructure/geofence/redis.geofence-evaluator.ts` | `RedisGeofenceEvaluator` | `GeofenceEvaluator` |
| `@/infrastructure/geofence/geofence.lua.ts` | the Lua source string + `SHA` load/eval helper | — |
| `@/infrastructure/events/redis.event-publisher.ts` | `RedisEventPublisher` (PUBLISH JSON) | `EventPublisher` |
| `@/infrastructure/events/db.event-publisher.ts` | `DbEventPublisher` (→ `repo.saveAreaEvent`) | `EventPublisher` |
| `@/infrastructure/events/notification.event-publisher.ts` | `NotificationEventPublisher` (formats subject/body) | `EventPublisher` |
| `@/infrastructure/events/composite.event-publisher.ts` | `CompositeEventPublisher` (fan-out, per-sink try/catch) | `EventPublisher` |
| `@/infrastructure/notifications/log.notification-sender.ts` | `LogNotificationSender` (logs the alert) | `NotificationSender` |

- Use **`Bun.redis` / `Bun.RedisClient`** and issue GEO/EVAL/PUBLISH via the
  client's generic `.send(command, args)` (CLAUDE.md: `Bun.redis`, not `ioredis`).
- `LogNotificationSender` is the initial concrete `NotificationSender` (there's no
  email/push channel today); it's the seam where a real push/email/MQTT sender
  drops in later.
- `CompositeEventPublisher` wraps each sink in its own `try/catch` so one failing
  sink (e.g. Redis down) never blocks the others or the request.

---

## Wiring, Handlers, and API changes

**`@/application/handle-payload.ts`** — widen `Deps`:
`{ repo, logger, decryptor, reverseGeocoder, geofence: GeofenceEvaluator, eventPublisher: EventPublisher }`.

**`@/application/handlers/location.handler.ts`** — widen its `deps` slice to include
`geofence` + `eventPublisher`. After `await deps.repo.saveLocation(payload)`:
`const events = await deps.geofence.evaluate(payload.tid, payload.lon, payload.lat, payload.tst);`
then `for (const e of events) await deps.eventPublisher.publish(e);`. Evaluation is
awaited (fast `EVALSHA`); a failing evaluate is caught and logged so it never drops
the location save.

**`@/entrypoints/http.ts`** (composition root) — in _both_ the Postgres and SQLite
branches: build `const redis = createRedisClient(config.redisUrl)`; construct
`RedisAreaRepository`, `RedisGeofenceEvaluator`, the three sink publishers wrapped
in a `CompositeEventPublisher`, and a `LogNotificationSender`; add `geofence` +
`eventPublisher` (and pass `areaRepo` to the server for the management routes) to
`deps`.

**Area management surface** — areas are "predefined," so we need a way to define
them. Add minimal CRUD routes to `@/infrastructure/http/server.ts` backed by
`AreaRepository`, validated with `AreaSchema`:

- `POST /areas` → create/replace an area for a user.
- `GET /areas/:userId` → list a user's areas.
- `DELETE /areas/:userId/:areaId` → remove one.

(Alternative: a one-off seed script under `scripts/`. Recommendation: the HTTP
routes, since they reuse the running server and `AreaRepository`.)

---

## Config & Deployment

**`@/config.ts`** (+ `@/config.test.ts`) — add two env vars in all three spots
(schema, `Config` type, `loadConfig` destructure/return), and add the new keys to
`config.test.ts`'s `envKeys` array plus default/override assertions:

- `REDIS_URL` → `redisUrl` (default `redis://localhost:6379`).
- `GEOFENCE_EXIT_THRESHOLD_SECONDS` → `geofenceExitThresholdSeconds`
  (`z.coerce.number()`, default `60`).

**Docker** — add a `redis` service to `compose.yaml` and `compose.dev.yaml`
(`redis:7-alpine`, command `redis-server --appendonly yes`, a named volume for AOF
persistence so predefined areas survive restarts), and pass `REDIS_URL` to the
`http` service. (Follow `.claude/skills/create-dockerfile` only if a Dockerfile
itself changes — here it's compose services.)

---

## Use Cases / Scenarios to Support (and test)

Grouped as core enter/exit, multiplicity, robustness, lifecycle, and fan-out
(kept as one numbered list so the cross-references below stay stable).

1. **Enter (core):** location moves from outside → inside an area ⇒ one
   `area.entered`.
2. **Stay inside:** repeated locations inside ⇒ no duplicate enter events.
3. **Brief exit within cushion:** outside for < threshold then back inside ⇒
   **no** exit and **no** re-enter (pending exit silently cancelled).
4. **Confirmed exit:** continuously outside ≥ threshold, next location past the
   cushion ⇒ one `area.exited`.
5. **Cold start:** a user's first-ever location, already inside an area ⇒ enter
   fires (no prior state).
6. **Per-user isolation (multiplicity):** two users at identical coordinates get
   results based only on their own areas; user A's areas never affect user B.
7. **Overlapping areas:** a point inside two areas ⇒ two enter events; leaving one
   but staying in the other ⇒ one exit only.
8. **Boundary:** point exactly at `distance == radius` counts as inside
   (inclusive); just beyond does not.
9. **GPS jitter (robustness):** `stationaryCoordinates` fixture inside an area ⇒
   no spurious enter/exit churn.
10. **Path crossing:** `walkingCoordinates` / `drivingCoordinates` crossing an
    area boundary ⇒ exactly one enter then one exit, in order.
11. **No areas / empty user:** locations for a user with zero areas ⇒ no events,
    no errors.
12. **Sparse updates limitation:** exit is only evaluated on the next location
    after the cushion elapses; if the device stops reporting, the exit is delayed
    (documented; not a bug).
13. **Add / remove area (lifecycle):** add then a location inside ⇒ enter fires;
    remove ⇒ no further events and its inside/pending state is cleaned up.
14. **Radius change:** remove + re-add ⇒ membership recomputed against new radius.
15. **Event fan-out:** each emitted event is **published to Redis Pub/Sub**,
    **persisted to `area_events`**, and **routed to `NotificationSender`**; a
    failure in one sink does not block the others or the location save.

---

## Persistence for event audit (DB sink)

Add an `area_events` table to both stores (mirrors the `transitions` table):

- **SQLite:** new `sqliteTable('area_events', ...)` in
  `@/infrastructure/persistence/schema.ts` + a new `drizzle/000X_*.sql` migration
  (columns: `id`, `type`, `user_id`, `area_id`, `area_name`, `lat`, `lon`, `tst`,
  `created_at`).
- **Postgres:** add the `CREATE TABLE IF NOT EXISTS area_events (...)` to
  `PostgresLocationRepository.migrate()`.
- Implement `saveAreaEvent` in both `SqliteLocationRepository` (sync) and
  `PostgresLocationRepository` (async), consumed by `DbEventPublisher`.

---

## Testing Plan (`bun test`)

**Test utilities** (`@/test/`): add `buildArea()` to `factories.ts`;
`mockAreaRepository()`, `mockGeofenceEvaluator()`, `mockEventPublisher()`,
`mockNotificationSender` (exists) to `mocks.ts`. Reuse `coordinates.ts` fixtures
(`stationaryCoordinates`, `walkingCoordinates`, `drivingCoordinates`) for
path/jitter scenarios.

**Unit tests:**

- `location.handler.test.ts`: with a mock evaluator returning events, asserts each
  event is published; evaluate failure is caught and the location still saves.
- `composite.event-publisher.test.ts`: fan-out reaches all sinks; one throwing sink
  doesn't stop the rest.
- `notification.event-publisher.test.ts`: correct subject/body formatting per event.
- `config.test.ts`: `REDIS_URL` / `GEOFENCE_EXIT_THRESHOLD_SECONDS` defaults +
  overrides.

**Integration tests** (real Redis, guarded by `describe.skipIf(!REDIS_URL)` so CI
without Redis still passes — mirrors the real-infra style of `server.test.ts` which
boots a real SQLite DB): `redis.geofence.test.ts` exercises `RedisAreaRepository` +
`RedisGeofenceEvaluator` against a live Redis, covering use cases 1–14 by adding
areas and feeding coordinate sequences with controlled `tst` values to drive the
cushion timing. `beforeEach` flushes the test keyspace.

---

## Verification (end-to-end)

1. `docker compose -f compose.dev.yaml up -d redis` (or run `redis-server
   --appendonly yes` locally).
2. `bun test` — all unit + (Redis-guarded) integration tests green. Per project
   memory, review any `oxfmt` diffs for corrupted numeric literals in the
   coordinate/area fixtures.
3. Start the server: `bun run <http entrypoint>` with `REDIS_URL` set.
4. Define an area: `POST /areas` with `{ userId: "AB", lat, lon, radius }`.
5. In one terminal, `redis-cli SUBSCRIBE geofence:events` (or the chosen channel).
6. `POST /pub` a `location` (`tid: "AB"`) **inside** the area ⇒ observe an
   `area.entered` on the channel, a row in `area_events`, and a
   `LogNotificationSender` log line.
7. `POST /pub` a location **outside**, then another outside with `tst` ≥ 60s later
   ⇒ observe exactly one `area.exited`. Send an intermediate "back inside" location
   before 60s to confirm the exit is suppressed.
8. Restart Redis and confirm areas persist (AOF), i.e. `GET /areas/AB` still lists
   them.

---

## Out of Scope / Future Work

- **Background exit sweeper** (worker process) to fire exits when a device goes
  silent — deferred per decision #3; the `worker.ts` stub is the natural home.
- **MQTT ingestion** path (stub) — geofencing hooks into `handlePayload`, so it
  will work automatically once MQTT ingestion is implemented.
- **Polygon geofences** — this plan is circular-only, as the issue specifies.
- **Auth on `/pub` and `/areas`** — user identity currently trusts `tid`.

---

## Files Touched (summary)

- **New:** `@/domain/events.ts`; `@/infrastructure/redis/client.ts`;
  `@/repository/area-repository/redis.repository.ts`;
  `@/infrastructure/geofence/{redis.geofence-evaluator.ts, geofence.lua.ts}`;
  `@/infrastructure/events/{redis,db,notification,composite}.event-publisher.ts`;
  `@/infrastructure/notifications/log.notification-sender.ts`; new `drizzle/*.sql`;
  test files listed above.
- **Changed:** `@/domain/{types.ts, schemas.ts, ports.ts}`;
  `@/application/handle-payload.ts`; `@/application/handlers/location.handler.ts`;
  `@/entrypoints/http.ts`; `@/infrastructure/http/server.ts`;
  `@/infrastructure/persistence/schema.ts`;
  `@/repository/location-repository/{sqlite,postgres}.repository.ts`;
  `@/config.ts` (+ `config.test.ts`); `compose.yaml`; `compose.dev.yaml`;
  `@/test/{factories.ts, mocks.ts}`.
