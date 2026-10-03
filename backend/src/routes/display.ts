import { Router, type Request, type Response } from 'express';
import { queryOne } from '../db.js';
import type { ScoreboardRow } from '../types.js';
import { getActiveHlsUrl } from '../direct-stream.js';

export const displayRouter = Router();

displayRouter.get('/:identifier', async (req: Request, res: Response) => {
  try {
    const identifier = req.params.identifier;

    const row = await queryOne<
      ScoreboardRow & { hf_short: 't' | 'b'; youtube_last_broadcast_id: string | null; stream_mode: string }
    >(
      `SELECT *,
        CASE WHEN half = 'bottom' THEN 'b' ELSE 't' END AS hf_short
       FROM scoreboards
       WHERE unique_identifier = $1 AND is_active = true`,
      [identifier]
    );

    if (!row) {
      return res.status(404).json({ error: 'Scoreboard not found' });
    }

    const version = row.state_version;
    const etag = `"${version}"`;

    res.set('ETag', etag);
    res.set('Cache-Control', 'no-cache');

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && matchesEtag(ifNoneMatch, version)) {
      return res.status(304).end();
    }

    // When a YouTube broadcast is live, expose the watch URL + embed URL so
    // the public viewer page can embed the stream. No secrets are leaked —
    // the embed URL is the standard public youtube.com/embed/{videoId}.
    const streamLive = row.stream_status === 'live' || row.stream_status === 'starting';
    const broadcastId = row.youtube_last_broadcast_id;
    // YouTube broadcast id IS the video id. Verified 2026-10-02 via
    // `liveBroadcasts.list part: ['snippet']`: the returned snippet
    // includes `thumbnails.default.url = https://i.ytimg.com/vi/{broadcastId}/...`
    // and `contentDetails.monitorStream.embedHtml` uses the same value in its
    // `embed/{broadcastId}` URL — so the embed can be built directly from
    // the broadcast id with no slicing or replace.
    const videoId = broadcastId;
    const youtubeWatchUrl = streamLive && videoId
      ? `https://www.youtube.com/watch?v=${videoId}`
      : null;
    const youtubeEmbedUrl = streamLive && videoId
      ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1&rel=0`
      : null;

    // When Twitch is the active platform, expose the public Twitch watch URL
    // and the official player.twitch.tv embed URL. The embed is a public
    // iframe (no auth required for non-subscriber-only streams) and is the
    // standard way to embed Twitch in a third-party page. The watch page
    // also appends the parent= query param client-side because Twitch's
    // CSP requires it to match the embedding page's hostname — we leave
    // it out here since the backend can't know the page's host.
    //
    // `twitch_channel_name` is the actual Twitch LOGIN (the lowercase
    // username from twitch.tv/<login>), NOT a display name. The backend
    // normalises and validates the format on save so what we read here is
    // always a valid Twitch login. The watch URL directs to the live
    // section specifically — `/live` is the path Twitch uses for the
    // channel's currently-live stream.
    //
    // We only expose the channel name + URLs when the active platform is
    // twitch. Otherwise twitch_channel_name could leak through /display
    // responses even when the operator isn't streaming to Twitch.
    const isTwitchActive = row.stream_platform === 'twitch';
    const twitchChannel = isTwitchActive ? (row.twitch_channel_name || '').trim() : '';
    const twitchWatchUrl = streamLive && twitchChannel
      ? `https://www.twitch.tv/${twitchChannel}/live`
      : null;
    // Note: parent= is appended client-side (see PublicScoreboard.tsx) so
    // the embed works from any hostname (local dev, Netlify, custom
    // domain, Cloudflare tunnel).
    const twitchEmbedUrl = streamLive && twitchChannel
      ? `https://player.twitch.tv/?channel=${encodeURIComponent(twitchChannel)}&muted=true&autoplay=true`
      : null;

    // Direct HLS URL: only present when in 'direct' mode AND a stream is
    // actually active. The watch page will prefer this over the YouTube
    // embed when present.
    const directHlsUrl = row.stream_mode === 'direct' && streamLive
      ? getActiveHlsUrl(row.id)
      : null;

    const body = JSON.stringify({
      h: row.home_score,
      a: row.away_score,
      i: row.inning,
      hf: row.hf_short,
      b: row.balls,
      s: row.strikes,
      o: row.outs,
      r1: row.runner_on_first ? 1 : 0,
      r2: row.runner_on_second ? 1 : 0,
      r3: row.runner_on_third ? 1 : 0,
      // Batter / pitcher. Empty strings serialized as "" — clients can
      // check truthiness to decide whether to render. Kept short (max 60)
      // so the payload stays under ~250 bytes even with all fields set.
      bn: row.batter_name || '',
      bj: row.batter_number || '',
      pn: row.pitcher_name || '',
      pj: row.pitcher_number || '',
      v: version,
      // Extended fields for the public viewer page. Kept here (instead of a
      // separate endpoint) so a single fetch renders the whole UI.
      home_team: row.home_team_name,
      away_team: row.away_team_name,
      stream: streamLive
        ? {
            status: row.stream_status,
            mode: row.stream_mode || 'youtube',
            // platform lets the viewer pick the right embed block
            platform: row.stream_platform || 'youtube',
            youtubeWatchUrl,
            youtubeEmbedUrl,
            directHlsUrl,
            twitchWatchUrl,
            twitchEmbedUrl,
            twitchChannelName: twitchChannel || null,
            startedAt: row.stream_started_at
              ? new Date(row.stream_started_at).toISOString()
              : null,
          }
        : {
            status: row.stream_status || 'idle',
            mode: row.stream_mode || 'youtube',
            platform: row.stream_platform || 'youtube',
          },
    });

    res.set('Content-Type', 'application/json');
    return res.send(body);
  } catch (err) {
    console.error('GET /display/:identifier error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function matchesEtag(headerValue: string | string[], version: number): boolean {
  const values = Array.isArray(headerValue) ? headerValue : [headerValue];
  const target = String(version);
  const targetQuoted = `"${target}"`;
  for (const v of values) {
    const trimmed = v.trim();
    if (trimmed === '*') return true;
    if (trimmed === target || trimmed === targetQuoted) return true;
    if (trimmed.startsWith('W/')) {
      const rest = trimmed.slice(2).trim();
      if (rest === target || rest === targetQuoted) return true;
    }
  }
  return false;
}
