import { MemorySession } from '@openai/agents';
import type { AgentInputItem, Session } from '@openai/agents';

const DEFAULT_MAX_USER_TURNS = 4;
const DEFAULT_MAX_ESTIMATED_TOKENS = 12_000;
type StandaloneConversationMessage = AgentInputItem & {
  role: 'user' | 'assistant';
  content: unknown[];
};

function isConversationMessage(item: any): boolean {
  return (
    item &&
    (item.role === 'user' || item.role === 'assistant') &&
    (!item.type || item.type === 'message')
  );
}

function estimatedItemTokens(item: AgentInputItem): number {
  return Math.ceil(JSON.stringify(item).length / 4);
}

function standaloneConversationMessage(item: any): StandaloneConversationMessage {
  const content = Array.isArray(item.content)
    ? item.content
        .map((part: any) =>
          typeof part === 'string' ? part : part?.text || part?.content || '',
        )
        .filter(Boolean)
        .join('\n')
    : String(item.content || '');
  if (item.role === 'assistant') {
    return {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: content }],
    } as StandaloneConversationMessage;
  }
  return {
    role: 'user',
    content: [{ type: 'input_text', text: content }],
  } as StandaloneConversationMessage;
}

export function trimTripPlannerSessionItems(
  items: AgentInputItem[] = [],
  {
    maxUserTurns = DEFAULT_MAX_USER_TURNS,
    maxEstimatedTokens = DEFAULT_MAX_ESTIMATED_TOKENS,
  } = {},
): AgentInputItem[] {
  const messages = items
    .filter(isConversationMessage)
    .map(standaloneConversationMessage)
    .filter((item) => item.content);
  const turns: AgentInputItem[][] = [];
  for (const item of messages) {
    if (item.role === 'user') {
      turns.push([item]);
    } else if (turns.length > 0) {
      turns.at(-1)!.push(item);
    }
  }

  const keptTurns = turns.slice(-maxUserTurns);
  while (
    keptTurns.length > 1 &&
    keptTurns
      .flat()
      .reduce((sum, item) => sum + estimatedItemTokens(item), 0) >
      maxEstimatedTokens
  ) {
    keptTurns.shift();
  }
  return keptTurns.flat();
}

export class BoundedTripPlannerMemorySession extends MemorySession {
  readonly maxUserTurns: number;
  readonly maxEstimatedTokens: number;

  constructor({
    sessionId,
    maxUserTurns = DEFAULT_MAX_USER_TURNS,
    maxEstimatedTokens = DEFAULT_MAX_ESTIMATED_TOKENS,
  }: {
    sessionId?: string;
    maxUserTurns?: number;
    maxEstimatedTokens?: number;
  } = {}) {
    super({ sessionId });
    this.maxUserTurns = maxUserTurns;
    this.maxEstimatedTokens = maxEstimatedTokens;
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    const existing = await super.getItems();
    const bounded = trimTripPlannerSessionItems([...existing, ...items], {
      maxUserTurns: this.maxUserTurns,
      maxEstimatedTokens: this.maxEstimatedTokens,
    });
    await super.clearSession();
    await super.addItems(bounded);
  }
}

let persistentSessionFactory: ((sessionId: string) => Session) | null = null;

export function configureTripPlannerSessionFactory(
  factory: ((sessionId: string) => Session) | null,
): void {
  if (factory !== null && typeof factory !== 'function') {
    throw new TypeError('Trip Planner session factory must be a function or null.');
  }
  persistentSessionFactory = factory;
}

export function createTripPlannerSession(sessionId: string): Session {
  if (persistentSessionFactory) {
    return persistentSessionFactory(sessionId);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Configure a persistent Trip Planner session factory before running in production.',
    );
  }
  return new BoundedTripPlannerMemorySession({ sessionId });
}
