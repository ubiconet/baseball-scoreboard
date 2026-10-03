# Scoreboard API — Client Integration Guide

**Base URL (production):** `https://scoreboard.ubiconet.com`
**Backend port (local dev):** `http://localhost:4020`

All REST endpoints accept and return JSON (`Content-Type: application/json`).
CORS is enabled for all origins.

---

## Table of Contents
1. [Data Schemas](#data-schemas)
2. [REST API — Scoreboard CRUD](#rest-api--scoreboard-crud)
3. [REST API — State Updates](#rest-api--state-updates)
4. [REST API — Display Endpoint (Bandwidth-Optimized)](#rest-api--display-endpoint)
5. [WebSocket Events (Socket.io)](#websocket-events)
6. [Validation Rules](#validation-rules)
7. [Error Handling](#error-handling)

---

## Data Schemas

### Scoreboard (full object — returned by CRUD endpoints)

```json
{
  "id": 1,
  "uniqueIdentifier": "field-1",
  "displayName": "Memorial Field",
  "homeTeamName": "Home",
  "awayTeamName": "Away",
  "homeScore": 3,
  "awayScore": 2,
  "inning": 5,
  "half": "bottom",
  "balls": 2,
  "strikes": 1,
  "outs": 1,
  "gameId": null,
  "stateVersion": 8,
  "isActive": true,
  "createdAt": "2026-07-14T20:00:00.000Z",
  "updatedAt": "2026-07-14T21:30:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Auto-increment primary key (read-only) |
| `uniqueIdentifier` | string | URL-safe slug (letters, numbers, hyphens, underscores). Used in display endpoint URL. Max 100 chars. |
| `displayName` | string | Human-friendly label. Defaults to `""`. |
| `homeTeamName` | string | Home team label. Defaults to `"Home"`. |
| `awayTeamName` | string | Away team label. Defaults to `"Away"`. |
| `homeScore` | number | Home team score. Non-negative integer. |
| `awayScore` | number | Away team score. Non-negative integer. |
| `inning` | number | Current inning. Integer ≥ 1. |
| `half` | `"top"` \| `"bottom"` | Which half of the inning. |
| `balls` | number | Ball count. Integer 0–3. |
| `strikes` | number | Strike count. Integer 0–2. |
| `outs` | number | Out count. Integer 0–2. |
| `gameId` | string \| null | External game identifier (for GameChanger integration). Nullable. |
| `stateVersion` | number | Auto-incremented on every state change. Used for ETag/304 caching. (read-only) |
| `isActive` | boolean | Soft-delete / visibility flag. Defaults to `true`. |
| `createdAt` | string (ISO 8601) | Timestamp. (read-only) |
| `updatedAt` | string (ISO 8601) | Timestamp. Auto-updated via DB trigger. (read-only) |

### Display State (compact — used by display endpoint & WebSocket push)

```json
{
  "h": 3,
  "a": 2,
  "i": 5,
  "hf": "b",
  "b": 2,
  "s": 1,
  "o": 1,
  "v": 8
}
```

| Key | Meaning | Maps to |
|-----|---------|---------|
| `h` | Home score | `homeScore` |
| `a` | Away score | `awayScore` |
| `i` | Inning | `inning` |
| `hf` | Half | `"t"` = top, `"b"` = bottom |
| `b` | Balls | `balls` |
| `s` | Strikes | `strikes` |
| `o` | Outs | `outs` |
| `v` | State version | `stateVersion` |

---

## REST API — Scoreboard CRUD

### Create Scoreboard

```
POST /api/scoreboards
```

**Request body:**
```json
{
  "uniqueIdentifier": "field-1",
  "displayName": "Memorial Field",
  "homeTeamName": "Tigers",
  "awayTeamName": "Eagles"
}
```

Only `uniqueIdentifier` is required. All others are optional with defaults.

**Response:** `201 Created`
```json
{
  "scoreboard": { ... full Scoreboard object ... }
}
```

**Errors:**
- `400` — Missing/invalid `uniqueIdentifier`
- `409` — `uniqueIdentifier` already exists

---

### List Scoreboards

```
GET /api/scoreboards
```

**Response:** `200 OK`
```json
{
  "scoreboards": [
    { ... full Scoreboard object ... },
    ...
  ]
}
```

---

### Get Single Scoreboard

```
GET /api/scoreboards/:id
```

**Path params:**
- `id` — numeric scoreboard ID (e.g. `1`)

**Response:** `200 OK`
```json
{
  "scoreboard": { ... full Scoreboard object ... }
}
```

**Errors:** `404` — Not found

---

### Update Metadata

```
PUT /api/scoreboards/:id
```

Updates any of: `uniqueIdentifier`, `displayName`, `homeTeamName`, `awayTeamName`, `gameId`.
Only included fields are updated (merge-patch semantics). Does **not** increment `stateVersion`.

**Request body (all fields optional):**
```json
{
  "displayName": "Updated Name",
  "homeTeamName": "Lions",
  "gameId": "gc-12345"
}
```

To clear `gameId`, send `"gameId": null`.

**Response:** `200 OK`
```json
{
  "scoreboard": { ... updated full Scoreboard object ... }
}
```

**Errors:** `400` — Validation error, `404` — Not found, `409` — Duplicate `uniqueIdentifier`

---

### Delete Scoreboard

```
DELETE /api/scoreboards/:id
```

**Response:** `200 OK`
```json
{
  "deleted": true,
  "id": 1
}
```

**Errors:** `404` — Not found

---

## REST API — State Updates

### Update State

```
PUT /api/scoreboards/:id/state
```

Updates any of: `homeScore`, `awayScore`, `inning`, `half`, `balls`, `strikes`, `outs`, `gameId`.
Merge-patch semantics — only included fields are updated. **Auto-increments `stateVersion`**.

**Request body (all fields optional):**
```json
{
  "homeScore": 5,
  "awayScore": 3,
  "inning": 6,
  "half": "top",
  "balls": 0,
  "strikes": 0,
  "outs": 1,
  "gameId": "gc-12345"
}
```

**Response:** `200 OK`
```json
{
  "scoreboard": { ... updated full Scoreboard object ... }
}
```

After a successful update, the server broadcasts the new state to all WebSocket clients subscribed to this scoreboard (see [WebSocket Events](#websocket-events)).

**Errors:** `400` — Validation error, `404` — Not found

---

## REST API — Display Endpoint

### Get Display State (bandwidth-optimized)

```
GET /display/:identifier
```

Designed for electronic scoreboard hardware clients to poll. Returns the **compact** payload with single-letter keys. Uses ETag/304 caching to avoid sending response bodies on unchanged state.

**Path params:**
- `identifier` — the scoreboard's `uniqueIdentifier` (e.g. `field-1`)

**Response:** `200 OK`
```json
{
  "h": 3,
  "a": 2,
  "i": 5,
  "hf": "b",
  "b": 2,
  "s": 1,
  "o": 1,
  "v": 8
}
```

**Headers:**
- `ETag: "8"` — quoted state version number
- `Cache-Control: no-cache` — always revalidate

### ETag / 304 Caching

Send the `If-None-Match` header from the last response's `ETag`:

```http
GET /display/field-1
If-None-Match: "8"
```

If the state version hasn't changed, the server responds with:

```
HTTP/1.1 304 Not Modified
```

No response body — zero bytes of payload. The client keeps its last-known state.

Wildcards are also accepted: `If-None-Match: *`

**Errors:** `404` — Scoreboard not found or inactive

---

## WebSocket Events

The server uses **Socket.io** for real-time push. Connect to the same host as the REST API.

**Connection URL:** `https://scoreboard.ubiconet.com` (or `http://localhost:4020` in dev)
**Transports:** `websocket`, `polling` (fallback)

### Client → Server Events

#### `subscribe`
Join a scoreboard's update room. You will only receive updates for boards you subscribe to.

```js
socket.emit('subscribe', 1);  // scoreboardId: number
```

#### `unsubscribe`
Leave a scoreboard's update room.

```js
socket.emit('unsubscribe', 1);
```

#### `state:change`
Push a state change directly through the socket (no REST round trip). The server persists the patch to the database, increments `stateVersion`, and broadcasts the updated state to all **other** clients in the room. The sender does **not** receive an echo back.

```js
socket.emit('state:change', {
  scoreboardId: 1,
  patch: {
    homeScore: 5,
    awayScore: 3,
    inning: 6,
    half: 'top',
    balls: 0,
    strikes: 0,
    outs: 1
  }
});
```

The `patch` uses the same field names and validation rules as `PUT /api/scoreboards/:id/state`. Only include the fields you want to change.

---

### Server → Client Events

#### `state:update`
Broadcast whenever a scoreboard's state changes — whether via REST `PUT /state` or via a socket `state:change` event from another client.

```json
{
  "h": 5,
  "a": 3,
  "i": 6,
  "hf": "t",
  "b": 0,
  "s": 0,
  "o": 1,
  "v": 9
}
```

Same compact shape as the display endpoint.

---

### Recommended Client Patterns

**Operator panel (the web control UI):**
1. Connect socket
2. `emit('subscribe', scoreboardId)`
3. Listen for `state:update` to sync with changes from other operators
4. On user action, `emit('state:change', { scoreboardId, patch })` for instant push

**Electronic display board (hardware):**
1. Connect socket
2. `emit('subscribe', scoreboardId)`
3. Listen for `state:update` and render the new state immediately
4. Alternatively, poll `GET /display/:identifier` with ETag/304 as a fallback

---

## Validation Rules

| Field | Rule |
|-------|------|
| `uniqueIdentifier` | Required. String. 1–100 chars. Pattern: `[a-zA-Z0-9_-]+` |
| `displayName`, `homeTeamName`, `awayTeamName` | Optional. String. Max 200 chars. |
| `homeScore`, `awayScore` | Non-negative integer (≥ 0) |
| `inning` | Integer ≥ 1 |
| `half` | `"top"` or `"bottom"` |
| `balls` | Integer 0–3 |
| `strikes` | Integer 0–2 |
| `outs` | Integer 0–2 |
| `gameId` | String or `null` |

---

## Error Handling

All errors return JSON:

```json
{
  "error": "Human-readable error message"
}
```

| Status | When |
|--------|------|
| `400` | Validation error (missing required field, out-of-range value, invalid format) |
| `404` | Scoreboard not found by `id` or `identifier` |
| `409` | `uniqueIdentifier` already exists (on create or update) |
| `500` | Internal server error |

---

## Health Check

```
GET /health
```

**Response:** `200 OK`
```json
{
  "status": "ok"
}
```

---

*Generated 2026-07-14. API hosted at https://scoreboard.ubiconet.com.*
