import { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import {
  disconnectSpotify,
  getRedirectUri,
  getSavedClientId,
  isSpotifyAuthenticated,
  startSpotifyLogin,
} from '../lib/spotify';

interface SpotifyConnectModalProps {
  open: boolean;
  onClose: () => void;
  onDisconnected: () => void;
}

export function SpotifyConnectModal({
  open,
  onClose,
  onDisconnected,
}: SpotifyConnectModalProps) {
  const [clientId, setClientId] = useState(() => getSavedClientId());
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const redirectUri = getRedirectUri();
  const connected = isSpotifyAuthenticated();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Не удалось скопировать URI');
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!clientId.trim()) {
      setError('Введите Client ID из Spotify Developer Dashboard');
      return;
    }
    try {
      setLoading(true);
      await startSpotifyLogin(clientId);
    } catch (err) {
      setLoading(false);
      setError(err instanceof Error ? err.message : 'Ошибка авторизации');
    }
  };

  const handleDisconnect = () => {
    disconnectSpotify();
    onDisconnected();
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Подключение Spotify</h2>
            <p className="modal-subtitle">
              OAuth PKCE работает прямо в браузере без стороннего сервера
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>

        <ol className="setup-steps">
          <li>
            Откройте{' '}
            <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
              Spotify Developer Dashboard
            </a>{' '}
            и создайте приложение.
          </li>
          <li>
            Добавьте этот Redirect URI в настройки приложения:
            <div className="uri-row">
              <code>{redirectUri}</code>
              <button type="button" className="chip-btn" onClick={handleCopy}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                <span>{copied ? 'Скопировано' : 'Копировать'}</span>
              </button>
            </div>
          </li>
          <li>Вставьте Client ID ниже и авторизуйтесь.</li>
        </ol>

        <form onSubmit={handleConnect} className="connect-form">
          <label htmlFor="spotify-client-id">Spotify Client ID</label>
          <input
            id="spotify-client-id"
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="например, 4f8a2c1e9b..."
            autoComplete="off"
          />

          {error && <p className="error-text">{error}</p>}

          <div className="modal-actions">
            {connected && (
              <button type="button" className="btn-secondary" onClick={handleDisconnect}>
                Отключить аккаунт
              </button>
            )}
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Переход в Spotify...' : connected ? 'Переподключить' : 'Войти через Spotify'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
