import { useCallback, useEffect, useState } from 'react';
import { Button } from '../components/button';
import { Input } from '../components/input';

type Scope = 'user' | 'project';

interface ConfigResponse {
  llm?: {
    baseURL?: string;
    apiKey?: string;
    model?: string;
    routerModel?: string;
  };
  auth?: { apiKey?: string };
}

interface WorkspaceResponse {
  path: string | null;
}

interface PluginInfo {
  packageName: string;
  enabled: boolean;
  activated: boolean;
  id: string | null;
  displayName: string | null;
  version: string | null;
  hasUiBundle: boolean;
}

interface PluginEntry {
  packageName: string;
  version: string;
  displayName?: string;
  description?: string;
  author?: string;
  homepage?: string;
  tags?: string[];
  iconUrl?: string;
  score?: number;
  featured?: boolean;
  source: 'npm' | 'marketplace';
}

type LlmField = NonNullable<ConfigResponse['llm']>;

const LLM_FIELDS: Array<{
  key: keyof LlmField;
  label: string;
  placeholder: string;
  secret?: boolean;
}> = [
  { key: 'baseURL', label: 'Base URL', placeholder: 'https://api.openai.com/v1' },
  { key: 'apiKey', label: 'API Key', placeholder: 'sk-…', secret: true },
  { key: 'model', label: 'Model', placeholder: 'gpt-4o' },
  {
    key: 'routerModel',
    label: 'Router model (optional)',
    placeholder: '(defaults to main model)',
  },
];

