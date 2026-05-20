import { useTodo } from '../todo-state';

export default function TodoListView() {
  const { tasks } = useTodo();

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Todos ({tasks.length})
        </h2>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tasks. Switch to the Chat view and type "add buy milk" to start.
          </p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((t) => (
              <li
                key={t.id}
                className={`text-sm ${
                  t.done
                    ? 'text-muted-foreground line-through'
                    : 'text-foreground'
                }`}
              >
                {t.done ? '☑' : '☐'} {t.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
