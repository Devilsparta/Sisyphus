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

const echoHandler: SkillHandler = async (args) => {
  const message = String(args.message ?? '');
  return { echoed: `you said: ${message}` };
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

const plugin: SisyphusPlugin = {
  manifest: {
    id: 'plugin-hello',
    displayName: 'Hello Test Plugin',
    version: '0.1.0',
    dependencies: [],
    contributes: {
      agents: [helloAgent.descriptor],
      views: [],
      cards: [],
      skills: [echoSkill],
    },
    // No UI bundle.
    uiEntry: '',
  },
  agents: [helloAgent],
  skillHandlers: {
    [echoSkill.id]: echoHandler,
  },
};

export default plugin;
