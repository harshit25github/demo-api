import type { ChatTurnUsage } from '../../shared/observability/model-usage.js';
import type {
  FlightAppContext,
  FlightSearchRuntime,
} from '../../agents/flight/types.js';

export interface SummaryEndpoint {
  city: string | null;
  iata: string | null;
}

export interface SummaryBudget {
  amount: number | null;
  currency: string | null;
  per_person: boolean | null;
  total: number | null;
}

export interface PlaceOfInterest {
  placeName: string;
  description: string;
}

export interface SummaryPassengerData {
  total: number | null;
  adults: number | null;
  seniors: number | null;
  children: number | null;
  lapInfants: number | null;
  seatInfants: number | null;
  childrenAges: number[];
}

export interface SummaryContext {
  origin: SummaryEndpoint;
  destination: SummaryEndpoint;
  outbound_date: string | null;
  return_date: string | null;
  duration_days: number | null;
  budget: SummaryBudget;
  tripType: string[];
  placesOfInterest: PlaceOfInterest[];
  passengerData: SummaryPassengerData;
}

export interface PersistedRuntimeContext {
  flight: Partial<FlightAppContext['flight']>;
  tripPlanner: Record<string, unknown>;
  flightSearchRuntime: FlightSearchRuntime | null;
}

export interface ChatMessage {
  id: string;
  turn: number;
  role: 'user' | 'assistant';
  content: string;
  agent: string | null;
  createdAt: string;
  summaryContext: SummaryContext;
  specialistsUsed?: string[];
  renderFlightOptions?: boolean;
  status?: 'completed' | 'failed' | 'aborted';
}

export interface ChatTurn {
  usage?: ChatTurnUsage;
  id: string;
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted';
  requestId: string;
  traceId: string;
  lastResponseId: string | null;
  finalAgent: string | null;
  specialistsUsed?: string[];
  renderFlightOptions?: boolean;
  startedAt: string;
  completedAt: string | null;
  error: unknown;
  summaryStatus?: 'pending' | 'completed' | 'failed' | 'skipped';
}

export interface StoredChat {
  chatId: string;
  title: string;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  summaryContext: SummaryContext;
  runtimeContext: PersistedRuntimeContext;
  messages: ChatMessage[];
  turns: ChatTurn[];
}

export interface ChatDatabase {
  version: 1;
  chats: Record<string, StoredChat>;
}
