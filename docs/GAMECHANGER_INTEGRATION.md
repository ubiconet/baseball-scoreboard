# GameChanger Integration — How It Works

This document describes how the scoreboard backend at `/Users/skuzmak/projects/scoreboard/`
integrates with GameChanger (gc.com) to pull live game data into the scoreboard display.

**There is no official GameChanger API.** Everything below is reverse-engineered from the
web app at `web.gc.com`. The signing credentials ship in the JS bundle as
`EDEN_AUTH_CLIENT_KEY` and are static.

> Source-of-truth companion: `backend/src/gamechanger-session.ts` (Selenium + token capture),
> `backend/src/gamechanger-api-helper.ts` (HMAC signing + REST), `backend/src/gamechanger-poller.ts`
> (live polling + change detection), `backend/src/routes/gamechanger.ts` (HTTP layer).

---

## TL;DR Architecture

```
scoreboard backend (Node/TS)                    GameChanger (api.team-manager.gc.com)
─────────────────────────                       ───────────────────────────────────
                                                ┌─ Selenium (headless Chrome) ──┐
GameChangerSession.init()  ─── one-time ───▶   web.gc.com/login → capture tokens  │
                            login + 2FA        └─────────────────────────────────┘
GameChangerAPIHelper                                 │
   └─ GC class                                     │
       ├─ request()  ───── HMAC-signed POST /auth ──▶  refresh token + JWT
       ├─ getTeamGames(teamId)
       ├─ getGameDetails(gameId)
       └─ getPlayByPlay(gameId)

GameChangerPoller (per-scoreboard scheduler)
   ├─ tick()  ─ every 2s when live, 30s idle ──▶  API calls (with change-detection)
   ├─ derive live state (inning/half/outs/balls/strikes)
   └─ push to clients via Socket.IO
```

---

## 1. Auth Architecture (Hybrid: Selenium → REST)

### Why two phases?
Selenium opens a real browser to handle **interactive login + 2FA** (email verification codes,
CAPTCHAs, fingerprinting evasion). Once tokens are captured, Selenium is closed and **all
subsequent calls are direct HTTPS** with HMAC-signed headers. This avoids running a browser
24/7 for live polling.

### Phase 1: Selenium (one-time per login)

1. Launch headless Chrome → `web.gc.com/login`
2. Enter email, click continue, enter password, submit
3. If 2FA required → email code → user supplies via UI → session stays open in memory
4. JS network interceptor hooks `window.fetch` + `XMLHttpRequest`, capturing
   `api.team-manager.gc.com/auth` responses where `data.type === 'token'` →
   stores as `window.__gcAuthResponse`
5. After login success, read captured response:
   - `access.data` → JWT access token (short-lived)
   - `refresh.data` → refresh token (long-lived)
   - Decode JWT payload → extract `cid` field → **clientId**
6. Generate **deviceId** (consistent per-user): `md5(email + machineInfo + 'gamechanger')`
7. Persist to DB: `authToken`, `refreshToken`, `clientId`, `deviceId`

### Phase 2: REST + HMAC (ongoing)

Every authenticated call uses the JWT access token. When it expires (typically 30-60 min),
a signed refresh call rotates both tokens.

### Signing Credentials (static)

```typescript
GC_AUTH_SIGNING_CLIENT_ID  = '86fdf441-602b-49dc-9c67-f603a07b2fbf'
GC_AUTH_SIGNING_CLIENT_KEY = 'QWzgAOSZ1vTCmkL033jTvC1zSHoj4jNfDhfmTnJ/t8c='
```

Both overridable via env. Key is base64-decoded before use.

---

## 2. HMAC Request Signing

**Every `/auth` call** (login AND refresh) must be signed. Data API calls only need the
`Gc-Token` header.

### Signing algorithm

