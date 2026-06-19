import { Agent, handoff } from '@openai/agents';
import { flightAgentConfig } from './config.js';
import { FlightAgent } from './flightAgent.js';
import { GATEWAY_PROMPT } from './instructions.js';
import { TripPlannerAgent } from './tripPlannerAgent.js';

const gatewayModel = process.env.OPENAI_GATEWAY_MODEL || flightAgentConfig.model;
const isGpt5Model = /^gpt-5/i.test(gatewayModel);

export const gatewayAgentConfig = {
  model: gatewayModel,
  modelSettings: isGpt5Model
    ? {
        toolChoice: 'auto',
        parallelToolCalls: false,
        reasoning: { effort: process.env.OPENAI_GATEWAY_REASONING_EFFORT || 'low' },
        text: { verbosity: 'low' },
      }
    : {
        toolChoice: 'auto',
        parallelToolCalls: false,
        temperature: 0,
      },
};

function recordGatewayHandoff(runContext, selectedAgent, source, handoffToolName) {
  const context = runContext.context;
  context.gatewaySelections ||= [];
  context.gatewaySelections.push({
    selectedAgent,
    source,
    handoffToolName,
    selectedAt: new Date().toISOString(),
  });

  console.log('GATEWAY_HANDOFF_OCCURRED', selectedAgent, handoffToolName);
}

function createDummySpecialist(name, handoffDescription) {
  return new Agent({
    name,
    handoffDescription,
    instructions: `You are ${name}. This is a routing smoke-test specialist. Return one short sentence confirming ${name} was selected. Do not answer the user's domain question.`,
    model: gatewayAgentConfig.model,
    modelSettings: gatewayAgentConfig.modelSettings,
  });
}

export const PolicyHelperAgent = createDummySpecialist(
  'Policy Helper Agent',
  'Handles CheapOair, airline, baggage allowance, cancellation, refund, fare-rule, and support policy questions.',
);

export const PageSpecificAgent = createDummySpecialist(
  'Page Specific Agent',
  'Handles CheapOAir page workflows, selected/current booking contract questions, payment, review, seat, passenger, checkout, and add-on flows.',
);

export const gatewayHandoffs = [
  handoff(FlightAgent, {
    toolNameOverride: 'transfer_to_flight_specialist',
    toolDescriptionOverride:
      'Handoff to Flight Agent for flight search, result filtering, current flight-result/contract reasoning, cheapest/best/compare current options, airline filters, baggage filters on results, and route/date/passenger/cabin changes.',
    onHandoff(runContext) {
      recordGatewayHandoff(
        runContext,
        'Flight Agent',
        FlightAgent.name,
        'transfer_to_flight_specialist',
      );
    },
  }),
  handoff(TripPlannerAgent, {
    toolNameOverride: 'transfer_to_trip_planner',
    toolDescriptionOverride:
      'Handoff to Trip Planner Agent for destination planning, itineraries, attractions, and travel ideas.',
    onHandoff(runContext) {
      recordGatewayHandoff(
        runContext,
        'Trip Planner Agent',
        TripPlannerAgent.name,
        'transfer_to_trip_planner',
      );
    },
  }),
  handoff(PolicyHelperAgent, {
    toolNameOverride: 'transfer_to_policy_helper',
    toolDescriptionOverride:
      'Handoff to Policy Helper Agent for general CheapOair, airline, cancellation, refund, baggage policy, fare-rule, and support-policy questions.',
    onHandoff(runContext) {
      recordGatewayHandoff(
        runContext,
        'Policy Helper Agent',
        PolicyHelperAgent.name,
        'transfer_to_policy_helper',
      );
    },
  }),
  handoff(PageSpecificAgent, {
    toolNameOverride: 'transfer_to_page_specific_agent',
    toolDescriptionOverride:
      'Handoff to Page Specific Agent for selected/current booking contract questions and review, payment, seat, passenger, checkout, account, and add-on page flows.',
    onHandoff(runContext) {
      recordGatewayHandoff(
        runContext,
        'Page Specific Agent',
        PageSpecificAgent.name,
        'transfer_to_page_specific_agent',
      );
    },
  }),
];

export const GatewayAgent = Agent.create({
  name: 'GatewayAgent',
  instructions: GATEWAY_PROMPT,
  model: gatewayAgentConfig.model,
  modelSettings: gatewayAgentConfig.modelSettings,
  handoffs: gatewayHandoffs,
});
