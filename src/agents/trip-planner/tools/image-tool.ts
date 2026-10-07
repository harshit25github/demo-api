import { tool } from '@openai/agents';
import { z } from 'zod';
import {
  getTripPlannerContext,
  getTripPlannerState,
  recordToolCall,
  TRIP_PLANNER_TOOL_NAMES,
} from './runtime.js';

const DUMMY_PLACE_IMAGES: Record<string, string> = {
  PAR: 'https://images.example.test/paris.jpg',
  LON: 'https://images.example.test/london.jpg',
  ROM: 'https://images.example.test/rome.jpg',
  TYO: 'https://images.example.test/tokyo.jpg',
  DXB: 'https://images.example.test/dubai.jpg',
  DPS: 'https://images.example.test/bali.jpg',
  NYC: 'https://images.example.test/new-york.jpg',
};

const getPlaceImagesBatchSchema = z.object({
  itemCodes: z
    .array(z.string().length(3))
    .min(1)
    .max(6)
    .describe('One batch of 3-letter destination city codes.'),
});

export const GetPlaceImagesBatchTool = tool({
  name: TRIP_PLANNER_TOOL_NAMES.getPlaceImagesBatch,
  description:
    'Return hardcoded dummy image URLs for destination codes absent from trip_state image_asset. Previously returned assets are cached in Trip Planner context.',
  parameters: getPlaceImagesBatchSchema,
  strict: true,
  isEnabled: ({ runContext }) => {
    const state = getTripPlannerContext(runContext).tripPlanner;
    return (
      state?.turnState?.contextCaptured === true &&
      state?.scopeClassification?.mode !== 'excluded' &&
      ['call', 'call_after_selecting_suggestions'].includes(
        state?.planningBrief?.toolStrategy?.images?.action,
      )
    );
  },
  execute(input, runContext) {
    const state = getTripPlannerState(runContext);
    state.placeImageCache ||= {};
    const images = input.itemCodes.map((rawCode) => {
      const itemCode = rawCode.toUpperCase();
      const cached = state.placeImageCache[itemCode];
      if (cached?.imageUrl) {
        return { ...cached, cached: true };
      }

      const image = {
        itemCode,
        imageUrl:
          DUMMY_PLACE_IMAGES[itemCode] ||
          `https://images.example.test/fallback-${itemCode.toLowerCase()}.jpg`,
        isFallback: !DUMMY_PLACE_IMAGES[itemCode],
        cached: false,
      };
      state.placeImageCache[itemCode] = image;
      return image;
    });
    const output = {
      ok: true,
      status: 'SUCCESS',
      images,
      cached: images.every((image) => image.cached),
      isDummy: true,
    };
    return recordToolCall(
      runContext,
      TRIP_PLANNER_TOOL_NAMES.getPlaceImagesBatch,
      input,
      output,
    );
  },
});
