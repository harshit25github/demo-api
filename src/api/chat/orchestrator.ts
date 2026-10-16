import { generateTraceId } from '@openai/agents';
import { OpenAIConversationsSession } from '@openai/agents-openai';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { runGatewayAgent } from '../../agents/manager-orchestrator/runner.js';
import { createClientSummary } from '../../agents/trip-planner-v2/client-summary.js';
import { tripPlannerV2Config } from '../../agents/trip-planner-v2/config.js';
import { hydrateGatewayContext, snapshotGatewayContext } from './context-hydration.js';
import type { JsonChatStore } from './store.js';
import type { SseWriter } from './sse.js';
import type { StoredChat } from './types.js';
import type { FlightAppContext } from '../../agents/flight/types.js';

type ErrorLike = Error & { code?: string };
interface GatewayResult {
  output: string;
  finalAgentName: string | null;
  lastResponseId: string | null;
  context: FlightAppContext;
  tripView?: unknown;
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
  /** Trip Planner v2 saves and returns the client summary Trip keeps. Defaults to the configured switch. */
  tripPlannerV2?: boolean;
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
  tripPlannerV2 = tripPlannerV2Config.enabled,
}: StreamChatTurnOptions): Promise<void> {
  const turnId = randomUUID();
  const requestId = randomUUID();
  const traceId = generateTraceId();
  const turnNow = now ?? new Date();
  const startedAt = turnNow.toISOString();
  const previousSummary = structuredClone(chat.summaryContext);
  const abortController = new AbortController();
  let gatewayContext: FlightAppContext | null = null;
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

    const conversationSession = createConversationSession({
      conversationId: chat.conversationId || undefined,
    });
    const conversationId = await conversationSession.getSessionId();
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

    // Kept so a failure after this point can still persist the turn's runtime
    // state: the run prepares this same object in place.
    const appContext = hydrateGatewayContext(chat.runtimeContext, previousSummary, { tripPlannerV2 });
    gatewayContext = appContext;

    // SDK streaming can be requested internally, but only the sanitized final
    // Manager answer reaches SSE. Flight cards remain separate shared context.
    const gatewayResult = await runGateway!({
      input: message,
      requestId,
      traceId,
      sessionId: chat.chatId,
      context: appContext,
      session: conversationSession,
      signal: abortController.signal,
      maxTurns,
      stream,
      now: turnNow,
      timeZone,
    });

    const finalText = gatewayResult.output;
    if (finalText) {
      draftText = finalText;
      writer.send('delta', { chatId: chat.chatId, turnId, text: finalText });
    }
    // v1 leaves the client summary unchanged; v2 returns the one Trip keeps, in the client's shape.
    const summaryContext = tripPlannerV2
      ? createClientSummary(gatewayResult.context.summaryContext)
      : previousSummary;
    const summaryStatus = 'skipped';

    const assistantMessageId = randomUUID();
    const completedAt = new Date().toISOString();
    const completedChat = await store.updateChat(chat.chatId, (record) => {
      record.summaryContext = structuredClone(summaryContext);
      record.runtimeContext = snapshotGatewayContext(gatewayResult.context);
      record.messages.push({
        id: assistantMessageId,
        turn: turnNumber,
        role: 'assistant',
        content: finalText,
        agent: gatewayResult.finalAgentName,
        status: 'completed',
        createdAt: completedAt,
        summaryContext: structuredClone(summaryContext),
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
      summaryContext,
      summaryStatus,
      flightContext: gatewayResult.context.flight,
      ...(tripPlannerV2
        ? {
            tripContext: {
              suggestedQuestions: [...((gatewayResult.context.tripPlanner as Record<string, any> | undefined)?.suggestions ?? [])],
              view: gatewayResult.tripView ?? null,
            },
          }
        : {}),
    });
  } catch (error) {
    const aborted = abortController.signal.aborted;
    const completedAt = new Date().toISOString();
    await store.updateChat(chat.chatId, (record) => {
      if (gatewayContext) {
        record.runtimeContext = snapshotGatewayContext(gatewayContext);
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
