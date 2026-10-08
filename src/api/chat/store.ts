import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEmptySummaryContext } from './context-hydration.js';
import type { ChatDatabase, StoredChat } from './types.js';

function nowIso() {
  return new Date().toISOString();
}

export class JsonChatStore {
  readonly filePath: string;
  private data: ChatDatabase;
  private writeQueue: Promise<void>;
  private readonly activeChats: Set<string>;

  constructor({ filePath = path.resolve('data/chats.json') }: { filePath?: string } = {}) {
    this.filePath = filePath;
    this.data = { version: 1, chats: {} };
    this.writeQueue = Promise.resolve();
    this.activeChats = new Set();
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ChatDatabase;
      if (parsed?.version !== 1 || !parsed.chats || typeof parsed.chats !== 'object') {
        throw new Error('Unsupported chats.json structure.');
      }
      this.data = parsed;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        await this.#persist();
        return this;
      }
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      await rename(this.filePath, backup).catch(() => {});
      throw new Error(`Chat store is invalid. Preserved the file at ${backup}.`, {
        cause: error,
      });
    }

    let changed = false;
    for (const chat of Object.values(this.data.chats)) {
      for (const turn of chat.turns || []) {
        if (turn.status === 'running') {
          turn.status = 'interrupted';
          turn.completedAt = nowIso();
          changed = true;
        }
      }
    }
    if (changed) await this.#persist();
    return this;
  }

  listChats() {
    return Object.values(this.data.chats)
      .map((chat) => ({
        chatId: chat.chatId,
        title: chat.title,
        conversationId: chat.conversationId,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        messageCount: chat.messages.length,
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getChat(chatId: string): StoredChat | null {
    const chat = this.data.chats[chatId];
    return chat ? structuredClone(chat) : null;
  }

  async createChat({ title = 'New chat' }: { title?: string } = {}): Promise<StoredChat> {
    const chatId = randomUUID();
    const timestamp = nowIso();
    const chat: StoredChat = {
      chatId,
      title,
      conversationId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      summaryContext: createEmptySummaryContext(),
      runtimeContext: {
        flight: {},
        tripPlanner: {},
        flightSearchRuntime: null,
      },
      messages: [],
      turns: [],
    };
    this.data.chats[chatId] = chat;
    await this.#persist();
    return structuredClone(chat);
  }

  async updateChat(
    chatId: string,
    updater: (chat: StoredChat) => void | Promise<void>,
  ): Promise<StoredChat | null> {
    const chat = this.data.chats[chatId];
    if (!chat) return null;
    await updater(chat);
    chat.updatedAt = nowIso();
    await this.#persist();
    return structuredClone(chat);
  }

  acquireTurn(chatId: string): (() => void) | null {
    if (this.activeChats.has(chatId)) return null;
    this.activeChats.add(chatId);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeChats.delete(chatId);
      }
    };
  }

  async #persist(): Promise<void> {
    const operation = async () => {
      const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, this.filePath);
    };
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }
}
