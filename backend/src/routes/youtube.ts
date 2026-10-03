/**
 * YouTube OAuth routes — per-scoreboard Google account linking.
 *
 * Flow:
 *   1. User clicks "Connect YouTube Account" in scoreboard Settings
 *   2. Frontend GETs /api/auth/youtube/start?scoreboardId=N
 *   3. Backend sets a short-lived HMAC-signed cookie containing {scoreboardId,
 *      nonce, exp} and redirects browser to Google's consent screen
 *   4. User authorizes the app on Google's side
 *   5. Google redirects back to /api/auth/youtube/callback?code=...&state=...
 *   6. Backend verifies the cookie, exchanges the code for tokens via the
 *      googleapis SDK, fetches the channel info, stores tokens on the
 *      scoreboard row, and redirects the browser back to the scoreboard
 *      settings page in the SPA.
 *
 * After this, every Start creates a fresh liveBroadcast + liveStream on
 * that channel and rotates the stream_key column.
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { queryOne } from '../db.js';
import dotenv from 'dotenv';

dotenv.config();

export const youtubeAuthRouter = Router();
export const youtubeApiRouter = Router();

// ── Configuration ────────────────────────────────────────────────────────

function getOAuthConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'YouTube OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID, ' +
        'GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI in .env'
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/** Cookie name for the OAuth state (which scoreboard is being linked). */
const STATE_COOKIE = 'yt_oauth_state';

/** HMAC secret used to sign the state cookie. Falls back to a derived key
 *  from the client secret if SESSION_SECRET is not set. */
function getStateSecret(): string {
  return (
    process.env.SESSION_SECRET ||
    crypto.createHash('sha256').update(getOAuthConfig().clientSecret).digest('hex')
  );
}

