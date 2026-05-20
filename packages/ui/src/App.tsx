import { PanelLayout, registerView, WorkspaceProvider } from './layout';
import ChatPanel from './components/chat-panel';
import PreviewPanel from './components/preview-panel';

// M1 built-in views. M2 will move these registrations into @sisyphus/plugin-base.
registerView(
  {
    id: 'kernel.view.chat',
    region: 'side',
    title: 'Chat',
    icon: 'message-square',
    defaultVisible: true,
  },
  ChatPanel,
);

registerView(
  {
    id: 'kernel.view.canvas-preview',
    region: 'main',
    title: 'Preview',
    icon: 'eye',
    defaultVisible: true,
  },
  PreviewPanel,
);

export default function App() {
  return (
    <WorkspaceProvider>
      <PanelLayout />
    </WorkspaceProvider>
  );
}
