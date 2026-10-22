import { generateTraceId } from '@openai/agents';
import type { Session } from '@openai/agents';
import { OpenAIConversationsSession } from '@openai/agents-openai';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { runGatewayAgent } from '../../agents/manager-orchestrator/runner.js';
import { createClientSummary } from '../../agents/trip-planner-v2/client-summary.js';
import { log } from '../../shared/logging/logger.js';
import { hydrateGatewayContext, snapshotGatewayContext } from './context-hydration.js';
import type { JsonChatStore } from './store.js';
import type { SseWriter } from './sse.js';
import type { StoredChat } from './types.js';
import type { FlightAppContext } from '../../agents/flight/types.js';
import type { PlaceMark } from '../../shared/text/place-marks.js';

type ErrorLike = Error & { code?: string };
interface GatewayResult {
  output: string;
  places?: PlaceMark[];
  finalAgentName: string | null;
  lastResponseId: string | null;
  context: FlightAppContext;
}

interface StreamChatTurnOptions {
  store: JsonChatStore;
  writer: SseWriter;
  response: ServerResponse;
  chat: StoredChat;
  isNewChat: boolean;
  releaseTurn: () => void;
  message: string;
  timeZone: string;
  maxTurns?: number;
  stream?: boolean;
  now?: Date;
  createConversationSession?: (options: {
    conversationId?: string;
  }) => OpenAIConversationsSession;
  runGateway?: (options: Record<string, any>) => Promise<GatewayResult>;
}

function errorDetails(error: unknown) {
  const value = error as ErrorLike;
  return {
    name: value?.name || 'Error',
    code: value?.code || null,
    message: value?.message || 'The request could not be completed.',
  };
}

function clientErrorMessage(error: unknown) {
  if ((error as ErrorLike)?.name === 'AbortError') return 'The request was cancelled.';
  return 'The request could not be completed. Please try again.';
}

// A Manager turn saves far fewer items; the cap only bounds a walk-back gone wrong.
const MAX_CANCELLED_TURN_ITEMS = 100;

/**
 * Removes a cancelled turn from the conversation. The SDK saves the turn's message and finished
 * steps when a run is cancelled, while the chat keeps the state from before the turn, so the next
 * turn's history could show a change that was never kept. A finished reply on top means the turn
 * saved nothing.
 */
async function removeCancelledTurn(session: Session): Promise<number> {
  const [newest] = (await session.getItems(1)) as { type?: string; role?: string }[];
  if (!newest || (newest.type === 'message' && newest.role === 'assistant')) return 0;
  let removed = 0;
  while (removed < MAX_CANCELLED_TURN_ITEMS) {
    const item = (await session.popItem()) as { role?: string } | undefined;
    if (!item) break;
    removed += 1;
    if (item.role === 'user') break;
  }
  return removed;
}

