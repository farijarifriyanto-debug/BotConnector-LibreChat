import { useCallback, useEffect, useState } from 'react';
import { Cpu, Laptop, Link2, Play, RefreshCw, Unplug } from 'lucide-react';
import { Button } from '@librechat/client';
import { useAuthContext } from '~/hooks';

type Hardware = {
  cpu?: string;
  logicalCores?: number;
  ramGb?: number;
  freeRamGb?: number;
  nvidia?: Array<{ name?: string; memoryGb?: number; driver?: string }>;
};

type Device = {
  id: string;
  name: string;
  platform?: string;
  arch?: string;
  online: boolean;
  capabilities?: string[];
  hardware?: Hardware | null;
  last_seen?: string | null;
};

type DevicesResponse = { devices?: Device[] };
type PairResponse = { code?: string };

const LOCAL_CORE = 'http://127.0.0.1:18764';

async function readPayload(response: Response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export default function DevicePanel() {
  const { token } = useAuthContext();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pairCode, setPairCode] = useState('');

  const api = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('accept', 'application/json');
      if (init.body != null) headers.set('content-type', 'application/json');
      if (token) headers.set('authorization', `Bearer ${token}`);
      const response = await fetch(path, {
        ...init,
        headers,
        credentials: 'same-origin',
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        throw new Error(
          payload?.error?.message || payload?.message || `Request failed (${response.status})`,
        );
      }
      return payload;
    },
    [token],
  );

  const loadDevices = useCallback(async () => {
    setLoading(true);
    try {
      const payload = (await api('/api/devices')) as DevicesResponse;
      setDevices(Array.isArray(payload.devices) ? payload.devices : []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load devices.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const connectThisDevice = useCallback(async () => {
    setBusy('pair');
    setError('');
    setPairCode('');
    try {
      const pair = (await api('/api/devices/pair', {
        method: 'POST',
        body: '{}',
      })) as PairResponse;
      if (!pair.code) throw new Error('Pairing code was not returned.');
      setPairCode(pair.code);

      const localResponse = await fetch(`${LOCAL_CORE}/api/botconnector/local/device-pair`, {
        method: 'POST',
        mode: 'cors',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: pair.code }),
      });
      const localPayload = await readPayload(localResponse);
      if (!localResponse.ok) {
        throw new Error(
          localPayload?.error?.message ||
            'BotConnector Desktop rejected the pairing request. Open the desktop app and try again.',
        );
      }

      setPairCode('');
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      await loadDevices();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to connect BotConnector Desktop.';
      setError(
        message.includes('Failed to fetch')
          ? 'BotConnector Desktop is not reachable on this laptop. Open the desktop app, then try again.'
          : message,
      );
    } finally {
      setBusy(null);
    }
  }, [api, loadDevices]);

  const deviceRequest = useCallback(
    async (deviceId: string, method: string, params: Record<string, unknown> = {}) => {
      setBusy(`${deviceId}:${method}`);
      setError('');
      try {
        await api(`/api/devices/${encodeURIComponent(deviceId)}/request`, {
          method: 'POST',
          body: JSON.stringify({ method, params }),
        });
        await loadDevices();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Device request failed.');
      } finally {
        setBusy(null);
      }
    },
    [api, loadDevices],
  );

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      setBusy(`${deviceId}:revoke`);
      setError('');
      try {
        await api(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {
          method: 'POST',
          body: '{}',
        });
        await loadDevices();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to disconnect device.');
      } finally {
        setBusy(null);
      }
    },
    [api, loadDevices],
  );

  return (
    <section className="flex min-h-full flex-col gap-4 p-4">
      <div>
        <div className="flex items-center gap-2">
          <Laptop className="h-5 w-5" aria-hidden="true" />
          <h2 className="text-base font-semibold">Devices</h2>
        </div>
        <p className="mt-1 text-xs text-text-secondary">
          Connect this laptop to BotConnector for local hardware, Local AI, and locally approved tools.
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full justify-center gap-2"
        disabled={busy === 'pair'}
        onClick={() => void connectThisDevice()}
      >
        <Link2 className="h-4 w-4" aria-hidden="true" />
        {busy === 'pair' ? 'Connecting…' : 'Connect this device'}
      </Button>

      {pairCode && (
        <div className="rounded-lg border border-border-light bg-surface-secondary p-3 text-xs">
          <div className="font-medium">One-time pairing code</div>
          <code className="mt-1 block select-all break-all font-mono text-sm">{pairCode}</code>
          <div className="mt-1 text-text-secondary">
            Keep BotConnector Desktop open on this laptop and retry if automatic pairing was blocked.
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Your devices</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh devices"
          disabled={loading}
          onClick={() => void loadDevices()}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </Button>
      </div>

      {!loading && devices.length === 0 && (
        <div className="rounded-lg border border-dashed border-border-light p-4 text-center text-xs text-text-secondary">
          No paired devices yet.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {devices.map((device) => {
          const hardware = device.hardware;
          const nvidia = hardware?.nvidia?.[0];
          const online = device.online;
          return (
            <article key={device.id} className="rounded-xl border border-border-light p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{device.name || 'BotConnector device'}</div>
                  <div className="mt-0.5 text-xs text-text-secondary">
                    {device.platform || 'unknown'} {device.arch ? `· ${device.arch}` : ''}
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    online
                      ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                      : 'bg-surface-secondary text-text-secondary'
                  }`}
                >
                  {online ? 'Online' : 'Offline'}
                </span>
              </div>

              {hardware && (
                <div className="mt-3 rounded-lg bg-surface-secondary p-2 text-xs text-text-secondary">
                  <div className="flex gap-2">
                    <Cpu className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="truncate">{hardware.cpu || 'CPU unavailable'}</div>
                      <div>
                        {hardware.ramGb != null ? `${hardware.ramGb} GB RAM` : 'RAM unavailable'}
                        {nvidia?.name ? ` · ${nvidia.name}` : ''}
                        {nvidia?.memoryGb != null ? ` (${nvidia.memoryGb} GB)` : ''}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!online || busy != null}
                  onClick={() => void deviceRequest(device.id, 'hardware.get')}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  Hardware
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!online || busy != null}
                  onClick={() =>
                    void deviceRequest(device.id, 'launcher.start', {
                      id: 'desktop-commander-remote',
                    })
                  }
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  Remote tool
                </Button>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 w-full text-text-secondary"
                disabled={busy != null}
                onClick={() => void revokeDevice(device.id)}
              >
                <Unplug className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Disconnect
              </Button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