/** Sign a payload object into a base64url string. */
function signState(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString('base64url');
  const sig = crypto.createHmac('sha256', getStateSecret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

/** Verify and parse a signed state. Returns null if tampered or expired. */
function verifyState(signed: string): Record<string, unknown> | null {
  const parts = signed.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', getStateSecret()).update(b64).digest('base64url');
  // Constant-time comparison to prevent timing attacks
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number' && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function buildOAuthClient(): OAuth2Client {
  const cfg = getOAuthConfig();
  return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

// ── /api/auth/youtube/start ──────────────────────────────────────────────
// Initiates OAuth by redirecting the browser to Google.

youtubeAuthRouter.get('/youtube/start', (req: Request, res: Response) => {
  try {
    const scoreboardId = Number(req.query.scoreboardId);
    if (!Number.isInteger(scoreboardId) || scoreboardId <= 0) {
      return res.status(400).send('Invalid or missing scoreboardId query parameter');
    }

    const oauth2 = buildOAuthClient();
    // 10-minute expiry on the state cookie — plenty of time for the user to
    // complete the OAuth flow, but short enough that an abandoned tab expires.
    const state = signState({
      scoreboardId,
      nonce: crypto.randomBytes(16).toString('hex'),
      exp: Date.now() + 10 * 60 * 1000,
    });

    const url = oauth2.generateAuthUrl({
      access_type: 'offline',            // request a refresh_token
      prompt: 'consent',                  // force re-consent so we always get a refresh token
      include_granted_scopes: true,
      scope: [
        'https://www.googleapis.com/auth/youtube.force-ssl',
      ],
      state,
    });

    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',     // allows the redirect from Google to carry it
      secure: process.env.NODE_ENV === 'production',
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(url);
  } catch (err) {
    console.error('[youtube-auth] start error:', err);
    res.status(500).send('OAuth configuration error. Check backend logs.');
  }
});

// ── /api/auth/youtube/callback ──────────────────────────────────────────
// Handles Google's redirect back to us after the user authorizes.

youtubeAuthRouter.get('/youtube/callback', async (req: Request, res: Response) => {
  try {
    // Prefer the cookie (set on /start) over query state — the cookie was
    // httpOnly + sameSite=lax so it's harder to forge via URL injection.
    const cookieState = (req as Request & { cookies?: Record<string, string> }).cookies?.[STATE_COOKIE];
    const queryState = typeof req.query.state === 'string' ? req.query.state : undefined;
    const state = cookieState || queryState;

    if (!state) {
      return res.status(400).send('Missing OAuth state. Please restart the connect flow.');
    }
    const payload = verifyState(state);
    if (!payload) {
      return res.status(400).send('OAuth state expired or invalid. Please restart the connect flow.');
    }
    const scoreboardId = Number(payload.scoreboardId);
    if (!Number.isInteger(scoreboardId) || scoreboardId <= 0) {
      return res.status(400).send('Invalid scoreboard in OAuth state.');
    }

    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    if (!code) {
      return res.status(400).send('Missing authorization code from Google.');
    }

    const oauth2 = buildOAuthClient();
    const { tokens } = await oauth2.getToken(code);

    if (!tokens.refresh_token) {
      // Sometimes Google doesn't return a refresh token if the user has
      // previously granted this app access. In that case we need them to
      // revoke and re-authorize. Send a helpful error.
      return res
        .status(400)
        .send(
          'Google did not return a refresh token. ' +
            'Please revoke access at https://myaccount.google.com/permissions and try again.'
        );
    }

    // Set credentials and fetch the user's channel info
    oauth2.setCredentials(tokens);
    // The googleapis SDK bundles its own copy of google-auth-library, so its
    // OAuth2Client type is nominally distinct from the one we imported. At
    // runtime they're identical; `as any` keeps the TS noise down.
    const youtube = google.youtube({ version: 'v3', auth: oauth2 as any });

    const channelRes = await youtube.channels.list({
      part: ['snippet'],
      mine: true,
    });

    const channel = channelRes.data.items?.[0];
    if (!channel?.id) {
      return res
        .status(400)
        .send('No YouTube channel found for this Google account. Create one at youtube.com first.');
    }

    // Persist tokens + channel info on the scoreboard row
    const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
    await queryOne(
      `UPDATE scoreboards
       SET youtube_access_token      = $2,
           youtube_refresh_token     = $3,
           youtube_token_expires_at  = $4,
           youtube_channel_id        = $5,
           youtube_channel_title     = $6,
           youtube_connected_email   = $7,
           stream_enabled            = true
       WHERE id = $1`,
      [
        scoreboardId,
        tokens.access_token || null,
        tokens.refresh_token,
        expiresAt,
        channel.id,
        channel.snippet?.title || null,
        channel.snippet?.customUrl || null, // best-effort; may be null
      ]
    );

    // Also fetch the user's primary email via userinfo (optional)
    try {
      const oauth2User = google.oauth2({ version: 'v2', auth: oauth2 as any });
      const userInfo = await oauth2User.userinfo.get();
      const email = userInfo.data.email;
      if (email) {
        await queryOne('UPDATE scoreboards SET youtube_connected_email = $2 WHERE id = $1', [
          scoreboardId,
          email,
        ]);
      }
    } catch (e) {
      // Non-fatal — channel title is enough for the UI
    }

    // Clear the state cookie and bounce the browser back to the SPA settings page
    res.clearCookie(STATE_COOKIE);
    res.redirect(`/?scoreboardId=${scoreboardId}&tab=settings&youtube=connected`);
  } catch (err) {
    console.error('[youtube-auth] callback error:', err);
    res.status(500).send('Failed to complete YouTube OAuth. Check backend logs.');
  }
});

// ── /api/scoreboards/:id/youtube/status ─────────────────────────────────
// Returns whether the scoreboard has a connected YouTube account.

youtubeApiRouter.get('/:id/youtube/status', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid scoreboard id' });
    }

    const row = await queryOne<{
      youtube_channel_id: string | null;
      youtube_channel_title: string | null;
      youtube_connected_email: string | null;
      youtube_token_expires_at: Date | null;
    }>(
      `SELECT youtube_channel_id, youtube_channel_title, youtube_connected_email,
              youtube_token_expires_at
       FROM scoreboards WHERE id = $1`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Scoreboard not found' });

    const connected = !!row.youtube_channel_id;
    const expiresAt =
      row.youtube_token_expires_at instanceof Date
        ? row.youtube_token_expires_at.toISOString()
        : row.youtube_token_expires_at
          ? String(row.youtube_token_expires_at)
          : null;

    res.json({
      connected,
      channelId: row.youtube_channel_id,
      channelTitle: row.youtube_channel_title,
      email: row.youtube_connected_email,
      tokenExpiresAt: expiresAt,
    });
  } catch (err) {
    console.error('[youtube-api] status error:', err);
    res.status(500).json({ error: 'Failed to get YouTube status' });
  }
});

// ── DELETE /api/scoreboards/:id/youtube/disconnect ──────────────────────
// Clears YouTube tokens from the scoreboard row.

youtubeApiRouter.delete('/:id/youtube/disconnect', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid scoreboard id' });
    }

    // Optionally revoke the token at Google. Best-effort — if it fails we
    // still clear our local copy.
    const row = await queryOne<{ youtube_access_token: string | null }>(
      'SELECT youtube_access_token FROM scoreboards WHERE id = $1',
      [id]
    );

    if (row?.youtube_access_token) {
      try {
        const oauth2 = buildOAuthClient();
        oauth2.setCredentials({ access_token: row.youtube_access_token });
        await oauth2.revokeToken(row.youtube_access_token);
      } catch (e) {
        console.warn('[youtube-api] revoke failed (continuing):', e);
      }
    }

    await queryOne(
      `UPDATE scoreboards
       SET youtube_access_token      = NULL,
           youtube_refresh_token     = NULL,
           youtube_token_expires_at  = NULL,
           youtube_channel_id        = NULL,
           youtube_channel_title     = NULL,
           youtube_connected_email   = NULL,
           youtube_last_broadcast_id = NULL,
           youtube_last_stream_id    = NULL,
           stream_enabled            = false
       WHERE id = $1`,
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[youtube-api] disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect YouTube account' });
  }
});

