import {
  SandpackProvider,
  SandpackLayout,
  SandpackPreview,
  SandpackCodeEditor,
} from "@codesandbox/sandpack-react";
import { useWorkspace } from "../workspace-state";

const DEFAULT_CODE = `export default function App() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      fontFamily: 'system-ui, sans-serif',
      color: '#888',
      background: '#1a1a1a',
    }}>
      <p>Describe what you want to build in the chat...</p>
    </div>
  );
}`;

export default function PreviewPanel() {
  const { generatedCode: code } = useWorkspace();
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Preview</h2>
      </div>
      <div className="flex-1 overflow-hidden">
        <SandpackProvider
          template="react"
          theme="dark"
          files={{
            "/App.js": { code: code || DEFAULT_CODE, active: true },
          }}
          options={{
            autorun: true,
            autoReload: true,
          }}
        >
          <SandpackLayout
            style={{ height: "100%", border: "none", borderRadius: 0 }}
          >
            <SandpackCodeEditor
              style={{ height: "100%" }}
              showLineNumbers
              showTabs={false}
              readOnly
            />
            <SandpackPreview
              style={{ height: "100%" }}
              showOpenInCodeSandbox={false}
              showRefreshButton
            />
          </SandpackLayout>
        </SandpackProvider>
      </div>
    </div>
  );
}
