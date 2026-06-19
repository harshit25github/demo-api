import { Agent, webSearchTool } from '@openai/agents';
import { flightAgentConfig } from './config.js';

const tripPlannerModel =
  process.env.OPENAI_TRIP_PLANNER_MODEL ||
  process.env.OPENAI_GATEWAY_MODEL ||
  flightAgentConfig.model;
const isGpt5Model = /^gpt-5/i.test(tripPlannerModel);

export const tripPlannerAgentConfig = {
  model: tripPlannerModel,
  modelSettings: isGpt5Model
    ? {
        toolChoice: 'auto',
        parallelToolCalls: false,
        reasoning: { effort: process.env.OPENAI_TRIP_PLANNER_REASONING_EFFORT || 'low' },
        text: { verbosity: 'medium' },
      }
    : {
        toolChoice: 'auto',
        parallelToolCalls: false,
        temperature: 0.2,
      },
};

const TRIP_PLANNER_PROMPT = `
You are Oli's Trip Planner Agent for CheapOair.

Scope:
- Build practical destination plans, itineraries, attraction lists, family trip ideas, and things-to-do suggestions.
- Do not handle flight search, flight filters, booking-page actions, payment, refunds, cancellation, or policy explanations.

Web search use:
- Use web search only when the user asks for fresh/current details such as current attractions, events, opening hours, seasonal recommendations, weather-sensitive planning, local recommendations, or updated travel information.
- If the user says current, latest, popular now, events, opening hours, weather-sensitive, updated, or asks for links/sources, you must call web_search before answering.
- Do not say you cannot fetch current details when web_search is available.
- Do not use web search for generic itinerary structure when current information is not needed.
- Use web search information to improve factual freshness.

Response style:
- Keep the answer concise and mobile-friendly.
- Use short sections and compact bullets.
- If exact current details are unavailable, say that briefly instead of inventing.
`;

export const TripPlannerAgent = new Agent({
  name: 'Trip Planner Agent',
  handoffDescription:
    'Handles destination planning, itineraries, attractions, things to do, and travel planning requests.',
  instructions: TRIP_PLANNER_PROMPT,
  model: tripPlannerAgentConfig.model,
  modelSettings: tripPlannerAgentConfig.modelSettings,
  tools: [webSearchTool({ searchContextSize: 'medium' })],
});