// ── Helpers exposed for stream.ts ────────────────────────────────────────

/**
 * Build an authenticated OAuth2 client for a scoreboard. Refreshes the
 * access token if expired. Persists the new access token + expiry to DB.
 * Returns null if the scoreboard has no connected YouTube account.
 */
export async function getAuthenticatedClientForScoreboard(
  scoreboardId: number
): Promise<{ oauth2: OAuth2Client; channelId: string } | null> {
  const row = await queryOne<{
    youtube_access_token: string | null;
    youtube_refresh_token: string | null;
    youtube_token_expires_at: Date | null;
    youtube_channel_id: string | null;
  }>(
    `SELECT youtube_access_token, youtube_refresh_token, youtube_token_expires_at,
            youtube_channel_id
     FROM scoreboards WHERE id = $1`,
    [scoreboardId]
  );
  if (!row || !row.youtube_refresh_token || !row.youtube_channel_id) return null;

  const oauth2 = buildOAuthClient();
  oauth2.setCredentials({
    access_token: row.youtube_access_token || undefined,
    refresh_token: row.youtube_refresh_token,
    expiry_date: row.youtube_token_expires_at
      ? row.youtube_token_expires_at instanceof Date
        ? row.youtube_token_expires_at.getTime()
        : new Date(row.youtube_token_expires_at).getTime()
      : undefined,
  });

  // Listen for automatic refresh and persist new tokens
  oauth2.on('tokens', async (newTokens) => {
    try {
      const expiresAt = newTokens.expiry_date ? new Date(newTokens.expiry_date) : null;
      await queryOne(
        `UPDATE scoreboards
         SET youtube_access_token = COALESCE($2, youtube_access_token),
             youtube_token_expires_at = COALESCE($3, youtube_token_expires_at)
         WHERE id = $1`,
        [scoreboardId, newTokens.access_token || null, expiresAt]
      );
    } catch (e) {
      console.warn('[youtube-api] failed to persist refreshed tokens:', e);
    }
  });

  // Force a refresh if expired or missing
  if (!row.youtube_access_token || (row.youtube_token_expires_at && new Date(row.youtube_token_expires_at).getTime() < Date.now())) {
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(credentials);
    } catch (err) {
      console.error('[youtube-api] refresh failed:', err);
      throw new Error('YouTube access token expired and refresh failed. Reconnect your account.');
    }
  }

  return { oauth2, channelId: row.youtube_channel_id };
}