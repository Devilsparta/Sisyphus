/**
 * Cross-view workspace state.
 *
 * M1: a single context holding the generated React code that chat produces
 * and canvas-preview consumes. M2 will move this concern inside plugin-base
 * (chat and preview are both plugin-owned views; the kernel shouldn't hold
 * application-specific state).
 */
import { createContext, useContext, useState, type ReactNode } from 'react';

interface WorkspaceState {
  generatedCode: string;
  setGeneratedCode: (code: string) => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [generatedCode, setGeneratedCode] = useState('');
  return (
    <WorkspaceContext.Provider value={{ generatedCode, setGeneratedCode }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  }
  return ctx;
}
