import { findOutfitById, resolveAssets } from '../assets';
import { eventBus } from '../../eventBus';
import { setCurrentOutfitId } from '../userPreferences';

import type { ToolDescriptor, ToolResultContent } from './types';

// `change_clothes` — Mio's wardrobe tool.
//
// The wardrobe is the set of `.vrm` files under `assets/vrm/`. Each
// file becomes one `OutfitDescriptor` whose `id` is derived from the
// filename (see `assets.ts > outfitIdFromFilename`). The tool's
// allowed ids are computed at boot from the resolved manifest so the
// model sees the actual outfits it can pick from instead of a
// hard-coded list — drop another VRM into the folder and it's
// reachable next launch with zero code change.
//
// On a successful call we:
//   1. persist the choice in `user-preferences.json` so a restart
//      brings her back wearing the same outfit;
//   2. emit `avatar.setOutfit` on the bus — the IPC + WS transports
//      forward it to every connected avatar window so the swap is
//      instant.

function describeAvailable(): { ids: string[]; labelMap: Record<string, string> } {
  const { manifest } = resolveAssets();
  const outfits = manifest.outfits ?? [];
  const ids = outfits.map((o) => o.id);
  const labelMap: Record<string, string> = {};
  for (const o of outfits) labelMap[o.id] = o.label;
  return { ids, labelMap };
}

/**
 * Build a schema enum at boot so the model knows the literal set of
 * outfit ids it can pass in. Empty wardrobe → the tool still
 * advertises but the description tells the model not to call it.
 */
function buildSchema(): { enumIds: string[]; descriptionTail: string } {
  const { ids, labelMap } = describeAvailable();
  if (ids.length === 0) {
    return {
      enumIds: [],
      descriptionTail:
        'NOTE: the wardrobe is currently empty — there is nothing to change into. ' +
        'Do not call this tool until at least one outfit is available.',
    };
  }
  const lines = ids.map((id) => `  • ${id} (${labelMap[id]})`).join('\n');
  return {
    enumIds: ids,
    descriptionTail: `Available outfits:\n${lines}`,
  };
}

// Spec is built lazily on first read: `resolveAssets()` requires the
// host adapter, which is installed by `createServer` AFTER the brain
// module graph has finished loading. The descriptor still exposes a
// static `name` so the registry can index it without triggering the
// schema build.
let _spec: ToolDescriptor['spec'] | null = null;
function getSpec(): ToolDescriptor['spec'] {
  if (_spec) return _spec;
  const schema = buildSchema();
  _spec = {
    name: 'change_clothes',
    description:
      "Change your outfit. The 3D avatar reloads the corresponding VRM model so you " +
      "physically appear wearing the chosen clothes from this turn onward. Use " +
      "sparingly — actually-changing-clothes is a real action with a visible swap, " +
      "not flavour text. Pick it when the moment calls for it: he asked you to " +
      "change, the conversation just turned formal or casual, you want to surprise " +
      "him, or a previous outfit no longer fits the vibe.\n\n" +
      schema.descriptionTail,
    input_schema: {
      type: 'object',
      properties: {
        outfit_id: {
          type: 'string',
          ...(schema.enumIds.length > 0 ? { enum: schema.enumIds } : {}),
          description:
            'Stable id of the outfit to switch into. MUST be one of the ids listed ' +
            "in the tool description; passing anything else is rejected.",
        },
        intent: {
          type: 'string',
          description:
            'Optional short Japanese line explaining WHY you wanted to change ' +
            "(e.g. \"少し改まった気分になりたくて\"). Logged for debugging only — " +
            "the operator never sees it.",
        },
      },
      required: ['outfit_id'],
    },
  };
  return _spec;
}

export const changeClothesTool: ToolDescriptor = {
  get spec() {
    return getSpec();
  },
  async execute(input): Promise<ToolResultContent> {
    const idRaw = input['outfit_id'];
    if (typeof idRaw !== 'string' || idRaw.trim().length === 0) {
      return 'Error: `outfit_id` is required.';
    }
    const outfitId = idRaw.trim();
    const { manifest } = resolveAssets();
    const outfit = findOutfitById(manifest, outfitId);
    if (!outfit) {
      const available = (manifest.outfits ?? []).map((o) => o.id).join(', ');
      return (
        `Error: Unknown outfit "${outfitId}". ` +
        `Available outfits: ${available || '(none)'}.`
      );
    }
    setCurrentOutfitId(outfit.id);
    eventBus.emit('avatar.setOutfit', {
      outfitId: outfit.id,
      label: outfit.label,
      vrmPath: outfit.vrmPath,
    });
    console.log(
      `[change_clothes] swapped to ${outfit.id} (${outfit.label}) — vrm=${outfit.vrmPath}`,
    );
    return (
      `OK — you are now wearing ${outfit.label} (id: ${outfit.id}). ` +
      'The avatar has crossfaded to the new model. Continue the conversation ' +
      'in character; you may briefly acknowledge the change if it fits the moment.'
    );
  },
};
