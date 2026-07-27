import { requestPermission } from '../permissions/gate';
import { asString, type ToolDescriptor } from '../tools/types';
import { runComputerUseSession } from './session';

// The `start_computer_use` tool.

export const computerUseToolDescriptor: ToolDescriptor = {
  spec: {
    name: 'start_computer_use',
    description:
      'Take visual control of the Windows desktop — look at the screen and ' +
      'click / type — to operate GUI applications. Use this only for tasks the ' +
      'file, web, and browser tools cannot do. Describe the COMPLETE task in ' +
      '`task`; the session runs autonomously until done. The operator must ' +
      'approve the session before it starts.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The full task to carry out on the desktop, start to finish.',
        },
      },
      required: ['task'],
    },
  },
  async execute(input, ctx) {
    const task = asString(input['task']);
    if (!task) return 'Error: `task` is required.';

    const gate = await requestPermission({
      tool: 'start_computer_use',
      title: 'Mio wants to control your screen',
      summary: 'Start a computer-use session',
      preview: task,
      previewKind: 'text',
      scopeKey: 'session',
      allowAlways: false,
      taskId: ctx.taskId,
    });
    if (!gate.allowed) return `Denied: ${gate.reason}`;

    return runComputerUseSession(task, ctx);
  },
};
