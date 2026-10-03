import { google } from 'googleapis';
import { getAuthenticatedClientForScoreboard } from './routes/youtube.js';
const auth = await getAuthenticatedClientForScoreboard(6);
if (!auth) { console.log('no auth'); process.exit(1); }
const yt = google.youtube({ version: 'v3', auth: auth.oauth2 as any });

// Get the most recent broadcast on this channel
const list = await yt.liveBroadcasts.list({
  part: ['status', 'snippet', 'contentDetails'],
  maxResults: 3,
  broadcastType: 'all',
  mine: true,
});
for (const b of list.data.items ?? []) {
  console.log('---');
  console.log('id:', b.id);
  console.log('title:', b.snippet?.title);
  console.log('lifecycle:', b.status?.lifeCycleStatus);
  console.log('recording:', b.status?.recordingStatus);
  console.log('monitorStream:', JSON.stringify(b.contentDetails?.monitorStream));
}
// Also get the most recent live stream
const sl = await yt.liveStreams.list({ part: ['status', 'cdn'], maxResults: 3, mine: true });
for (const s of sl.data.items ?? []) {
  console.log('---STREAM---');
  console.log('id:', s.id);
  console.log('status:', JSON.stringify(s.status));
}
