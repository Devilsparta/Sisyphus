import { MessageSquare, Eye, Layers, type LucideIcon } from 'lucide-react';
import { listViews } from './registry';
import { cn } from '@/lib/utils';

interface ActivityBarProps {
  activeSideViewId: string | null;
  onActiveSideViewChange: (id: string) => void;
}

// Minimal icon map for built-in views; plugins will declare lucide names in
// their manifests once the plugin loader lands (M2).
const iconMap: Record<string, LucideIcon> = {
  'message-square': MessageSquare,
  eye: Eye,
  layers: Layers,
};

export default function ActivityBar({
  activeSideViewId,
  onActiveSideViewChange,
}: ActivityBarProps) {
  const sideViews = listViews({ region: 'side' });

  return (
    <div className="flex w-12 flex-col items-center gap-1 border-r border-border bg-background py-2">
      {sideViews.map((entry) => {
        const iconKey = entry.descriptor.icon;
        const Icon: LucideIcon =
          (iconKey ? iconMap[iconKey] : undefined) ?? Layers;
        const isActive = entry.descriptor.id === activeSideViewId;
        return (
          <button
            key={entry.descriptor.id}
            title={entry.descriptor.title}
            onClick={() => onActiveSideViewChange(entry.descriptor.id)}
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              isActive && 'bg-accent text-foreground',
            )}
          >
            <Icon size={20} />
          </button>
        );
      })}
    </div>
  );
}
