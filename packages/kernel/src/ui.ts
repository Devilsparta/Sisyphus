/**
 * @sisylabs/kernel/ui — UI-side runtime registries.
 *
 * These maps live in browser-loaded code only. They're in the kernel package
 * (not the ui package) so plugins can register renderers without depending on
 * `@sisylabs/ui` — which would create a cycle, since the ui package depends
 * on plugins for their UI bundles.
 *
 * React is `import type`-only — TypeScript strips it from emit, so the
 * daemon's `@sisylabs/kernel` entry stays React-runtime-free.
 */
import type { ComponentType, ReactNode } from 'react';
import type { Region, ViewDescriptor } from './index';

// ─── View registry ─────────────────────────────────────────────────────────

export interface UIViewEntry {
  descriptor: ViewDescriptor;
  Component: ComponentType;
}

const views = new Map<string, UIViewEntry>();

export function registerView(
  descriptor: ViewDescriptor,
  Component: ComponentType,
): () => void {
  if (views.has(descriptor.id)) {
    throw new Error(`View id collision: ${descriptor.id}`);
  }
  views.set(descriptor.id, { descriptor, Component });
  return () => {
    views.delete(descriptor.id);
  };
}

export function getView(id: string): UIViewEntry | undefined {
  return views.get(id);
}

export function listViews(filter?: { region?: Region }): UIViewEntry[] {
  const all = Array.from(views.values());
  return filter?.region
    ? all.filter((e) => e.descriptor.region === filter.region)
    : all;
}

// ─── Card renderer registry ────────────────────────────────────────────────

export type CardRendererComponent = ComponentType<{ payload: unknown }>;

const cardRenderers = new Map<string, CardRendererComponent>();

export function registerCardRenderer(
  type: string,
  Component: CardRendererComponent,
): () => void {
  if (cardRenderers.has(type)) {
    throw new Error(`Card renderer collision: ${type}`);
  }
  cardRenderers.set(type, Component);
  return () => {
    cardRenderers.delete(type);
  };
}

export function getCardRenderer(
  type: string,
): CardRendererComponent | undefined {
  return cardRenderers.get(type);
}

// ─── Provider registry ─────────────────────────────────────────────────────
//
// Plugins that need to wrap the host with a React context provider register
// it here. The host renders a <ProviderStack> that nests them around the
// layout shell. Order: registration order, outermost first.

export type ProviderComponent = ComponentType<{ children: ReactNode }>;

const providers: ProviderComponent[] = [];

export function registerProvider(Component: ProviderComponent): () => void {
  providers.push(Component);
  return () => {
    const idx = providers.indexOf(Component);
    if (idx !== -1) providers.splice(idx, 1);
  };
}

export function getProviders(): ProviderComponent[] {
  return [...providers];
}