```typescript
const timestamp = Math.floor(Date.now() / 1000);
const nonce = crypto.randomBytes(32).toString('base64');
const values = valuesForSigner(payload);  // recursive flatten, keys sorted alpha

const key = Buffer.from(GC_AUTH_SIGNING_CLIENT_KEY, 'base64');
const hmac = crypto.createHmac('sha256', key);
hmac.update(Buffer.from(`${timestamp}|`, 'utf8'));
hmac.update(Buffer.from(nonce, 'base64'));      // raw nonce bytes
hmac.update(Buffer.from('|', 'utf8'));
hmac.update(Buffer.from(values.join('|'), 'utf8'));
const signature = hmac.digest('base64');
// gc-signature header = `${nonce}.${signature}`
```

### Required headers

| Header | Auth endpoint | Data endpoint |
|---|---|---|
| `Gc-App-Name` | `web` | `web` |
| `Gc-App-Version` | `0.0.0` | — |
| `Gc-Client-Id` | signing client id | optional |
| `Gc-Device-Id` | per-user device id | required |
| `Gc-Timestamp` | unix seconds | — |
| `Gc-Signature` | `${nonce}.${sig}` | — |
| `Gc-Token` | refresh token (for refresh) | access JWT |

### Token refresh

```
POST https://api.team-manager.gc.com/auth
Body: { type: 'refresh' }
Headers: signed + Gc-Token = current refresh token
```

Response: `{ access: { data: <new JWT> }, refresh: { data: <new refresh token> } }`
(token rotation — both tokens change on every refresh).

**Concurrency lock**: per-tenancy promise map prevents refresh storms. On 401 from refresh →
clear tokens, require re-login.

---

## 3. Data API Endpoints

Base URL: `https://api.team-manager.gc.com`. Headers: `Gc-App-Name: web`, `Gc-Device-Id`,
`Gc-Token`, optional `Gc-Client-Id`.

| Purpose | Endpoint | Notes |
|---|---|---|
| Team search | `POST /search` body `{ name }` | Fuzzy match; returns `hits[]` |
| Team details | `GET /public/teams/:teamId` | Use `public_id` (12 chars), NOT internal UUID |
| Team games | `GET /public/teams/:teamId/games` | All games; filter for `status=live` |
| Game details | `GET /public/game-stream-processing/:gameId/details?include=line_scores` | Authoritative score |
| Box score | `GET /game-stream-processing/:gameId/boxscore` | |
| Play-by-play | `GET /game-stream-processing/:gameId/plays` | Live state source |

**`makeRequest` retry pattern**: on 401 → refresh → retry once (`retryOnAuthFailure=false`).
On second 401 → give up, surface to operator.

---

## 4. Team Matching — Critical Pitfall

### Use `public_id`, NOT internal `id`

The `/search` endpoint returns hits with two distinct IDs:

- **`id`** — internal UUID (36 chars with dashes), e.g. `fba6759a-0b99-459a-89bf-21d7fa672aa7`
- **`public_id`** — 12-char slug, e.g. `ZLe1kKMTDH4y` — **THIS is what goes in URL paths**

```
GET .../public/teams/<public_id>/games    → 200, real games
GET .../public/teams/<internal_uuid>/games → 400 Bad Request
```

**Symptom of storing the wrong id**: `gc_last_error = "GameChanger API request failed: 400
body=Bad Request"`. The poller keeps retryling every 2s and the scoreboard never updates.
Token-refresh is NOT triggered (400 ≠ 401).

**Fix**: `UPDATE scoreboards SET gc_team_id = '<public_id>' WHERE id = N;`

### Search is fuzzy

Even fully-qualified queries like `"Ontario Blue Jays 14U MINOR"` return 7+ matches spanning
multiple seasons (summer 2026, fall 2024, spring 2025, etc.). The picker UI is the primary
path — auto-link rarely hits.

### Link-by-name endpoint

```
POST /api/scoreboards/:id/gc/link-team-by-name  body: { teamName: string }
```

