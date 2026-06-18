import { FlightSearchTool } from './flightSearchTool.js';
import { ApplyFilterTool } from './applyFilterTool.js';
import { GetGeneratedContractsContextTool } from './getGeneratedContractsContextTool.js';

export { ApplyFilterTool } from './applyFilterTool.js';
export { FlightSearchTool } from './flightSearchTool.js';
export { GetGeneratedContractsContextTool } from './getGeneratedContractsContextTool.js';

// Agent registration stays centralized here so agent.js imports one stable list.
export const flightTools = [
  FlightSearchTool,
  GetGeneratedContractsContextTool,
  ApplyFilterTool,
];
