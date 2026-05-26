/**
 * @sisyphus/plugin-hello — minimal test fixture for the M24 broker.
 *
 * One skill (echo), one agent (hello-bot) that yields three tokens then
 * `done`. Used by daemon's broker smoke test to exercise init/activate/
 * invokeSkill/invokeAgent + agent.event notification flow end to end.
 */
import type {
  AgentImpl,
  SisyphusPlugin,
  SkillDescriptor,
  SkillHandler,
} from '@sisyphus/kernel';

const echoSkill: SkillDescriptor = {
  id: 'plugin-hello.skill.echo',
  schema: {
    type: 'function',
    function: {
      name: 'plugin_hello_echo',
      description: 'Echo back the input message with a "you said:" prefix.',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  },
};

const echoHandler: SkillHandler = async (args, ctx) => {
  const message = String(args.message ?? '');
  return { echoed: `you said: ${message}`, convo: ctx.conversationId };
};

const helloAgent: AgentImpl = {
  descriptor: {
    id: 'plugin-hello.agent.hello-bot',
    displayName: 'Hello Bot',
    description: 'Says hello in three streamed tokens.',
    spawnHint: 'When the user wants a hello greeting.',
    triggerKeywords: ['hello', 'hi'],
  },
  async run(userMessage, ctx) {
    ctx.emit({ type: 'token', text: 'hello ' });
    ctx.emit({ type: 'token', text: 'there, ' });
    ctx.emit({ type: 'token', text: `you said "${userMessage}"` });
    ctx.emit({ type: 'done', reason: 'stop' });
  },
};

/**
 * Cancellable streamer — emits 50 tokens with 20 ms delay between each,
 * respects ctx.signal. Used by the smoke test to validate that
 * runCtx.signal.abort() propagates through the broker as an
 * `agent.cancel` notification.
 */
const longRunnerAgent: AgentImpl = {
  descriptor: {
    id: 'plugin-hello.agent.long-runner',
    displayName: 'Long Runner',
    description: 'Streams 50 tokens slowly; respects cancellation.',
    spawnHint: 'When the user wants a long stream they can interrupt.',
  },
  async run(_userMessage, ctx) {
    for (let i = 0; i < 50; i++) {
      if (ctx.signal.aborted) {
        ctx.emit({ type: 'done', reason: 'cancelled' });
        return;
      }
      ctx.emit({ type: 'token', text: `n${i} ` });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    ctx.emit({ type: 'done', reason: 'stop' });
  },
};

/**
 * Emits the ids of skills it can see via ctx.querySkills(). Validates the
 * M24.2 `host.querySkills` snapshot — plugins should see their own
 * skills plus any explicitly declared in manifest.requires.skills.
 */
const skillListerAgent: AgentImpl = {
  descriptor: {
    id: 'plugin-hello.agent.skill-lister',
    displayName: 'Skill Lister',
    description: 'Reports the skills it can see.',
    spawnHint: 'When the user asks what skills are available.',
  },
  async run(_userMessage, ctx) {
    const skills = ctx.querySkills();
    ctx.emit({
      type: 'token',
      text: JSON.stringify(skills.map((s) => s.id).sort()),
    });
    ctx.emit({ type: 'done', reason: 'stop' });
  },
};

const plugin: SisyphusPlugin = {
  manifest: {
    id: 'plugin-hello',
    displayName: 'Hello Test Plugin',
    version: '0.1.0',
    dependencies: [],
    contributes: {
      agents: [
        helloAgent.descriptor,
        longRunnerAgent.descriptor,
        skillListerAgent.descriptor,
      ],
      views: [],
      cards: [],
      skills: [echoSkill],
    },
    // No UI bundle.
    uiEntry: '',
  },
  agents: [helloAgent, longRunnerAgent, skillListerAgent],
  skillHandlers: {
    [echoSkill.id]: echoHandler,
  },
};

export default plugin;
