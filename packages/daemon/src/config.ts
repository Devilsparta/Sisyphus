/**
 * Daemon configuration: project > user > env-var precedence.
 *
 * Files:
 *   - <workspace>/.sisyphus/config.json     (project scope, optional)
 *   - ~/.sisyphus/config.json               (user scope, optional)
 *   - environment variables                  (baseline)
 *
 * The merged config is applied back to process.env at every reload so
 * plugin code that already reads OPENAI_* / SISYPHUS_* env vars
 * (react-designer, assistant, router, auth) needs zero changes.
 *
 * Workspace identity is set at runtime by the UI via POST /api/workspace —
 * the daemon doesn't auto-discover a workspace. With no workspace set,
 * project scope is ignored and only user + env vars apply.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface SisyphusConfig {
  llm?: {
    baseURL?: string;
    apiKey?: string;
    model?: string;
    routerModel?: string;
  };
  auth?: {
    apiKey?: string;
  };
}

const USER_CONFIG_PATH = path.join(
  os.homedir(),
  '.sisyphus',
  'config.json',
);

const PROJECT_CONFIG_SUBPATH = path.join('.sisyphus', 'config.json');

let currentWorkspace: string | null = null;
let mergedConfig: SisyphusConfig = {};

async function readConfigFile(filePath: string): Promise<SisyphusConfig | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as SisyphusConfig;
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    // eslint-disable-next-line no-console
    console.warn(`[config] failed to read ${filePath}:`, err);
    return null;
  }
}

function deepMerge(...sources: Array<SisyphusConfig | null | undefined>): SisyphusConfig {
  const result: SisyphusConfig = {};
  for (const src of sources) {
    if (!src) continue;
    if (src.llm) {
      result.llm = { ...(result.llm ?? {}), ...src.llm };
    }
    if (src.auth) {
      result.auth = { ...(result.auth ?? {}), ...src.auth };
    }
  }
  return result;
}

function envSnapshot(): SisyphusConfig {
  const env: SisyphusConfig = {};
  const llm: NonNullable<SisyphusConfig['llm']> = {};
  if (process.env.OPENAI_BASE_URL) llm.baseURL = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_API_KEY) llm.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_MODEL) llm.model = process.env.OPENAI_MODEL;
  if (process.env.SISYPHUS_ROUTER_MODEL) {
    llm.routerModel = process.env.SISYPHUS_ROUTER_MODEL;
  }
  if (Object.keys(llm).length > 0) env.llm = llm;
  if (process.env.SISYPHUS_API_KEY) {
    env.auth = { apiKey: process.env.SISYPHUS_API_KEY };
  }
  return env;
}

function applyToEnv(cfg: SisyphusConfig): void {
  // Write merged config back so downstream code reading process.env picks up
  // the latest values. We don't delete vars on absence (would break dotenv
  // hot-reload edge cases), only write present ones.
  if (cfg.llm?.baseURL) process.env.OPENAI_BASE_URL = cfg.llm.baseURL;
  if (cfg.llm?.apiKey) process.env.OPENAI_API_KEY = cfg.llm.apiKey;
  if (cfg.llm?.model) process.env.OPENAI_MODEL = cfg.llm.model;
  if (cfg.llm?.routerModel) {
    process.env.SISYPHUS_ROUTER_MODEL = cfg.llm.routerModel;
  }
  if (cfg.auth?.apiKey) process.env.SISYPHUS_API_KEY = cfg.auth.apiKey;
}

/**
 * Re-read all config sources (user + project + env) and apply the merge.
 * Called at boot and after every successful POST /api/config or workspace
 * switch.
 */
export async function reloadConfig(): Promise<SisyphusConfig> {
  const env = envSnapshot();
  const user = (await readConfigFile(USER_CONFIG_PATH)) ?? {};
  let project: SisyphusConfig = {};
  if (currentWorkspace) {
    project =
      (await readConfigFile(
        path.join(currentWorkspace, PROJECT_CONFIG_SUBPATH),
      )) ?? {};
  }
  // Precedence (later overrides earlier): env < user < project
  mergedConfig = deepMerge(env, user, project);
  applyToEnv(mergedConfig);
  return mergedConfig;
}

export function getMergedConfig(): SisyphusConfig {
  return mergedConfig;
}

export function getWorkspace(): string | null {
  return currentWorkspace;
}

export async function setWorkspace(p: string | null): Promise<void> {
  currentWorkspace = p && p.trim().length > 0 ? p : null;
  await reloadConfig();
}

async function writeConfigFile(
  filePath: string,
  patch: SisyphusConfig,
): Promise<void> {
  const existing = (await readConfigFile(filePath)) ?? {};
  const next = deepMerge(existing, patch);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2));
  await fs.rename(tmp, filePath);
}

export async function writeUserConfig(patch: SisyphusConfig): Promise<void> {
  await writeConfigFile(USER_CONFIG_PATH, patch);
}

export async function writeProjectConfig(
  patch: SisyphusConfig,
): Promise<void> {
  if (!currentWorkspace) {
    throw new Error(
      'no workspace set; POST /api/workspace before writing project config',
    );
  }
  await writeConfigFile(
    path.join(currentWorkspace, PROJECT_CONFIG_SUBPATH),
    patch,
  );
}

/**
 * Mask sensitive fields for safe GET responses. Empty/missing fields stay
 * empty so the UI knows "no value yet, show editable plain field". Set
 * fields are masked to "...XXXX" (last 4 chars) for redisplay.
 */
function mask(v: string | undefined): string | undefined {
  if (!v) return v;
  if (v.length <= 4) return '****';
  return `…${v.slice(-4)}`;
}

export function maskConfigForResponse(cfg: SisyphusConfig): SisyphusConfig {
  return {
    llm: cfg.llm
      ? {
          baseURL: cfg.llm.baseURL,
          apiKey: mask(cfg.llm.apiKey),
          model: cfg.llm.model,
          routerModel: cfg.llm.routerModel,
        }
      : undefined,
    auth: cfg.auth
      ? {
          apiKey: mask(cfg.auth.apiKey),
        }
      : undefined,
  };
}

/**
 * Detect whether a value in an incoming POST body is a masked placeholder
 * the UI sent back unchanged. UI tells daemon "this field wasn't edited"
 * by sending the same "…XXXX" form it received. We drop those from the
 * patch so we don't overwrite the real key with the mask.
 */
export function isMaskedValue(v: unknown): boolean {
  return typeof v === 'string' && /^…[\w-]{1,8}$/.test(v);
}

/**
 * Strip masked-placeholder fields from an incoming config patch.
 */
export function stripMaskedFields(patch: SisyphusConfig): SisyphusConfig {
  const out: SisyphusConfig = {};
  if (patch.llm) {
    const llm: NonNullable<SisyphusConfig['llm']> = { ...patch.llm };
    if (isMaskedValue(llm.apiKey)) delete llm.apiKey;
    out.llm = llm;
  }
  if (patch.auth) {
    const auth: NonNullable<SisyphusConfig['auth']> = { ...patch.auth };
    if (isMaskedValue(auth.apiKey)) delete auth.apiKey;
    out.auth = auth;
  }
  return out;
}
