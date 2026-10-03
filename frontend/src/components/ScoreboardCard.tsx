import type { Scoreboard } from '../types.js';

interface Props {
  scoreboard: Scoreboard;
  onClick: (scoreboard: Scoreboard) => void;
  onSettings: (scoreboard: Scoreboard) => void;
}

export default function ScoreboardCard({ scoreboard, onClick, onSettings }: Props) {
  const {
    displayName,
    uniqueIdentifier,
    homeScore,
    awayScore,
    inning,
    half,
    balls,
    strikes,
    outs,
    homeTeamName,
    awayTeamName,
  } = scoreboard;

  const halfLabel = half === 'top' ? 'Top' : 'Bot';
  const title = displayName || uniqueIdentifier;

  return (
    <div className="card scoreboard-card" onClick={() => onClick(scoreboard)}>
      <div className="card-header-row">
        <div className="card-title">{title}</div>
        <button
          className="gear-btn"
          onClick={(e) => {
            e.stopPropagation();
            onSettings(scoreboard);
          }}
          title="Settings"
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>
      <div className="card-identifier">{uniqueIdentifier}</div>
      <div className="card-score-row">
        <span className="card-team-label">{homeTeamName}</span>
        <span className="card-score">{homeScore}</span>
        <span className="card-dash">-</span>
        <span className="card-score">{awayScore}</span>
        <span className="card-team-label">{awayTeamName}</span>
      </div>
      <div className="card-meta">
        <span>{halfLabel} {inning}</span>
        <span>{balls}-{strikes}, {outs} out{outs === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}
