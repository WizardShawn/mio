import type { Tool } from '@anthropic-ai/sdk/resources/messages';

import { computerUseToolDescriptor } from '../computerUse/tool';
import { getComfyUiPrefs } from '../userPreferences';
import { browserToolDescriptors } from './browserTool';
import { changeClothesTool } from './changeClothes';
import { fileToolDescriptors } from './fileTools';
import { generateImageTool } from './generateImage';
import { shellToolDescriptor } from './shellTool';
import { webToolDescriptors } from './webTools';
import type { ToolDescriptor } from './types';

const DESCRIPTORS: ToolDescriptor[] = [
  ...fileToolDescriptors,
  ...webToolDescriptors,
  shellToolDescriptor,
  ...browserToolDescriptors,
  computerUseToolDescriptor,
  generateImageTool,
  changeClothesTool,
];

// Lazy so we don't dereference `d.spec` at module-import time —
// `changeClothesTool.spec` is a getter that needs the installed host
// adapter to resolve the outfit manifest, and the host isn't installed
// until `createServer` runs after the brain module graph loads.
let _byName: Map<string, ToolDescriptor> | null = null;
function byName(): Map<string, ToolDescriptor> {
  return (_byName ??= new Map(DESCRIPTORS.map((d) => [d.spec.name, d])));
}

function comfyUiImageToolEnabled(): boolean {
  return getComfyUiPrefs().enabled;
}

export const CYCLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'generate_image',
]);

export function toolSpecs(): Tool[] {
  const drawOk = comfyUiImageToolEnabled();
  return DESCRIPTORS.filter(
    (d) => d.spec.name !== 'generate_image' || drawOk,
  ).map((d) => d.spec);
}

export function cycleToolSpecs(): Tool[] {
  const drawOk = comfyUiImageToolEnabled();
  return DESCRIPTORS.filter(
    (d) =>
      CYCLE_TOOL_NAMES.has(d.spec.name) &&
      (d.spec.name !== 'generate_image' || drawOk),
  ).map((d) => d.spec);
}

export function getToolDescriptor(name: string): ToolDescriptor | undefined {
  return byName().get(name);
}
