import OpenAI from "openai";

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY || "",
});

const model = process.env.OPENAI_MODEL || "gpt-4o";

export async function POST(req: Request) {
  const { messages } = await req.json();

  const stream = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a helpful coding assistant. When the user asks you to build something, respond with a single React component in a ```jsx code block. The code should be a complete, self-contained React component using export default. You can use inline styles. Do not use external imports besides React.",
      },
      ...messages,
    ],
    stream: true,
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
        }
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