Returns one of:
- `{ matched: true, teamId, teamName, season, location, players }` — auto-linked
- `{ matched: 'multiple', query, teams: [...] }` — show picker
- `{ matched: false, query }` — no hits

---

## 5. Live Game Polling — The Hard Part

### Why naive polling is too slow

3 sequential API calls every N seconds:
- Each GC call adds 300-800ms latency
- Games list returns all 48 games for an active season every poll — wasted bandwidth

### The optimization pattern (reduces 3 calls/tick → 1 call/tick idle)

**1. Cache the live game ID in memory.** The games-list endpoint is only needed to *find*
the live game once. Cache its ID. Refresh every 5 min when live, every 30s when idle.

**2. Hash the last play's fields, not just `plays.length`.** GameChanger updates the last
play's `at_plate_details` *in place* when a new pitch is thrown — plays count doesn't change.
Hash `${plays.length}:${inning}:${half}:${outs}:${JSON.stringify(at_plate_details)}` and
compare against last poll.

**3. Short-circuit when nothing changed.** If hash matches, skip the details fetch entirely
and just refresh `last_sync`.

**4. Adaptive polling intervals via `setTimeout` (not `setInterval`) and reschedule after
each tick:**

```typescript
const POLL_LIVE_MS = 2_000;       // active game
const POLL_IDLE_MS = 30_000;      // no live game

function scheduleNextTick(delayMs: number) {
  if (pollerTimer) clearTimeout(pollerTimer);
  pollerTimer = setTimeout(async () => {
    await tick();
    const anyLive = Array.from(gameCache.values()).some(c => c.lastGameStatus === 'live');
    scheduleNextTick(anyLive ? POLL_LIVE_MS : POLL_IDLE_MS);
  }, delayMs);
}
```

**5. Detect game-end via last play's `name_template`.** Strings like `"Game over"`,
`"Final"`, `"end of game"` indicate completion. Flip cache to `'completed'` immediately
so the next tick uses the idle interval.

**6. Two-tier game-ID refresh window.** Don't use one fixed value. When live, refresh the
games list every 5 min (saves calls). When idle, refresh every 30s (so new live games
appear quickly).

**7. Push to clients only when derived state changes.** Compare home/away/inning/half/
balls/strikes/outs against last-known. No change → no DB write, no socket emit.

**8. "New live game appeared" must signal immediate interval switch.** When poller is in
idle mode and a live game starts, the scheduler must NOT wait for the cache-stale window.
`syncOne()` returns a boolean: "live game just appeared" → scheduler jumps to `POLL_LIVE_MS`.

### API call volume per scoreboard

| State | Calls/min |
|---|---|
| Idle (no live game) | ~2 (games-list every 5 min + plays every 30s) |
| Live, no activity | ~30 (plays every 2s) |
| Live, active pitching | 35-40 (plays + occasional details) |

---

## 6. Deriving Live State — Field Semantics

GameChanger creates a **placeholder play** for the current at-bat with `outs:0` (and
`home_score:0, away_score:0`) the instant a new batter steps up — BEFORE the at-bat resolves.
This means **direct field reads on the last play are unreliable**.

### Out count — the gotcha

`lastPlay.outs` is always 0 mid-at-bat. Instead: scan all plays matching the current
inning+half and take `max(plays[*].outs)`.

### Running score — the gotcha

`lastPlay.home_score` / `lastPlay.away_score` are sometimes 0/0 mid-game. Use
`details.score.team` / `details.score.opponent_team` from the details endpoint for the
authoritative running score.

### Balls/strikes — derive by replaying pitches

Scan `lastPlay.at_plate_details` sequentially:
- `"Ball N"` → balls += 1
- `"Strike N looking/swinging"` → strikes += 1
- `"Foul"` → strikes += 1 **only if strikes < 2** (foul at 2 strikes is no-op)
- Cap at 3 balls / 2 strikes
- Empty `at_plate_details: []` with `name_template: "${playerId} at bat"` → new batter,
  naturally yields 0-0

