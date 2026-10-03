/**
 * YouTube Live Stream Lifecycle
 *
 * Encapsulates the liveBroadcast + liveStream creation/binding flow:
 *
 *   1. Create a liveStream → returns RTMP ingestion URL + streamName (the key)
 *   2. Create a liveBroadcast in 'ready' state, scheduled for now
 *   3. Bind the stream to the broadcast
 *   4. Transition the broadcast to 'live' (YouTube starts accepting RTMP)
 *   5. Pi connects to RTMP URL + streamName, starts streaming
 *
 * On Stop:
 *   1. Transition broadcast to 'complete'
 *   2. Pi disconnects from RTMP (separate, via socket stream:cmd)
 */

import { google } from 'googleapis';
import { queryOne } from './db.js';
import { getAuthenticatedClientForScoreboard } from './routes/youtube.js';
import { GC } from './gamechanger-api-helper.js';

const DEFAULT_TITLE_PREFIX = 'Baseball Live';

/**
 * Build a sensible default title for the YouTube broadcast:
 *   "<homeTeam> (H) vs <awayTeam> (A) — YYYY-MM-DD HH:MM"
 *
 * The (H) / (A) tags clarify which side is officially home vs away in
 * this matchup — useful for viewers who don't know the venues. The
 * "ours" team (GameChanger-auth) is NOT annotated here; that's surfaced
 * in the on-screen overlay underline instead.
 *
 * Time component is the game's scheduled start (from GameChanger when
 * available), otherwise the moment the broadcast was created.
 */
function buildDefaultTitle(
  homeTeam: string,
  awayTeam: string,
  startTs: string | Date | null | undefined
): string {
  const d = startTs ? new Date(startTs) : new Date();
  // Format in local-ish style: YYYY-MM-DD HH:MM (24h, UTC) — YouTube titles
  // don't get parsed for anything, this is purely human-readable.
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `${homeTeam} (H) vs ${awayTeam} (A) — ${date} ${time}`;
}

interface CreatedBroadcast {
  broadcastId: string;
  streamId: string;
  rtmpUrl: string;     // e.g. "rtmp://a.rtmp.youtube.com/live2"
  streamName: string;  // the actual key, appended to rtmpUrl for the full URL
  watchUrl: string;    // e.g. "https://www.youtube.com/watch?v=xxxxxxxxxxx"
}

/**
 * Create a fresh liveStream + liveBroadcast on the scoreboard's connected
 * YouTube channel, bind them, and transition to live. Returns the RTMP
 * credentials the Pi needs to start ffmpeg.
 *
 * Throws on any failure — caller is responsible for surfacing the error to
 * the UI and updating stream_status accordingly.
 */
