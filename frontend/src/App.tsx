import { useEffect, useState } from 'react';
import ScoreboardList from './components/ScoreboardList.js';
import ScoreboardEditor from './components/ScoreboardEditor.js';
import PublicScoreboard from './components/PublicScoreboard.js';
import BinariesPage from './components/BinariesPage.js';
import type { Scoreboard } from './types.js';

type View =
  | { mode: 'list' }
  | { mode: 'editor'; id: number }
  | { mode: 'settings'; id: number }
  | { mode: 'public'; identifier: string }
  | { mode: 'binaries' };

/**
 * Tiny URL routing — no react-router needed for our handful of pages.
 *
 *   /                 → list of scoreboards (editor UI)
 *   /binaries         → firmware binaries directory
 *   /watch/<id>       → public, read-only scoreboard (shareable link)
 *   (no path)         → editor / settings (driven by internal state)
 *
 * The /watch/ path is intentionally hash-free so it's a clean shareable URL.
 */
function parseRoute(): View {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/binaries') return { mode: 'binaries' };
  const watchMatch = path.match(/^\/watch\/([A-Za-z0-9_-]+)$/);
  if (watchMatch) return { mode: 'public', identifier: watchMatch[1] };
  return { mode: 'list' };
}

function pushRoute(view: View) {
  let path = '/';
  if (view.mode === 'binaries') path = '/binaries';
  else if (view.mode === 'public') path = `/watch/${view.identifier}`;
  if (window.location.pathname !== path) {
    window.history.pushState({}, '', path);
  }
}

export default function App() {
  const [view, setView] = useState<View>(parseRoute());

  // Re-parse on back/forward navigation
  useEffect(() => {
    const onPop = () => setView(parseRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Keep the URL in sync with the active internal view (for /binaries especially).
  useEffect(() => {
    pushRoute(view);
  }, [view]);

  if (view.mode === 'public') {
    return <PublicScoreboard identifier={view.identifier} />;
  }

  if (view.mode === 'binaries') {
    return <BinariesPage onBack={() => setView({ mode: 'list' })} />;
  }

  if (view.mode === 'editor') {
    return (
      <ScoreboardEditor
        scoreboardId={view.id}
        initialTab="state"
        onBack={() => setView({ mode: 'list' })}
        onSettings={() => setView({ mode: 'settings', id: view.id })}
      />
    );
  }

  if (view.mode === 'settings') {
    return (
      <ScoreboardEditor
        scoreboardId={view.id}
        initialTab="settings"
        onBack={() => setView({ mode: 'list' })}
        onSettings={() => setView({ mode: 'editor', id: view.id })}
      />
    );
  }

  return (
    <ScoreboardList
      onOpen={(sb: Scoreboard) => setView({ mode: 'editor', id: sb.id })}
      onSettings={(sb: Scoreboard) => setView({ mode: 'settings', id: sb.id })}
      onBinaries={() => setView({ mode: 'binaries' })}
    />
  );
}
