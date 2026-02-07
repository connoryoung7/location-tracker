# Test Data

Fake OwnTracks HTTP payloads for local testing.

## Usage

Send any payload to the local server with curl:

```bash
curl -X POST http://localhost:3000/owntracks \
  -H "Content-Type: application/json" \
  -d @test-data/location-minimal.json
```

## Files

| File | `_type` | Description |
|---|---|---|
| `location-minimal.json` | `location` | Bare minimum location fields |
| `location-full.json` | `location` | Location with all optional fields populated |
| `location-moving.json` | `location` | Device in motion on mobile data |
| `transition-enter.json` | `transition` | Entering a geofenced region |
| `transition-leave.json` | `transition` | Leaving a geofenced region |
| `waypoint.json` | `waypoint` | A single geofence/waypoint definition |
| `lwt.json` | `lwt` | Last Will and Testament (connection lost) |
| `card.json` | `card` | User identification card |
| `steps.json` | `steps` | Step counter report |
| `beacon.json` | `beacon` | BLE beacon ranging data |
| `status.json` | `status` | Device status and capabilities |