export async function createBroadcastAndStartStream(
  scoreboardId: number,
  options: { title?: string; description?: string } = {}
): Promise<CreatedBroadcast> {
  const auth = await getAuthenticatedClientForScoreboard(scoreboardId);
  if (!auth) {
    throw new Error(
      'No YouTube account connected for this scoreboard. Connect one in Settings.'
    );
  }
  const youtube = google.youtube({ version: 'v3', auth: auth.oauth2 as any });

  // Read home/away team names + linked game id so we can use the game's
  // scheduled start time in the broadcast title.
  const sb = await queryOne<{
    home_team_name: string;
    away_team_name: string;
    game_id: string | null;
    gc_team_id: string | null;
  }>(
    'SELECT home_team_name, away_team_name, game_id, gc_team_id FROM scoreboards WHERE id = $1',
    [scoreboardId]
  );
  const homeName = sb?.home_team_name || 'Home';
  const awayName = sb?.away_team_name || 'Away';

  // Try to find the game's scheduled start_ts from the GameChanger games list.
  // We only do this if a team is linked AND a game_id is set, so we don't
  // hit the GC API on broadcasts for scoreboards without GC integration.
  let startTs: string | null = null;
  if (sb?.gc_team_id && sb?.game_id) {
    try {
      const games = (await GC.getTeamGames(scoreboardId, sb.gc_team_id)) as Array<{
        id: string;
        start_ts?: string;
      }> | null;
      if (Array.isArray(games)) {
        const match = games.find((g) => g.id === sb.game_id);
        if (match?.start_ts) startTs = match.start_ts;
      }
    } catch (err) {
      console.warn(`[youtube-stream] could not fetch start_ts for title (continuing):`, err);
    }
  }

  const title = options.title || buildDefaultTitle(homeName, awayName, startTs);

  // 1. Create the liveStream — YouTube returns the ingestion URL + stream name.
  //    Using 'cdn' format with HD resolution and 30fps. YouTube assigns the
  //    streamName; we cannot choose it.
  console.log(`[youtube-stream] creating liveStream for scoreboard ${scoreboardId}`);
  const streamRes = await youtube.liveStreams.insert({
    part: ['snippet', 'cdn'],
    requestBody: {
      snippet: {
        title: `${title} (stream)`,
      },
      cdn: {
        frameRate: '30fps',
        ingestionType: 'rtmp',
        resolution: '1080p',
      },
    },
  });

  const streamId = streamRes.data.id;
  const ingestionInfo = streamRes.data.cdn?.ingestionInfo;
  const rtmpUrl = ingestionInfo?.ingestionAddress;
  const streamName = ingestionInfo?.streamName;
  if (!streamId || !rtmpUrl || !streamName) {
    throw new Error('YouTube liveStreams.insert returned no stream ID or RTMP details');
  }

  // 2. Create the liveBroadcast in 'ready' state, scheduled to start now.
  console.log(`[youtube-stream] creating liveBroadcast "${title}"`);
  const broadcastRes = await youtube.liveBroadcasts.insert({
    part: ['snippet', 'status', 'contentDetails'],
    requestBody: {
      snippet: {
        title,
        description: options.description || `Live stream of ${homeName} vs ${awayName}.`,
        scheduledStartTime: new Date().toISOString(),
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
      },
      contentDetails: {
        enableAutoStart: true,   // auto-start when stream begins pushing
        enableAutoStop: true,    // auto-stop when stream goes idle
      },
    },
  });

  const broadcastId = broadcastRes.data.id;
  if (!broadcastId) {
    throw new Error('YouTube liveBroadcasts.insert returned no broadcast ID');
  }

  // 3. Bind the stream to the broadcast.
  console.log(`[youtube-stream] binding stream ${streamId} → broadcast ${broadcastId}`);
  await youtube.liveBroadcasts.bind({
    id: broadcastId,
    part: ['id', 'contentDetails'],
    streamId,
  });

  // 4. Skip the manual transition to 'live' — the broadcast was created
  //    with `enableAutoStart: true`, which means YouTube will transition
  //    it from 'ready' to 'live' automatically as soon as the Pi starts
  //    pushing RTMP to the stream's ingestion URL.
  //
  //    Doing a manual transition here actually fails: YouTube requires
  //    an active video stream to be flowing into the broadcast before it
  //    will accept the 'ready' → 'live' transition. With nothing pushing,
  //    it returns "Invalid transition" (HTTP 403).
  //
  //    We do log the broadcast state so operators can see what's happening
  //    in the backend logs.
  console.log(`[youtube-stream] broadcast ${broadcastId} created in 'ready' state`);
  console.log(`[youtube-stream]   enableAutoStart=true → YouTube will flip to 'live' when Pi pushes RTMP`);

  // 5. Persist broadcast/stream IDs on the scoreboard row for the Stop flow.
  await queryOne(
    `UPDATE scoreboards
     SET youtube_last_broadcast_id = $2,
         youtube_last_stream_id    = $3,
         stream_key                = $4,
         stream_rtmp_url           = $5,
         stream_status             = 'starting',
         stream_last_error         = NULL,
         stream_started_at         = NULL
     WHERE id = $1`,
    [scoreboardId, broadcastId, streamId, streamName, rtmpUrl]
  );

  // Build the YouTube watch URL — broadcast id is already a video id
  // (verified 2026-10-02: the broadcast snippet returns
  // `thumbnails.default.url = https://i.ytimg.com/vi/{broadcastId}/default_live.jpg`
  // and `monitorStream.embedHtml` embeds `{broadcastId}` directly, both
  // confirming broadcast id IS the video id). Use it verbatim.
  const watchUrl = `https://www.youtube.com/watch?v=${broadcastId}`;

  return {
    broadcastId,
    streamId,
    rtmpUrl,
    streamName,
    watchUrl,
  };
}

