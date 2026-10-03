import { useEffect, useState } from 'react';
import type { Scoreboard, CreateScoreboardPayload } from '../types.js';
import {
  listScoreboards,
  createScoreboard,
  deleteScoreboard,
} from '../api.js';
import ScoreboardCard from './ScoreboardCard.js';

interface Props {
  onOpen: (scoreboard: Scoreboard) => void;
  onSettings: (scoreboard: Scoreboard) => void;
  onBinaries: () => void;
}

export default function ScoreboardList({ onOpen, onSettings, onBinaries }: Props) {
  const [scoreboards, setScoreboards] = useState<Scoreboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateScoreboardPayload>({
    uniqueIdentifier: '',
    displayName: '',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const data = await listScoreboards();
      setScoreboards(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scoreboards');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.uniqueIdentifier.trim()) {
      setFormError('Unique identifier is required');
      return;
    }
    setCreating(true);
    try {
      await createScoreboard({
        uniqueIdentifier: form.uniqueIdentifier.trim(),
        displayName: form.displayName?.trim() || undefined,
      });
      setForm({ uniqueIdentifier: '', displayName: '' });
      setShowForm(false);
      await refresh();
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
          : 'Failed to create scoreboard';
      setFormError(message ?? 'Failed to create scoreboard');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm('Delete this scoreboard?')) return;
    try {
      await deleteScoreboard(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  return (
    <div className="list-view">
      <header className="app-header">
        <h1>Scoreboard Manager</h1>
        <div className="header-actions">
          <button onClick={onBinaries} className="btn btn-ghost" title="Firmware binaries on the LAN">
            Binaries
          </button>
          <button onClick={refresh} className="btn btn-ghost">Refresh</button>
          <button
            onClick={() => setShowForm((s) => !s)}
            className="btn btn-primary"
          >
            {showForm ? 'Cancel' : '+ New Scoreboard'}
          </button>
        </div>
      </header>

      {showForm && (
        <form onSubmit={handleCreate} className="inline-form card">
          <input
            type="text"
            placeholder="unique-id (e.g. field-1)"
            value={form.uniqueIdentifier}
            onChange={(e) =>
              setForm((f) => ({ ...f, uniqueIdentifier: e.target.value }))
            }
            className="input"
            autoFocus
          />
          <input
            type="text"
            placeholder="Display name (optional)"
            value={form.displayName ?? ''}
            onChange={(e) =>
              setForm((f) => ({ ...f, displayName: e.target.value }))
            }
            className="input"
          />
          <button type="submit" disabled={creating} className="btn btn-primary">
            {creating ? 'Creating...' : 'Create'}
          </button>
          {formError && <div className="form-error">{formError}</div>}
        </form>
      )}

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="muted">Loading...</div>}
      {!loading && !error && scoreboards.length === 0 && (
        <div className="empty-state">
          <p>No scoreboards yet.</p>
          <p>Click "New Scoreboard" to create one.</p>
        </div>
      )}

      <div className="card-grid">
        {scoreboards.map((sb) => (
          <div key={sb.id} className="card-wrapper">
            <ScoreboardCard scoreboard={sb} onClick={onOpen} onSettings={onSettings} />
            <button
              className="btn btn-danger-small"
              onClick={(e) => handleDelete(sb.id, e)}
              title="Delete"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
