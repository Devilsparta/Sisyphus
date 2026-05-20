/**
 * UI-side view registry.
 *
 * Maps view ids to their React renderers. View metadata (id, region, title,
 * icon) is recorded here for the layout system; the daemon-side registry
 * remains the source of truth for *which* views exist (built-in + plugins).
 *
 * In M1 only built-in views (chat, canvas-preview) are registered at boot.
 * M2 plugin loader will register additional renderers when a plugin's UI
 * bundle is loaded.
 */
import type { ComponentType } from 'react';
import type { Region, ViewDescriptor } from '@sisyphus/kernel';

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