**CRITICAL: do NOT reset to 0-0 on terminal events** (`"In play"`, `"Strike 3"`, `"Ball 4"`).
GameChanger creates a new play with empty `at_plate_details` for the next batter, which
naturally yields 0-0. An extra reset hides the real final count during the gap between
at-bat completion and the next play record appearing.

---

## 7. The 19-60 Second API Publishing Delay

**GameChanger's REST API takes 19–60 seconds after a real pitch before it publishes the
play.** Measured directly during live-game polling (2026-07-18 session): three consecutive
pitches showed publication gaps of **19 seconds, then 60 seconds**.

This isn't a polling interval issue or network issue on our side — it's the upstream data
source's latency. The scoreboard backend reacts within 2 seconds of GC publishing.

**Implications:**

- **No amount of backend optimization reduces perceived lag below the GC publish gap.**
  Run a parallel direct GC API watch alongside the scoreboard's push stream — if the direct
  watch shows the same lag, you've proven it's not us.
- **Don't promise "instant" sync.** The right presentation is "near-live". A
  `Last sync: X seconds ago` indicator sets user expectations correctly.

---

## 8. Token Refresh Pitfalls

### Refresh token expires silently

After long idle periods (overnight, weeks of no live games), the refresh token can be
invalidated server-side. Symptom: every API call returns 401 even though `gc_status='connected'`.

Don't debug HMAC signing — just clear tokens and re-login. The status endpoint surfaces
this as `lastError='GameChanger API request failed: '` (empty message — the tell).

### Empty `statusText` — preserve status code + parsed body

A 400 response from `api.team-manager.gc.com` typically comes back with `statusText: ''`
(no human-readable text). If your error throw is
`throw new Error(\`GameChanger API request failed: ${response.statusText}\`)`,
the operator sees an empty message.

```typescript
class GameChangerAPIError extends Error {
  statusCode?: number;
  statusText: string;
  detail?: string;
  constructor(message: string, opts: { statusCode?: number; statusText: string; body?: string }) {
    super(message);
    this.statusCode = opts.statusCode;
    this.statusText = opts.statusText;
    this.detail = opts.body ? parseErrorBody(opts.body) : undefined;
  }
}

function parseErrorBody(body: string): string {
  try {
    const json = JSON.parse(body);
    if (json.error?.message) return `${json.error.message}${json.error.code ? ` (code: ${json.error.code})` : ''}`;
    if (json.message) return json.message;
    if (typeof json.error === 'string') return json.error;
    return body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}
```

New format: `GameChanger API request failed: 400  body=Bad Request` — operator sees HTTP
status immediately.

---

## 9. Route Layer (`backend/src/routes/gamechanger.ts`)

This is the only file that interacts with the Selenium-based `GameChangerSession` class.
Common bugs to avoid:

### Bug: `new GameChangerSession()` with no args
Constructor accesses `credentials.email` to build deviceId — crashes with
`TypeError: Cannot read properties of undefined (reading 'email')`. Always:
```js
const session = new GameChangerSession({ email, password });
await session.init();
```

### Bug: checking `session.requires2FA` after `login()`
`login()` **throws** a `VERIFICATION_CODE_REQUIRED` error — it does NOT return cleanly with
`requires2FA = true`. Right pattern:
```js
try { await session.login(); }
catch (err) {
  if (err.name === 'VERIFICATION_CODE_REQUIRED') { needs2FA = true; }
  else { throw err; }
}
if (needs2FA) { /* prompt for code, then session.continue2FA() */ }
```

### Bug: calling non-existent methods
`session.launch()`, `session.captureAuth()`, `session.submit2FA()` don't exist.
Real methods: `init()`, `getAuth()`, `continue2FA()`. Always grep the class file before
naming methods in route code.

### Bug: column references to fields not in the schema
A handful of SQL statements reference `gc_token_updated_at` which is NOT in the
`scoreboards` schema. Symptom: 500 "column does not exist" on login complete.