export default function SettingsView() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [workspaceInput, setWorkspaceInput] = useState('');
  const [scope, setScope] = useState<Scope>('user');
  const [config, setConfig] = useState<ConfigResponse>({});
  const [edits, setEdits] = useState<NonNullable<ConfigResponse['llm']>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Plugins state
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);
  const [pluginStatus, setPluginStatus] = useState<string | null>(null);

  // Marketplace browse / search
  const [marketplace, setMarketplace] = useState<PluginEntry[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [searchResults, setSearchResults] = useState<PluginEntry[] | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wsRes, cfgRes, pluginsRes, marketRes] = await Promise.all([
        fetch('/api/workspace').then((r) => r.json() as Promise<WorkspaceResponse>),
        fetch('/api/config').then((r) => r.json() as Promise<ConfigResponse>),
        fetch('/api/plugins').then((r) => r.json() as Promise<PluginInfo[]>),
        fetch('/api/plugins/marketplace')
          .then((r) => r.json() as Promise<{ entries: PluginEntry[] }>)
          .catch(() => ({ entries: [] })),
      ]);
      setWorkspace(wsRes.path);
      setWorkspaceInput(wsRes.path ?? '');
      setConfig(cfgRes);
      setEdits({});
      setPlugins(pluginsRes);
      setMarketplace(marketRes.entries);
    } catch (err) {
      setStatus(
        `Load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, []);

  // Debounced npm search.
  useEffect(() => {
    const q = searchInput.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/plugins/search?q=${encodeURIComponent(q)}`,
        );
        const json = (await res.json()) as { entries: PluginEntry[] };
        if (!cancelled) setSearchResults(json.entries);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [searchInput]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!workspace && scope === 'project') setScope('user');
  }, [workspace, scope]);

  function fieldValue(key: keyof LlmField): string {
    return edits[key] ?? config.llm?.[key] ?? '';
  }

  function setField(key: keyof LlmField, v: string): void {
    setEdits((e) => ({ ...e, [key]: v }));
  }

  async function saveWorkspace(): Promise<void> {
    setStatus(null);
    try {
      const res = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: workspaceInput.trim() || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
      setStatus('Workspace set');
    } catch (err) {
      setStatus(
        `Workspace save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function saveConfig(): Promise<void> {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, config: { llm: edits } }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        config?: ConfigResponse;
      };
      if (!json.ok) {
        setStatus(`Error: ${json.error ?? 'unknown'}`);
      } else {
        setStatus(`Saved to ${scope}`);
        if (json.config) setConfig(json.config);
        setEdits({});
      }
    } catch (err) {
      setStatus(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  async function pluginRequest(
    url: string,
    body: Record<string, unknown>,
    busyKey: string,
    successMsg: string,
  ): Promise<void> {
    setPluginBusy(busyKey);
    setPluginStatus(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        setPluginStatus(`${busyKey}: ${json.error ?? 'failed'}`);
      } else {
        setPluginStatus(successMsg);
      }
      await load();
    } catch (err) {
      setPluginStatus(
        `${busyKey} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setPluginBusy(null);
    }
  }

  async function installByPackageName(packageName: string): Promise<void> {
    await pluginRequest(
      '/api/plugins/install',
      { packageName },
      `install ${packageName}`,
      `Installed ${packageName}`,
    );
  }

  const installedSet = new Set(plugins.map((p) => p.packageName));
  const browseList: PluginEntry[] =
    searchResults !== null ? searchResults : marketplace;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Settings</h2>
      </div>
      <div className="flex-1 space-y-6 overflow-auto p-4">
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Workspace
          </h3>
          <div className="flex gap-2">
            <Input
              value={workspaceInput}
              onChange={(e) => setWorkspaceInput(e.target.value)}
              placeholder="/path/to/project (empty = user-only)"
            />
            <Button size="sm" onClick={saveWorkspace}>
              Set
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Project config lives at{' '}
            <code className="font-mono">&lt;workspace&gt;/.sisyphus/config.json</code>
            . Leave empty for user-only mode.
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Save scope
          </h3>
          <div className="flex gap-2">
            <Button
              variant={scope === 'user' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setScope('user')}
            >
              User
            </Button>
            <Button
              variant={scope === 'project' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setScope('project')}
              disabled={!workspace}
              title={workspace ? '' : 'Set workspace first'}
            >
              Project
            </Button>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            LLM
          </h3>
          {LLM_FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <label className="block text-xs text-muted-foreground">
                {f.label}
              </label>
              <Input
                type={f.secret ? 'password' : 'text'}
                value={fieldValue(f.key)}
                onChange={(e) => setField(f.key, e.target.value)}
                placeholder={f.placeholder}
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            API key is shown masked once saved; submitting the masked
            placeholder leaves the stored value untouched.
          </p>
        </section>

        <Button
          onClick={saveConfig}
          disabled={saving || Object.keys(edits).length === 0}
          className="w-full"
        >
          {saving ? 'Saving…' : `Save to ${scope}`}
        </Button>

        {status && (
          <p className="text-xs text-muted-foreground">{status}</p>
        )}

        <section className="space-y-3 border-t border-border pt-6">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Installed plugins
          </h3>

          <div className="space-y-2">
            {plugins.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No plugins installed yet. Pick one below.
              </p>
            ) : (
              plugins.map((p) => {
                const key = p.packageName;
                const busyOnThis = pluginBusy?.includes(key);
                return (
                  <div
                    key={key}
                    className="space-y-1 rounded border border-border p-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {p.displayName ?? p.packageName}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {p.packageName}
                          {p.version && (
                            <span className="ml-2">v{p.version}</span>
                          )}
                          {p.activated && (
                            <span className="ml-2 text-foreground">
                              · active
                            </span>
                          )}
                          {p.enabled && !p.activated && (
                            <span className="ml-2 text-destructive">
                              · enabled, not activated
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          size="sm"
                          variant={p.enabled ? 'secondary' : 'outline'}
                          disabled={busyOnThis}
                          onClick={() =>
                            pluginRequest(
                              p.enabled
                                ? '/api/plugins/disable'
                                : '/api/plugins/enable',
                              { packageName: key },
                              `${p.enabled ? 'disable' : 'enable'} ${key}`,
                              p.enabled
                                ? `Disabled ${key}`
                                : `Enabled ${key}`,
                            )
                          }
                        >
                          {p.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyOnThis}
                          onClick={() =>
                            pluginRequest(
                              '/api/plugins/uninstall',
                              { packageName: key },
                              `uninstall ${key}`,
                              `Uninstalled ${key}`,
                            )
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {pluginStatus && (
            <p className="text-xs text-muted-foreground">{pluginStatus}</p>
          )}
        </section>

        <section className="space-y-3 border-t border-border pt-6">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Browse plugins
          </h3>

          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search npm for sisyphus-plugin… (empty = show featured)"
          />
          <p className="text-xs text-muted-foreground">
            {searchResults === null
              ? `Featured (${marketplace.length}) — curated by the Sisyphus team`
              : searching
                ? 'Searching npm…'
                : `npm search results (${searchResults.length})`}
          </p>

          <div className="space-y-2">
            {browseList.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {searchResults === null
                  ? 'Marketplace is empty or unreachable.'
                  : 'No plugins found matching that query.'}
              </p>
            ) : (
              browseList.map((entry) => {
                const installed = installedSet.has(entry.packageName);
                const busyOnThis = pluginBusy?.includes(entry.packageName);
                return (
                  <div
                    key={`${entry.source}:${entry.packageName}`}
                    className="space-y-1 rounded border border-border p-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {entry.displayName ?? entry.packageName}
                          </span>
                          {entry.featured && (
                            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                              featured
                            </span>
                          )}
                          {entry.source === 'npm' && (
                            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                              npm
                            </span>
                          )}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {entry.packageName} v{entry.version}
                          {entry.author && (
                            <span className="ml-2">· {entry.author}</span>
                          )}
                          {typeof entry.score === 'number' && (
                            <span className="ml-2">
                              · score {entry.score.toFixed(2)}
                            </span>
                          )}
                        </div>
                        {entry.description && (
                          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {entry.description}
                          </div>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={installed ? 'ghost' : 'default'}
                        disabled={installed || busyOnThis}
                        onClick={() => installByPackageName(entry.packageName)}
                      >
                        {installed
                          ? 'Installed'
                          : busyOnThis
                            ? 'Installing…'
                            : 'Install'}
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
