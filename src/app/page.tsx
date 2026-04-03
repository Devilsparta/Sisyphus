"use client";

import { useState } from "react";
import ChatPanel from "@/components/chat-panel";
import PreviewPanel from "@/components/preview-panel";

export default function Home() {
  const [code, setCode] = useState("");

  return (
    <div className="flex h-screen">
      <div className="w-[400px] min-w-[400px] border-r border-border">
        <ChatPanel onCodeUpdate={setCode} />
      </div>
      <div className="flex-1">
        <PreviewPanel code={code} />
      </div>
    </div>
  );
}
