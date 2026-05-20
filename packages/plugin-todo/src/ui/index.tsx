/**
 * plugin-todo UI entry.
 */
import type { ComponentType, ReactNode } from 'react';
import type { CardDescriptor, ViewDescriptor } from '@sisyphus/kernel';
import TaskListCard from './cards/task-list-card';
import TodoListView from './views/todo-list-view';
import { TodoProvider } from './todo-state';

type Provider = ComponentType<{ children: ReactNode }>;

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
      id: 'plugin-todo.view.task-list',
      region: 'side',
      title: 'Todos',
      icon: 'list-todo',
      defaultVisible: true,
    },
    Component: TodoListView,
  },
];

export const cardRenderers: UICardRegistration[] = [
  {
    descriptor: { type: 'plugin-todo.card.task-list' },
    Component: TaskListCard,
  },
];

export const providers: Provider[] = [TodoProvider];
