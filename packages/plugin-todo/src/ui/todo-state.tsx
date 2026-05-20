/**
 * UI mirror of the daemon-side todo list.
 *
 * Updated via `task-list` cards: every time the agent emits one, the card
 * renderer side-effects this state to the latest snapshot. The side-pane view
 * subscribes through useTodo() to display the same list independent of chat.
 *
 * Why a mirror (vs WS-pushed events): keeps the plugin's UI self-contained
 * — no need to subscribe to a custom WS event channel. The card itself is
 * the broadcast mechanism. Tradeoff: state lives only as long as the cards
 * stay in the chat scrollback (or new cards arrive).
 */
import { createContext, useContext, useState, type ReactNode } from 'react';

export interface Task {
  id: string;
  text: string;
  done: boolean;
  createdAt?: number;
}

interface TodoState {
  tasks: Task[];
  setTasks: (tasks: Task[]) => void;
}

const TodoContext = createContext<TodoState | null>(null);

export function TodoProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  return (
    <TodoContext.Provider value={{ tasks, setTasks }}>
      {children}
    </TodoContext.Provider>
  );
}

export function useTodo(): TodoState {
  const ctx = useContext(TodoContext);
  if (!ctx) {
    throw new Error('useTodo must be used inside <TodoProvider>');
  }
  return ctx;
}
