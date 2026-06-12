import { FlightSearchTool } from './flightSearchTool.js';
import { ApplyFilterTool } from './applyFilterTool.js';

export { ApplyFilterTool } from './applyFilterTool.js';
export { FlightSearchTool } from './flightSearchTool.js';

// Agent registration stays centralized here so agent.js imports one stable list.
export const flightTools = [FlightSearchTool, ApplyFilterTool];
