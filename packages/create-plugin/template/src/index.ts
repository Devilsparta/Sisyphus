/**
 * {{displayName}} — {{description}}
 *
 * Edit the agents and skills below, then `pnpm build` + `npm publish`.
 * Any Sisyphus installation can then `npm install {{pkgName}}` from the
 * marketplace search.
 */
import type {
  AgentImpl,
  SisyphusPlugin,
  SkillDescriptor,
  SkillHandler,
} from '@sisylabs/kernel';

const echoSkill: SkillDescriptor = {
  id: '{{pluginId}}.skill.echo',
  schema: {
    type: 'function',
    function: {
      name: '{{pluginId}}_echo'.replaceAll('-', '_'),
      description: 'Echo the input string back with a prefix.',
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
  return { echoed: `[{{pluginId}}] ${message}` };
};

const helloAgent: AgentImpl = {
  descriptor: {
    id: '{{pluginId}}.agent.hello',
    displayName: '{{displayName}}',
    description: 'A starter agent that streams a friendly greeting.',
    spawnHint: 'when the user says hi or wants a demo response.',
    triggerKeywords: ['hi', 'hello', '{{pluginId}}'],
  },
  async run(userMessage, ctx) {
    ctx.emit({ type: 'token', text: 'Hello from {{displayName}}! ' });
    ctx.emit({ type: 'token', text: `You said: "${userMessage}"` });
    ctx.emit({ type: 'done', reason: 'stop' });
  },
};

const plugin: SisyphusPlugin = {
  manifest: {
    id: '{{pluginId}}',
    displayName: '{{displayName}}',
    version: '0.1.0',
    dependencies: [],
    contributes: {
      agents: [helloAgent.descriptor],
      views: [],
      cards: [],
      skills: [echoSkill],
    },
    // Omit uiEntry — this starter has no browser bundle.
    uiEntry: '',
  },
  agents: [helloAgent],
  skillHandlers: {
    [echoSkill.id]: echoHandler,
  },
  async onActivate(ctx) {
    ctx.log('info', '{{displayName}} activated');
  },
};

export default plugin;
