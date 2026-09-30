import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JsonChatStore } from './store.js';
import { streamChatTurn } from './orchestrator.js';
import { SseWriter } from './sse.js';
import type { StoredChat } from './types.js';

type HttpError = Error & { statusCode?: number };
type StaticFile = readonly [filePath: string, contentType: string];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(__dirname, '../../../public/chat-dashboard');
const staticFiles = new Map<string, StaticFile>([
  ['/', [path.join(publicDirectory, 'index.html'), 'text/html; charset=utf-8']],
  ['/app.js', [path.join(publicDirectory, 'app.js'), 'text/javascript; charset=utf-8']],
  [
    '/flightContracts.js',
    [path.join(publicDirectory, 'flightContracts.js'), 'text/javascript; charset=utf-8'],
  ],
  ['/styles.css', [path.join(publicDirectory, 'styles.css'), 'text/css; charset=utf-8']],
  [
    '/vendor/lucide.js',
    [path.resolve(__dirname, '../../../node_modules/lucide/dist/umd/lucide.min.js'), 'text/javascript; charset=utf-8'],
  ],
]);

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJsonBody(
  request: http.IncomingMessage,
  { limit = 32_768 }: { limit?: number } = {},
): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) {
      const error = new Error('Request body is too large.') as HttpError;
      error.statusCode = 413;
      throw error;
    }
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    const error = new Error('Request body must be valid JSON.') as HttpError;
    error.statusCode = 400;
    throw error;
  }
}

function validTimeZone(value: unknown): string {
  if (!value) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const timeZone = String(value);
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return timeZone;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

async function serveStatic(
  response: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const target = staticFiles.get(pathname);
  if (!target) return false;
  const [filePath, contentType] = target;
  await access(filePath);
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(response);
  return true;
}

function chatIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/chats\/([0-9a-f-]{36})$/i);
  return match?.[1] || null;
}

export function publicChat(chat: StoredChat): Omit<StoredChat, 'turns'> & { turns: Omit<StoredChat['turns'][number], 'usage'>[] } {
  return { ...chat, turns: chat.turns.map(({ usage: _usage, ...turn }) => turn) };
}

export function createChatServer({
  store = new JsonChatStore(),
  runTurn = streamChatTurn,
}: {
  store?: JsonChatStore;
  runTurn?: typeof streamChatTurn;
} = {}): http.Server {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/chats') {
        return sendJson(response, 200, { chats: store.listChats() });
      }
      if (request.method === 'GET') {
        const chatId = chatIdFromPath(url.pathname);
        if (chatId) {
          const chat = store.getChat(chatId);
          return chat
            ? sendJson(response, 200, { chat: publicChat(chat) })
            : sendJson(response, 404, { error: 'CHAT_NOT_FOUND' });
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/chat/stream') {
        const body = await readJsonBody(request);
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) {
          return sendJson(response, 400, { error: 'MESSAGE_REQUIRED' });
        }

        let chat: StoredChat | null = null;
        let isNewChat = false;
        if (typeof body.chatId === 'string') {
          chat = store.getChat(body.chatId);
          if (!chat) return sendJson(response, 404, { error: 'CHAT_NOT_FOUND' });
        } else {
          chat = await store.createChat({ title: message.slice(0, 60) });
          isNewChat = true;
        }

        const releaseTurn = store.acquireTurn(chat!.chatId);
        if (!releaseTurn) {
          return sendJson(response, 409, { error: 'CHAT_BUSY' });
        }

        const writer = new SseWriter(response);
        writer.start();
        void runTurn({
          store,
          writer,
          response,
          chat: chat!,
          isNewChat,
          releaseTurn,
          message,
          timeZone: validTimeZone(body.timeZone),
        });
        return;
      }
      if (request.method === 'GET' && (await serveStatic(response, url.pathname))) {
        return;
      }
      sendJson(response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const value = error as HttpError;
      if (!response.headersSent) {
        sendJson(response, value.statusCode || 500, {
          error: value.statusCode ? value.message : 'INTERNAL_SERVER_ERROR',
        });
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  });
}

export async function startChatServer({
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST || '127.0.0.1',
  store = new JsonChatStore(),
}: {
  port?: number;
  host?: string;
  store?: JsonChatStore;
} = {}) {
  await store.init();
  const server = createChatServer({ store });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return { server, store, url: `http://${host}:${port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startChatServer();
  console.log(`Gateway chat dashboard: ${url}`);
}
