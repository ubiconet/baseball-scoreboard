# Feature: GameChanger as a third streaming platform option

## Goal
Add GameChanger (GC) as a streaming destination alongside YouTube and Twitch. GC gives you a **per-event RTMP URL + stream key** (copied from the GC app's "Other Camera → Switch To Insecure Ingest (RTMP)" flow), so unlike Twitch's fixed URL, **both URL and key are user inputs**. Otherwise it must behave exactly like the other platforms: selectable in settings, credentials saved, Start/Stop drives the Pi via the existing `stream:cmd` path.

## How the existing platforms work (follow this pattern precisely)
- `backend/src/types.ts`: `StreamPlatform = 'youtube' | 'twitch'` + `STREAM_INGEST_URLS` record.
- `backend/src/routes/stream.ts`:
  - `VALID_PLATFORMS` (~line 30), `StreamRow` (~line 63, raw DB row type)
  - `buildStatusResponse` / `pickMaskedKey` / platform-ready checks (~87–130): active platform's masked key only
  - `PUT /:id/stream/key` (~184): YouTube legacy key+rtmpUrl
  - `PUT /:id/stream/twitch/key` (~254): Twitch key + channel name — model the GC route on this
  - `PUT /:id/stream/platform` (~357): platform switch, refuses mid-stream
  - `POST /:id/stream/start` (~870): platform-specific key/URL resolution block → emits `stream:cmd {action:'start', streamKey, rtmpUrl, ...}`
  - Every `RETURNING`/SELECT column list includes `stream_*` columns — extend ALL of them with the new GC columns
- `backend/src/state-helpers.ts` (~line 55): `ScoreboardRow` raw type — add columns
- `backend/src/types.ts` `Scoreboard` interface + `mapRowToScoreboard` (~line 120 in types.ts or state-helpers.ts — find it): add `gamechangerStreamKeyMasked?: string` and `gamechangerStreamUrl?: string` (URL is not secret — GC embeds it openly — but keep it out of the masked-key logic)
- `frontend/src/components/StreamSettings.tsx`: `Platform` type (~line 48), platform radio buttons (~line 571 twitch value), per-platform config sections, `twitchConfigured`-style flags (~line 488)
- DB: `schema.sql` CREATE TABLE + new `backend/migrations/005_gamechanger_stream.sql` (I apply migrations manually — do NOT run psql)

## Design

### 1. DB (migration 005 + schema.sql)
```sql
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS gc_stream_url TEXT;
ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS gc_stream_key TEXT;
```
Both nullable. Add to schema.sql CREATE TABLE too. Add COMMENTs explaining the per-event rotation.

### 2. Backend
- `StreamPlatform = 'youtube' | 'twitch' | 'gamechanger'`. Do NOT add GC to `STREAM_INGEST_URLS` — GC has no fixed ingest; remove the need by only using that map for youtube/twitch (verify usages and guard accordingly).
- `StreamRow`/`ScoreboardRow`: `gc_stream_url: string | null; gc_stream_key: string | null;`
- `mapRowToScoreboard`: expose `streamPlatform` as-is; add `gamechangerStreamUrl: row.gc_stream_url ?? null` and `gamechangerStreamKeyMasked: row.gc_stream_key ? maskStreamKey(row.gc_stream_key) : undefined` (always exposed for the settings UI when GC section is open — check how twitch's masked key is gated by active platform in /status; for the settings page we need it regardless of active platform. If the current design only returns active-platform masks, add the GC masked key to the same "both exposed for Settings" pattern the code comment at types.ts mentions).
- New route `PUT /:id/stream/gamechanger/key` (model on the Twitch one): body `{ streamUrl?: string | null, streamKey?: string }`. Validation: `streamUrl` must start with `rtmp://` or `rtmps://` when non-empty; `streamKey` non-empty string ≤512 chars or `''` to clear. Returns `{ success, gamechangerStreamUrl, gamechangerStreamKeyMasked }`. Never echo the raw key.
- `VALID_PLATFORMS` + platform PUT: add `'gamechanger'` (same mid-stream refusal for free).
- `POST /:id/stream/start` resolution block: add branch
  ```ts
  else if (sb.stream_platform === 'gamechanger') {
    if (!sb.gc_stream_url || !sb.gc_stream_url.trim()) throw new Error('No GameChanger RTMP URL configured. Copy it from the GC app (External Camera → Other Camera) into Settings → Live Stream → GameChanger.');
    if (!sb.gc_stream_key) throw new Error('No GameChanger stream key configured. Add one in Settings → Live Stream → GameChanger.');
    streamKey = sb.gc_stream_key;
    rtmpUrl = sb.gc_stream_url.trim();
  }
  ```
  (restructure the if/else so it's youtube / twitch / gamechanger explicitly, no silent fallthrough).
- Platform-ready check (`streamEnabled` logic ~line 99-105): GC ready = url + key both set.
- Extend every SELECT/RETURNING column list that already carries `twitch_stream_key, twitch_channel_name` with `gc_stream_url, gc_stream_key`.

### 3. Frontend — StreamSettings.tsx
- `Platform = 'youtube' | 'twitch' | 'gamechanger'`.
- Third radio button "GameChanger" with the same styling.
- GC config section (visible when platform === 'gamechanger', modeled on the Twitch section):
  - **RTMP URL input** (text) — placeholder like `rtmp://…  (from GC app → External Camera → Other Camera)`. Prefilled from `scoreboard.gamechangerStreamUrl` when non-empty. Saved on the section's Save button.
  - **Stream key input** (password-style, same as Twitch key field) — prefilled empty; masked indicator ("key saved") when `gamechangerStreamKeyMasked` present, matching the Twitch pattern.
  - Save → `PUT /api/scoreboards/:id/stream/gamechanger/key { streamUrl, streamKey }`.
  - Helper text: "URL and key are per-event — copy fresh ones from the GameChanger app before each game."
- `gcConfigured` flag; `activeReady` logic extended; Start button gating follows `streamEnabled` as today.

### 4. Pi
No changes needed — it already consumes `rtmpUrl` + `streamKey` opaquely. (Verify no platform-specific assumptions in `pi/command_listener.py` — there shouldn't be; do not edit if clean.)

## Constraints
- TypeScript strict, no `any`. Python untouched unless a platform assumption exists on the Pi.
- `cd backend && npx tsc --noEmit` — no NEW errors (there are ~6 pre-existing in unrelated files: direct-stream, youtube, gamechanger routes).
- `cd frontend && npm run build` passes.
- Do NOT run git commit; do NOT run psql.

## Deliverables
1. Edits per above
2. Both builds/typecheck pass
3. Summary of files changed + deviations
