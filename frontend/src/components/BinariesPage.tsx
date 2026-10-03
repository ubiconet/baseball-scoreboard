import { useState } from 'react';

/**
 * Binaries page — directory of firmware binaries hosted on the LAN
 * by the AI Mac mini's `binaries-server.py` launchd job.
 *
 * Pure static anchor links (not an iframe) so the listing is the
 * server's own native directory index — no iframe styling headaches.
 */

interface Folder {
  name: string;
  label: string;
  description: string;
  href: string;
}

// Public URL — served through the cloudflared tunnel at
// https://scoreboard.ubiconet.com/binaries/. The tunnel routes
// /binaries/* to the launchd-managed binaries server on the AI Mac mini.
const BASE_URL = 'https://scoreboard.ubiconet.com/binaries';

const FOLDERS: Folder[] = [
  {
    name: 'NHLScoreboard',
    label: 'NHL Scoreboard',
    description: 'ESP32 firmware binaries for the NHL LED-matrix scoreboard.',
    href: `${BASE_URL}/NHLScoreboard/`,
  },
  {
    name: 'MLBScoreboard',
    label: 'MLB Scoreboard',
    description: 'ESP32 firmware binaries for the MLB LED-matrix scoreboard.',
    href: `${BASE_URL}/MLBScoreboard/`,
  },
  {
    name: 'GamechangerScoreboard',
    label: 'GameChanger Scoreboard',
    description: 'ESP32 firmware binaries for the GameChanger (baseball) scoreboard.',
    href: `${BASE_URL}/GamechangerScoreboard/`,
  },
];

export default function BinariesPage({ onBack }: { onBack: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(label);
        setTimeout(() => setCopied(null), 1200);
      },
      () => {
        /* clipboard unavailable — ignore */
      },
    );
  }

  return (
    <div className="list-view">
      <header className="app-header">
        <h1>Firmware Binaries</h1>
        <div className="header-actions">
          <button onClick={onBack} className="btn btn-ghost">
            ← Back
          </button>
        </div>
      </header>

      <div className="muted" style={{ padding: '0 1.5rem 0.75rem' }}>
        Served over HTTPS via the Cloudflare tunnel at{' '}
        <code style={{ background: 'var(--bg)', padding: '0 4px', borderRadius: 3 }}>
          {BASE_URL}
        </code>
        . No password — open in any browser. Direct LAN access also available at{' '}
        <code style={{ background: 'var(--bg)', padding: '0 4px', borderRadius: 3 }}>
          http://192.168.1.163:8000/
        </code>
        .
      </div>

      <div className="card-grid">
        {FOLDERS.map((f) => (
          <div key={f.name} className="card card-binaries">
            <div className="card-header-row">
              <div className="card-title">{f.label}</div>
              <span className="card-identifier">{f.name}/</span>
            </div>
            <p style={{ color: 'var(--muted)', margin: '0.5rem 0 1rem', fontSize: '0.9rem' }}>
              {f.description}
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <a
                href={f.href}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
              >
                Open folder ↗
              </a>
              <button
                onClick={() => copy(f.href, f.name)}
                className="btn btn-ghost"
                title="Copy URL to clipboard"
              >
                {copied === f.name ? 'Copied!' : 'Copy URL'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="muted" style={{ padding: '1.5rem', fontSize: '0.85rem' }}>
        To upload new firmware: drop <code>.bin</code> and <code>.elf</code> files into the
        corresponding folder on the AI Mac mini — they appear in the directory listing
        immediately. Server logs:{' '}
        <code>~/Library/Logs/binariesserver.out.log</code> on the AI Mac mini.
      </div>
    </div>
  );
}
