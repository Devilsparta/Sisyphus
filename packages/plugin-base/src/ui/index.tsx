/**
 * plugin-base UI entry — exports React components for the host to mount.
 *
 * The kernel UI (packages/ui) imports this module and threads the
 * registrations through its layout / chat / card systems. The daemon entry
 * (`@sisyphus/plugin-base`) stays React-free.
 */
import type { ComponentType, ReactNode } from 'react';
import type { CardDescriptor, ViewDescriptor } from '@sisyphus/kernel';
import ChatPanel from './views/chat-panel';
import CanvasPreview from './views/canvas-preview';
import { WorkspaceProvider } from './workspace-state';

export interface UIViewRegistration {
  descriptor: ViewDescriptor;
  Component: ComponentType;
}

export interface UICardRegistration {
  descriptor: CardDescriptor;
  Component: ComponentType<{ payload: unknown }>;
}

export const views: UIViewRegistration[] = [
  {
    descriptor: {
      id: 'plugin-base.view.chat',
      region: 'side',
      title: 'Chat',
      icon: 'message-square',
      defaultVisible: true,
    },
    Component: ChatPanel,
  },
  {
    descriptor: {
      id: 'plugin-base.view.canvas-preview',
      region: 'main',
      title: 'Preview',
      icon: 'eye',
      defaultVisible: true,
    },
    Component: CanvasPreview,
  },
];

export const cardRenderers: UICardRegistration[] = [];

/**
 * Root provider this plugin needs wrapped around the layout shell so its
 * views can share state. M3+ will replace this with a plugin-agnostic
 * provider-stack mechanism in the kernel UI; for now the host knows it
 * needs to render this one plugin's provider explicitly.
 */
export function PluginBaseProvider({ children }: { children: ReactNode }) {
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}
