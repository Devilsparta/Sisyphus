/**
 * current-time skill — trivial demo of the skill dispatch loop.
 *
 * Returns server-side timestamp + a formatted ISO string. Used by the
 * time-helper agent below to exercise the full tool_call / tool_result
 * round-trip end to end.
 */
import type { SkillDescriptor, SkillHandler } from '@sisylabs/kernel';

export const currentTimeSkill: SkillDescriptor = {
  id: 'plugin-base.skill.current-time',
  schema: {
    type: 'function',
    function: {
      name: 'current_time',
      description:
        'Returns the current server time as ISO-8601 and unix timestamp.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
};

export const currentTimeHandler: SkillHandler = async () => {
  const now = new Date();
  return {
    iso: now.toISOString(),
    unix: now.getTime(),
  };
};
