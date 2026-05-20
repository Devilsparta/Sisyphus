import { useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import ActivityBar from './ActivityBar';
import SidePane from './SidePane';
import MainPane from './MainPane';
import { listViews } from '@sisyphus/kernel/ui';

/**
 * Sisyphus Panel Layout — VSCode-Lite four-region shell.
 *
 *   ┌──┬──────────┬──────────────────┐
 *   │A │  Side    │      Main        │
 *   │B │  Pane    │      Pane        │
 *   │  │          │                  │
 *   ├──┴──────────┴──────────────────┤
 *   │  Bottom Pane (collapsed in M1) │
 *   └────────────────────────────────┘
 *
 * ActivityBar (`A B`) is a fixed-width left strip; Side and Main are
 * horizontally resizable. Bottom Pane is intentionally omitted in M1 —
 * nothing registers there yet.
 */
export default function PanelLayout() {
  const sideViews = listViews({ region: 'side' });
  const [activeSideViewId, setActiveSideViewId] = useState<string | null>(
    sideViews[0]?.descriptor.id ?? null,
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <ActivityBar
        activeSideViewId={activeSideViewId}
        onActiveSideViewChange={setActiveSideViewId}
      />
      <Group orientation="horizontal" className="flex flex-1">
        <Panel id="side" defaultSize={30} minSize={15} maxSize={60}>
          <SidePane activeViewId={activeSideViewId} />
        </Panel>
        <Separator className="w-px cursor-col-resize bg-border transition-colors hover:bg-ring" />
        <Panel id="main" defaultSize={70} minSize={30}>
          <MainPane activeViewId={null} />
        </Panel>
      </Group>
    </div>
  );
}
