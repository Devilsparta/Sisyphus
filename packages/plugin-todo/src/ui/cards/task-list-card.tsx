import { useEffect } from 'react';
import { useTodo, type Task } from '../todo-state';

interface Payload {
  tasks: Task[];
}

export default function TaskListCard({ payload }: { payload: unknown }) {
  const p = payload as Payload;
  const { setTasks } = useTodo();

  // Mirror this card's snapshot into the plugin's UI state so the side-pane
  // view stays current. Latest card wins — that matches the daemon being the
  // source of truth.
  useEffect(() => {
    setTasks(p.tasks ?? []);
  }, [p.tasks, setTasks]);

  return (
    <div className="my-2 rounded border border-border bg-card p-3">
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        Todo list ({p.tasks?.length ?? 0})
      </div>
      {!p.tasks || p.tasks.length === 0 ? (
        <div className="text-xs text-muted-foreground">No tasks yet.</div>
      ) : (
        <ul className="space-y-1">
          {p.tasks.map((t) => (
            <li
              key={t.id}
              className={`text-sm ${
                t.done ? 'text-muted-foreground line-through' : 'text-foreground'
              }`}
            >
              {t.done ? '☑' : '☐'} {t.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
