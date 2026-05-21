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

  const load = useCallback(async () => {
    try {
      const [wsRes, cfgRes] = await Promise.all([
        fetch('/api/workspace').then((r) => r.json() as Promise<WorkspaceResponse>),
        fetch('/api/config').then((r) => r.json() as Promise<ConfigResponse>),
      ]);
      setWorkspace(wsRes.path);
      setWorkspaceInput(wsRes.path ?? '');
      setConfig(cfgRes);
      setEdits({});
    } catch (err) {
      setStatus(
        `Load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // If user clears workspace, force scope back to "user".
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
      </div>
    </div>
  );
}
