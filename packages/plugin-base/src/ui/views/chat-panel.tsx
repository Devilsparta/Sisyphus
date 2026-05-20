import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type FormEvent,
} from 'react';
import type { AgentEvent, CardInstance } from '@sisyphus/kernel';
import { getCardRenderer } from '@sisyphus/kernel/ui';
import { Button } from '../components/button';
import { Input } from '../components/input';
import { ScrollArea } from '../components/scroll-area';
import { useWorkspace } from '../workspace-state';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  errored?: boolean;
  cards?: CardInstance[];
}

function extractCodeBlock(text: string): string | null {
  const match = text.match(
    /```(?:jsx|tsx|javascript|js|react)?\s*\n([\s\S]*?)```/,
  );
  return match ? match[1].trim() : null;
}

export default function ChatPanel() {
  const { setGeneratedCode } = useWorkspace();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
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

  const applyEvent = (
    setMessagesFn: typeof setMessages,
    state: { content: string; reasoning: string },
    event: AgentEvent,
  ) => {
    if (event.type === 'token') {
      state.content += event.text;
      setMessagesFn((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        updated[updated.length - 1] = {
          ...last,
          role: 'assistant',
          content: state.content,
          reasoning: state.reasoning,
        };
        return updated;
      });
      const code = extractCodeBlock(state.content);
      if (code) setGeneratedCode(code);
    } else if (event.type === 'reasoning') {
      state.reasoning += event.text;
      setMessagesFn((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        updated[updated.length - 1] = {
          ...last,
          role: 'assistant',
          content: state.content,
          reasoning: state.reasoning,
        };
        return updated;
      });
    } else if (event.type === 'card') {
      setMessagesFn((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        updated[updated.length - 1] = {
          ...last,
          cards: [...(last.cards ?? []), event.card],
        };
        return updated;
      });
    } else if (event.type === 'done') {
      if (event.reason === 'error') {
        setMessagesFn((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          updated[updated.length - 1] = {
            ...last,
            content:
              last.content ||
              `Agent failed: ${event.error ?? 'unknown error'}`,
            errored: true,
          };
          return updated;
        });
      }
    }
    // tool_call / tool_result land in M4+.
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const userMessage: Message = { role: 'user', content: trimmed };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setIsStreaming(true);
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    const state = { content: '', reasoning: '' };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No reader');

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frame split — "\n\n" separates events; "data: " prefixes payload.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const dataLine = frame
            .split('\n')
            .find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          const payload = dataLine.slice(6);
          if (payload === '[DONE]') continue;
          try {
            const event = JSON.parse(payload) as AgentEvent;
            applyEvent(setMessages, state, event);
          } catch {
            // tolerate malformed lines mid-stream
          }
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Chat error:', err);
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: 'Sorry, something went wrong.',
          errored: true,
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
                msg.role === 'user'
                  ? 'text-foreground'
                  : msg.errored
                    ? 'text-destructive'
                    : 'text-muted-foreground'
              }`}
            >
              <span className="font-medium text-foreground">
                {msg.role === 'user' ? 'You' : 'AI'}:{' '}
              </span>
              {msg.content}
              {msg.role === 'assistant' &&
                i === messages.length - 1 &&
                isStreaming && (
                  <span className="ml-1 inline-block h-4 w-1 animate-pulse bg-foreground" />
                )}
              {msg.reasoning && (
                <details className="mt-2 text-xs text-muted-foreground/70">
                  <summary className="cursor-pointer select-none">
                    reasoning ({msg.reasoning.length} chars)
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap font-mono">
                    {msg.reasoning}
                  </pre>
                </details>
              )}
              {msg.cards?.map((card, j) => {
                const Renderer = getCardRenderer(card.type);
                return Renderer ? (
                  <Renderer
                    key={`card-${j}`}
                    payload={card.payload}
                  />
                ) : (
                  <div
                    key={`card-${j}`}
                    className="my-2 rounded border border-dashed border-border p-2 text-xs text-muted-foreground"
                  >
                    [no renderer registered for card type: {card.type}]
                  </div>
                );
              })}
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
        <Button
          type="submit"
          disabled={isStreaming || !input.trim()}
          size="sm"
        >
          Send
        </Button>
      </form>
    </div>
  );
}
