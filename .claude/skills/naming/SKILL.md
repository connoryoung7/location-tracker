---
name: naming
description: Naming conventions for variables, types, interfaces, and other identifiers. Reference when creating or renaming any identifier.
allowed-tools: Glob, Grep, Read
---

Follow these naming conventions when creating or renaming variables, types, interfaces, classes, files, and other identifiers.

## Types and Interfaces

- **PascalCase** for all type aliases and interfaces: `LocationPayload`, `GeocodingResult`
- **Interfaces** describe capabilities or roles, named as nouns or agent nouns: `Logger`, `EventPublisher`, `Geocoder`, `PayloadDecryptor`, `LocationRepository`
- **Type aliases** for data shapes use a descriptive noun, suffixed by category:
  - `*Payload` — inbound data from an external system: `LocationPayload`, `TransitionPayload`, `WaypointPayload`
  - `*Event` — domain events published internally: `UserWaypointUpdatedEvent`, `DomainEvent`
  - `*Result` — return value from an operation: `GeocodingResult`
- **Union types** that group related types use a collective name: `OwnTracksPayload`, `DomainEvent`
- **Enums** are PascalCase with PascalCase members: `CoordinatePrecision.Building`

### Event Naming

PubSub events should have the following naming: `<subject><verb in past tense>Event`. The following are valid examples:
- `UserCreatedEvent`
- `MessageDeletedEvent`
- `ProfileUpdatedEvent`
- `ProfileViewedEvent`

## Variables and Functions

- **camelCase** for all variables, function names, and parameters: `mockPublish`, `baseUrl`, `encryptionKey`
- **Verb-first** for functions that perform actions: `saveLocation`, `handlePayload`, `reverseGeocode`, `runMigrations`
- **Boolean variables** use `is`/`has`/`should` prefixes: `isInside`
- **Mock/test variables** prefix with `mock`: `mockPublish`, `mockGeocodeResult`

## Classes

- **PascalCase**, named as `[Qualifier][Domain]`: `ConsoleLogger`, `SqliteLocationRepository`, `NominatimGeocoder`, `LibsodiumDecryptor`
- Implementation classes pair a concrete qualifier with the interface name they implement

## Files

- **kebab-case** for all filenames: `handle-payload.ts`, `console.logger.ts`
- **Dot-separated** for specialization: `sqlite.repository.ts`, `nominatim.geocoder.ts`, `libsodium.decryptor.ts`
- **Test files** use `.test.ts` suffix co-located with the source: `server.test.ts`

## Event `_type` Fields

- **Lowercase dot-separated** for event discriminator strings: `'user-waypoint.updated'`
- Pattern: `<entity>.<past-tense-verb>`
