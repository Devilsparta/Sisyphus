import { getView } from '@sisyphus/kernel/ui';

interface SidePaneProps {
  activeViewId: string | null;
}

export default function SidePane({ activeViewId }: SidePaneProps) {
  const entry = activeViewId ? getView(activeViewId) : null;
  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No view selected
      </div>
    );
  }
  const View = entry.Component;
  return <View />;
}
