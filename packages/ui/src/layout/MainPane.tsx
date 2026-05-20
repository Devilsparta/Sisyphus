import { listViews, getView } from './registry';

interface MainPaneProps {
  activeViewId: string | null;
}

export default function MainPane({ activeViewId }: MainPaneProps) {
  const resolved =
    (activeViewId && getView(activeViewId)) ||
    listViews({ region: 'main' })[0] ||
    null;

  if (!resolved) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No main view registered
      </div>
    );
  }

  const View = resolved.Component;
  return <View />;
}