/**
 * End the active broadcast for a scoreboard. Best-effort — if YouTube returns
 * an error (e.g. broadcast already ended), we still clear local state so
 * the UI shows 'idle'.
 */
export async function endBroadcast(scoreboardId: number): Promise<void> {
  const row = await queryOne<{ youtube_last_broadcast_id: string | null }>(
    'SELECT youtube_last_broadcast_id FROM scoreboards WHERE id = $1',
    [scoreboardId]
  );
  const broadcastId = row?.youtube_last_broadcast_id;
  if (!broadcastId) {
    // No active broadcast — nothing to do on YouTube side, but still clear state
    await queryOne(
      `UPDATE scoreboards
       SET stream_status = 'idle',
           stream_key = NULL,
           stream_rtmp_url = NULL,
           youtube_last_broadcast_id = NULL,
           youtube_last_stream_id = NULL,
           stream_started_at = NULL
       WHERE id = $1`,
      [scoreboardId]
    );
    return;
  }

  const auth = await getAuthenticatedClientForScoreboard(scoreboardId);
  if (auth) {
    try {
      const youtube = google.youtube({ version: 'v3', auth: auth.oauth2 as any });
      // Check current status first — YouTube won't let us transition from
      // 'ready' directly to 'complete' (only allowed: ready→live, live→complete).
      // If the broadcast never made it to 'live' (Pi never pushed RTMP, or
      // stream failed), the broadcast is still in 'ready' state. We can leave
      // it there — it'll auto-expire — and just clear local state.
      const broadcastInfo = await youtube.liveBroadcasts.list({
        id: [broadcastId],
        part: ['id', 'status'],
      });
      const currentStatus = broadcastInfo.data.items?.[0]?.status?.lifeCycleStatus;
      if (currentStatus === 'live') {
        console.log(`[youtube-stream] transitioning broadcast ${broadcastId} → complete`);
        await youtube.liveBroadcasts.transition({
          id: broadcastId,
          part: ['id', 'status'],
          broadcastStatus: 'complete',
        });
      } else {
        // Broadcast never went live (Pi didn't push RTMP, or was rejected).
        // YouTube requires ready→live→complete, and we can't skip live.
        // Just leave the broadcast in its current state — it'll be cleaned up
        // by YouTube's normal lifecycle.
        console.log(
          `[youtube-stream] broadcast ${broadcastId} never went live (status=${currentStatus}); skipping transition`
        );
        // Try to delete it instead — this works for 'ready' state broadcasts
        // and prevents accumulation of stale "ready" broadcasts in the channel.
        try {
          await youtube.liveBroadcasts.delete({ id: broadcastId });
          console.log(`[youtube-stream] deleted stale 'ready' broadcast ${broadcastId}`);
        } catch (delErr) {
          console.warn(`[youtube-stream] could not delete broadcast ${broadcastId}:`, delErr);
        }
      }
    } catch (err) {
      console.warn(`[youtube-stream] failed to transition broadcast ${broadcastId}:`, err);
      // Continue — we still want to clear local state
    }
  }

  await queryOne(
    `UPDATE scoreboards
     SET stream_status = 'idle',
         stream_key = NULL,
         stream_rtmp_url = NULL,
         youtube_last_broadcast_id = NULL,
         youtube_last_stream_id = NULL,
         stream_started_at = NULL
     WHERE id = $1`,
    [scoreboardId]
  );
}