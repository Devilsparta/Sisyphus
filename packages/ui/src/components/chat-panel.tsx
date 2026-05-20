import { useState, useRef, useEffect, useCallback, FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useWorkspace } from "@/layout/workspace-state";

interface Message {
  role: "user" | "assistant";
  content: string;
}

function extractCodeBlock(text: string): string | null {
  const match = text.match(/```(?:jsx|tsx|javascript|js|react)?\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

export default function ChatPanel() {
  const { setGeneratedCode } = useWorkspace();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const userMessage: Message = { role: "user", content: trimmed };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsStreaming(true);

    let assistantContent = "";
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error("No reader");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") break;
            try {
              const parsed = JSON.parse(data);
              assistantContent += parsed.content;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: assistantContent,
                };
                return updated;
              });

              const code = extractCodeBlock(assistantContent);
              if (code) {
                setGeneratedCode(code);
              }
            } catch {
              // skip malformed chunks
            }
          }
        }
      }
    } catch (err) {
      console.error("Chat error:", err);
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: "Sorry, something went wrong.",
        };
        return updated;
      });
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Chat</h2>
      </div>
      <ScrollArea className="flex-1 p-4" ref={scrollRef}>
        <div className="space-y-4">
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Describe what you want to build...
            </p>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`text-sm whitespace-pre-wrap ${
                msg.role === "user"
                  ? "text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              <span className="font-medium text-foreground">
                {msg.role === "user" ? "You" : "AI"}:{" "}
              </span>
              {msg.content}
              {msg.role === "assistant" &&
                i === messages.length - 1 &&
                isStreaming && (
                  <span className="ml-1 inline-block h-4 w-1 animate-pulse bg-foreground" />
                )}
            </div>
          ))}
        </div>
      </ScrollArea>
      <form
        onSubmit={handleSubmit}
        className="flex gap-2 border-t border-border p-4"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask me to build something..."
          disabled={isStreaming}
          className="flex-1 bg-secondary"
        />
        <Button type="submit" disabled={isStreaming || !input.trim()} size="sm">
          Send
        </Button>
      </form>
    </div>
  );
}