export async function streamChatTurn({
  store,
  writer,
  response,
  chat,
  isNewChat,
  releaseTurn,
  message,
  timeZone,
  maxTurns,
  stream = false,
  now,
  createConversationSession = (options) => new OpenAIConversationsSession(options),
  runGateway = runGatewayAgent as unknown as StreamChatTurnOptions['runGateway'],
}: StreamChatTurnOptions): Promise<void> {
  const turnId = randomUUID();
  const requestId = randomUUID();
  const traceId = generateTraceId();
  const turnNow = now ?? new Date();
  const startedAt = turnNow.toISOString();
  const previousSummary = structuredClone(chat.summaryContext);
  const abortController = new AbortController();
  let gatewayContext: FlightAppContext | null = null;
  let conversationSession: Session | null = null;
  let draftText = '';
  let finished = false;

  const onClose = () => {
    if (!finished) abortController.abort();
  };
  response.once('close', onClose);

  try {
    if (isNewChat) {
      writer.send('chat.created', { chatId: chat.chatId });
    }

    const session = createConversationSession({
      conversationId: chat.conversationId || undefined,
    });
    conversationSession = session;
    const conversationId = await session.getSessionId();
    if (conversationId !== chat.conversationId) {
      const updatedChat = await store.updateChat(chat.chatId, (record) => {
        record.conversationId = conversationId;
      });
      if (updatedChat) chat = updatedChat;
    }

    writer.send('conversation.ready', {
      chatId: chat.chatId,
      conversationId,
    });

    const turnNumber = chat.turns.length + 1;
    const userMessageId = randomUUID();
    const chatWithTurn = await store.updateChat(chat.chatId, (record) => {
      record.messages.push({
        id: userMessageId,
        turn: turnNumber,
        role: 'user',
        content: message,
        agent: null,
        status: 'completed',
        createdAt: startedAt,
        summaryContext: structuredClone(previousSummary),
      });
      record.turns.push({
        id: turnId,
        status: 'running',
        requestId,
        traceId,
        lastResponseId: null,
        finalAgent: null,
        summaryStatus: 'skipped',
        startedAt,
        completedAt: null,
        error: null,
      });
    });
    if (chatWithTurn) chat = chatWithTurn;

    writer.send('turn.started', {
      chatId: chat.chatId,
      turnId,
      requestId,
      traceId,
    });

    let acknowledgement = '';
    // Kept so a failure after this point can still persist the turn's runtime
    // state: the run prepares this same object in place.
    const appContext = hydrateGatewayContext(chat.runtimeContext, previousSummary);
    gatewayContext = appContext;

    // SDK streaming can be requested internally, but only the sanitized final
    // Manager answer reaches SSE. Flight cards remain separate shared context.
    const gatewayResult = await runGateway!({
      input: message,
      requestId,
      traceId,
      sessionId: chat.chatId,
      context: appContext,
      session,
      signal: abortController.signal,
      maxTurns,
      stream,
      now: turnNow,
      timeZone,
      // The acknowledgement shows while the specialists work (plan 12.12, A1).
      onAcknowledgement: (text: string) => {
        acknowledgement = text;
        writer.send('acknowledgement', { chatId: chat.chatId, turnId, text });
      },
    });

    const finalText = gatewayResult.output;
    if (finalText) {
      draftText = finalText;
      writer.send('delta', { chatId: chat.chatId, turnId, text: finalText });
    }
    // The client summary Trip keeps, in the client's exact shape, ending with this turn's chips.
    const summary = createClientSummary(gatewayResult.context.summaryContext);
    const summaryStatus = 'skipped';

    const assistantMessageId = randomUUID();
    const completedAt = new Date().toISOString();
    const completedChat = await store.updateChat(chat.chatId, (record) => {
      record.summaryContext = structuredClone(summary);
      record.runtimeContext = snapshotGatewayContext(gatewayResult.context);
      record.messages.push({
        id: assistantMessageId,
        turn: turnNumber,
        role: 'assistant',
        content: finalText,
        places: gatewayResult.places ?? [],
        ...(acknowledgement ? { acknowledgement } : {}),
        agent: gatewayResult.finalAgentName,
        status: 'completed',
        createdAt: completedAt,
        summaryContext: structuredClone(summary),
      });
      const turn = record.turns.find((item) => item.id === turnId);
      if (!turn) throw new Error('Active chat turn was not found.');
      Object.assign(turn, {
        status: 'completed',
        lastResponseId: gatewayResult.lastResponseId,
        finalAgent: gatewayResult.finalAgentName,
        summaryStatus,
        completedAt,
      });
    });
    if (completedChat) chat = completedChat;

    writer.send('done', {
      chatId: chat.chatId,
      turnId,
      conversationId,
      finalAgent: gatewayResult.finalAgentName,
      finalText,
      // The client's two contexts; the chips it shows are summary.suggestedQuestions.
      summary,
      summaryStatus,
      flight: gatewayResult.context.flight,
      // Each place: reference in finalText, in order, with its kind and photo (plan 12.4).
      places: gatewayResult.places ?? [],
    });
  } catch (error) {
    const aborted = abortController.signal.aborted;
    // Only a run that started can have saved to the conversation.
    if (aborted && gatewayContext && conversationSession) {
      await removeCancelledTurn(conversationSession).catch((rollbackError: unknown) => {
        log('warn', 'chat.cancelled_turn_kept_in_conversation', { chatId: chat.chatId, turnId, error: errorDetails(rollbackError) });
      });
    }
    const completedAt = new Date().toISOString();
    await store.updateChat(chat.chatId, (record) => {
      if (gatewayContext) {
        // Flight's search state is kept, but Trip changes the traveler never saw are not.
        record.runtimeContext = {
          ...snapshotGatewayContext(gatewayContext),
          tripPlanner: structuredClone(record.runtimeContext?.tripPlanner ?? {}),
          summaryContext: structuredClone(record.runtimeContext?.summaryContext),
        };
      }
      if (draftText) {
        record.messages.push({
          id: randomUUID(),
          turn: record.turns.length,
          role: 'assistant',
          content: draftText,
          agent: null,
          status: aborted ? 'aborted' : 'failed',
          createdAt: completedAt,
          summaryContext: structuredClone(previousSummary),
        });
      }
      const turn = record.turns.find((item) => item.id === turnId);
      if (turn) {
        turn.status = aborted ? 'aborted' : 'failed';
        turn.summaryStatus = 'skipped';
        turn.completedAt = completedAt;
        turn.error = errorDetails(error);
      }
    });
    writer.send('error', {
      chatId: chat.chatId,
      turnId,
      code:
        aborted
          ? 'CLIENT_ABORTED'
          : (error as ErrorLike)?.code || 'CHAT_RUN_FAILED',
      message: clientErrorMessage(error),
    });
  } finally {
    finished = true;
    response.off('close', onClose);
    releaseTurn();
    writer.close();
  }
}