### Bug: `auth.accessToken` instead of `auth.authToken`
`getAuth()` returns `{ authToken, refreshToken, clientId, deviceId }`. If you destructure
as `accessToken`, the UPDATE writes `NULL` to `gc_auth_token` — everything else persists
but `loadCredentials()` throws `'GameChanger credentials not configured'`. Symptom: login +
verify all "succeed," DB row has refresh/clientId/deviceId but no auth_token.

### Bug: missing `connected` field in `/gc/status` response
Frontend `GCStatus` interface requires `connected: boolean` and gates multiple controls
(Live Polling toggle, Change Team button) on it. If a refactor forgets to include
`connected`, those controls vanish without an error. Always `curl /api/scoreboards/:id/gc/status`
after touching the status route.

### Routes exposed

```
POST   /api/scoreboards/:id/gc/configure       — enable + save creds + team name
POST   /api/scoreboards/:id/gc/login           — start Selenium login (may require 2FA)
POST   /api/scoreboards/:id/gc/verify          — submit 2FA code to complete login
GET    /api/scoreboards/:id/gc/status          — connection status
POST   /api/scoreboards/:id/gc/search-team     — search teams by name (post-login)
POST   /api/scoreboards/:id/gc/link-team       — link a team to this scoreboard
POST   /api/scoreboards/:id/gc/refresh-game    — re-fetch games list & pick live/most-recent
POST   /api/scoreboards/:id/gc/toggle-polling  — pause/resume live polling
POST   /api/scoreboards/:id/gc/disable         — disable GC sync + clear tokens
GET    /api/scoreboards/:id/gc/diagnostics     — rolling 20-sample buffer (set GC_DIAG=1)
```

Active Selenium sessions (for 2FA continuation) are held in-memory keyed by scoreboard ID,
TTL 10 min.

---

## 10. Diagnosing Latency

The poller exposes a rolling 20-sample buffer at `/api/scoreboards/:id/gc/diagnostics`.
Sample fields: `{ startedAt, durationMs, outcome, steps: { gamesListMs, pbpFetchMs,
detailsFetchMs, dbUpdateMs, emitMs }, apiCalls: [{url, durationMs, status}], error }`.

Set `GC_DIAG=1` for verbose per-step logging, `GC_QUERY_LOG=1` to log every pg query
(with slow-query warnings at >100ms).

**When the user reports "sometimes fast, sometimes a minute late," this endpoint is the
first thing to curl.** It tells you whether the bottleneck is:
- GC API → high `pbpFetchMs`
- DB write → high `dbUpdateMs`
- Network → high `gamesListMs`

The pg pool also exposes `activeQueries`, `maxConcurrent`, `slowQueries`, `poolWaiting`
to spot connection-pool contention.

---

## 11. Reference Implementation

The same reverse-engineering was originally captured in Steve's BaseballScout repo
(github.com/skuzmak/BaseballScout, private):
- `server/gamechanger-session.ts` — Selenium login, 2FA, token capture
- `server/gamechanger-api-helper.ts` — HMAC signing, token refresh, API client
- `server/gamechanger-api.ts` — Express routes

The scoreboard project's `backend/src/gamechanger-*.ts` files are the production version
with the polling optimization pattern, diagnostics, and route handler fixes described above.

---

## Appendix: Why This Exists At All

GameChanger's web app uses internal APIs that change without notice. The signing credentials
ship in the JS bundle (not secret in any meaningful sense) — anyone with dev tools can extract
them. This integration will break when GameChanger rotates the signing key, changes the
payload format, or implements proper API auth. When that happens:

1. Re-extract the signing key from the current bundle (`grep -r EDEN_AUTH_CLIENT_KEY web.gc.com`)
2. Update the constants in `gamechanger-api-helper.ts`
3. Re-test login + token refresh against a test account
4. Update this doc with the new values

Estimated effort on a key rotation: 1-2 hours including test coverage.
