/**
 * Plugin discovery — two sources:
 *
 *   1. npm registry search (A in M23 decision):
 *      Anyone publishing to npm with `keywords: ["sisyphus-plugin"]`
 *      shows up. Open ecosystem, zero curation.
 *
 *   2. Curated marketplace (B in M23 decision):
 *      A JSON file we host on github (or a custom URL via env var)
 *      lists hand-picked plugins with richer metadata: tags, icons,
 *      featured flag, longer description. The UI shows these on first
 *      open so users have a starting point before learning to search.
 *
 * Both endpoints return the same normalized PluginEntry shape so the
 * UI can render them uniformly.
 *
 * Network calls are best-effort: on failure we return [] with a
 * console.warn rather than throwing — the rest of the daemon stays
 * usable offline.
 */

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const SISYPHUS_KEYWORD = 'sisyphus-plugin';

const DEFAULT_MARKETPLACE_URL =
  'https://raw.githubusercontent.com/Devilsparta/Sisyphus/main/marketplace.json';

const MARKETPLACE_TTL_MS = 5 * 60 * 1000; // 5 min cache

export interface PluginEntry {
  packageName: string;
  version: string;
  displayName?: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** Only populated for marketplace entries; npm search has 'score' instead. */
  tags?: string[];
  iconUrl?: string;
  /** npm search popularity in [0,1]; absent for marketplace. */
  score?: number;
  /** Marketplace entries can be flagged featured. */
  featured?: boolean;
  /** Origin so UI can label "from npm" vs "official". */
  source: 'npm' | 'marketplace';
}

interface NpmSearchResponse {
  objects: Array<{
    package: {
      name: string;
      version: string;
      description?: string;
      keywords?: string[];
      author?: { name?: string };
      links?: { homepage?: string; npm?: string; repository?: string };
      publisher?: { username?: string };
    };
    score?: { final?: number };
  }>;
  total: number;
}

export async function searchNpm(
  query: string,
  size = 20,
): Promise<PluginEntry[]> {
  // Always scope to our keyword so we don't return arbitrary npm packages.
  const text = query.trim()
    ? `keywords:${SISYPHUS_KEYWORD} ${query.trim()}`
    : `keywords:${SISYPHUS_KEYWORD}`;
  const url = `${NPM_SEARCH_URL}?text=${encodeURIComponent(text)}&size=${size}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`npm search → ${res.status}`);
    }
    const data = (await res.json()) as NpmSearchResponse;
    return data.objects.map((o) => ({
      packageName: o.package.name,
      version: o.package.version,
      description: o.package.description,
      author:
        o.package.author?.name ?? o.package.publisher?.username ?? undefined,
      homepage:
        o.package.links?.homepage ??
        o.package.links?.repository ??
        o.package.links?.npm,
      score: o.score?.final,
      source: 'npm' as const,
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[plugin-search] npm search failed:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

interface MarketplaceFile {
  featured?: Array<{
    packageName: string;
    displayName?: string;
    description?: string;
    version?: string;
    author?: string;
    homepage?: string;
    tags?: string[];
    iconUrl?: string;
  }>;
  catalog?: MarketplaceFile['featured']; // same shape, non-featured
}

let cache: { at: number; entries: PluginEntry[] } | null = null;

export function getMarketplaceUrl(): string {
  return process.env.SISYPHUS_MARKETPLACE_URL ?? DEFAULT_MARKETPLACE_URL;
}

export async function fetchMarketplace(
  force = false,
): Promise<PluginEntry[]> {
  if (
    !force &&
    cache &&
    Date.now() - cache.at < MARKETPLACE_TTL_MS
  ) {
    return cache.entries;
  }
  const url = getMarketplaceUrl();
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`marketplace → ${res.status}`);
    const data = (await res.json()) as MarketplaceFile;
    const featured = (data.featured ?? []).map((p) => ({
      ...p,
      version: p.version ?? 'latest',
      featured: true,
      source: 'marketplace' as const,
    }));
    const catalog = (data.catalog ?? []).map((p) => ({
      ...p,
      version: p.version ?? 'latest',
      featured: false,
      source: 'marketplace' as const,
    }));
    const entries: PluginEntry[] = [...featured, ...catalog];
    cache = { at: Date.now(), entries };
    return entries;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[plugin-search] marketplace fetch failed:',
      err instanceof Error ? err.message : err,
    );
    // Stale cache better than nothing on transient network blips.
    return cache?.entries ?? [];
  }
}
