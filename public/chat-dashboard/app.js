import { renderFlightContracts } from './flightContracts.js';

const state = {
  chatId: localStorage.getItem('gatewayChatId'),
  conversationId: null,
  summaryContext: {},
  flightContext: {},
  sending: false,
};

const elements = {
  shell: document.querySelector('.app-shell'),
  chatList: document.querySelector('#chatList'),
  messages: document.querySelector('#messages'),
  emptyState: document.querySelector('#emptyState'),
  composer: document.querySelector('#composer'),
  input: document.querySelector('#messageInput'),
  send: document.querySelector('#sendButton'),
  newChat: document.querySelector('#newChatButton'),
  chatTitle: document.querySelector('#chatTitle'),
  agentStatus: document.querySelector('#agentStatus'),
  debugChatId: document.querySelector('#debugChatId'),
  debugConversationId: document.querySelector('#debugConversationId'),
  summary: document.querySelector('#summaryContext'),
  debugPanel: document.querySelector('#debugPanel'),
};

function refreshIcons() {
  window.lucide?.createIcons();
}

function setStatus(text) {
  elements.agentStatus.textContent = text;
}

function setSending(value) {
  state.sending = value;
  elements.send.disabled = value;
  elements.newChat.disabled = value;
  elements.input.disabled = value;
}

function updateDebug() {
  elements.debugChatId.textContent = state.chatId || '-';
  elements.debugConversationId.textContent = state.conversationId || '-';
  elements.summary.textContent = JSON.stringify(state.summaryContext || {}, null, 2);
}

function clearMessages() {
  elements.messages.innerHTML = '';
}

function clearFlightContracts() {
  elements.messages.querySelectorAll('.flight-results').forEach((element) => element.remove());
}

function isFlightAgent(agent) {
  return /flight/i.test(String(agent || ''));
}

function shouldRenderFlightOptions(record) {
  return typeof record.renderFlightOptions === 'boolean'
    ? record.renderFlightOptions
    : isFlightAgent(record.agent ?? record.finalAgent);
}

function showEmpty() {
  if (!elements.messages.children.length) {
    elements.messages.append(elements.emptyState);
    elements.emptyState.hidden = false;
  }
}

function appendMessage(role, content = '', { agent = null, status = 'completed' } = {}) {
  elements.emptyState.remove();
  const article = document.createElement('article');
  article.className = `message ${role}${status === 'streaming' ? ' streaming' : ''}${status === 'failed' ? ' failed' : ''}`;
  const body = document.createElement('div');
  body.className = 'message-body';
  const text = document.createElement('div');
  text.className = 'message-text';
  text.textContent = content;
  body.append(text);
  if (agent) {
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = agent;
    body.append(meta);
  }
  article.append(body);
  elements.messages.append(article);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return { article, text, body };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}

async function loadChats() {
  const { chats } = await fetchJson('/api/chats');
  elements.chatList.innerHTML = '';
  for (const chat of chats) {
    const button = document.createElement('button');
    button.className = `chat-item${chat.chatId === state.chatId ? ' active' : ''}`;
    button.type = 'button';
    const title = document.createElement('strong');
    title.textContent = chat.title || 'New chat';
    const detail = document.createElement('span');
    detail.textContent = `${chat.messageCount} messages`;
    button.append(title, detail);
    button.addEventListener('click', () => loadChat(chat.chatId));
    elements.chatList.append(button);
  }
}

async function loadChat(chatId) {
  if (state.sending) return;
  const { chat } = await fetchJson(`/api/chats/${chatId}`);
  state.chatId = chat.chatId;
  state.conversationId = chat.conversationId;
  state.summaryContext = chat.summaryContext || {};
  state.flightContext = chat.runtimeContext?.flight || {};
  localStorage.setItem('gatewayChatId', chat.chatId);
  elements.chatTitle.textContent = chat.title || 'New chat';
  clearMessages();
  let latestFlightMessage = null;
  for (const message of chat.messages) {
    const rendered = appendMessage(message.role, message.content, {
      agent: message.agent,
      status: message.status === 'failed' ? 'failed' : 'completed',
    });
    if (message.role === 'assistant' && shouldRenderFlightOptions(message)) {
      latestFlightMessage = rendered;
    }
  }
  if (latestFlightMessage) {
    renderFlightContracts(latestFlightMessage.body, state.flightContext);
  }
  showEmpty();
  updateDebug();
  setStatus('Ready');
  elements.shell.classList.remove('sidebar-open');
  await loadChats();
}

function parseSseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  return { event, data: JSON.parse(data.join('\n')) };
}

async function consumeSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseBlock(block);
      if (parsed) onEvent(parsed.event, parsed.data);
    }
    if (done) break;
  }
}

async function sendMessage(message) {
  setSending(true);
  appendMessage('user', message);
  const draft = appendMessage('assistant', '', { status: 'streaming' });
  setStatus('Connecting');

  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        chatId: state.chatId || undefined,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.error || 'Request failed');
    }

    await consumeSse(response, (event, data) => {
      if (event === 'chat.created') {
        state.chatId = data.chatId;
        localStorage.setItem('gatewayChatId', data.chatId);
        elements.chatTitle.textContent = message.slice(0, 60);
      } else if (event === 'conversation.ready') {
        state.conversationId = data.conversationId;
        setStatus('Routing');
      } else if (event === 'turn.started') {
        setStatus('Thinking');
      } else if (event === 'delta') {
        draft.text.textContent += data.text;
        elements.messages.scrollTop = elements.messages.scrollHeight;
      } else if (event === 'summary.started') {
        setStatus('Updating context');
      } else if (event === 'status' && data.status === 'retrying') {
        setStatus('Retrying');
      } else if (event === 'done') {
        draft.text.textContent = data.finalText;
        draft.article.classList.remove('streaming');
        if (data.finalAgent) {
          let meta = draft.body.querySelector('.message-meta');
          if (!meta) {
            meta = document.createElement('div');
            meta.className = 'message-meta';
            draft.body.append(meta);
          }
          meta.textContent = data.finalAgent;
        }
        state.summaryContext = data.summaryContext || {};
        state.flightContext = data.flightContext || {};
        state.conversationId = data.conversationId;
        if (shouldRenderFlightOptions(data)) {
          clearFlightContracts();
          renderFlightContracts(draft.body, state.flightContext);
        }
        setStatus(data.summaryStatus === 'completed' ? 'Ready' : 'Ready, context unchanged');
      } else if (event === 'error') {
        draft.article.classList.remove('streaming');
        draft.article.classList.add('failed');
        draft.text.textContent ||= data.message;
        setStatus('Request failed');
      }
      updateDebug();
    });
  } catch (error) {
    draft.article.classList.remove('streaming');
    draft.article.classList.add('failed');
    draft.text.textContent ||= error.message;
    setStatus('Request failed');
  } finally {
    setSending(false);
    elements.input.focus();
    await loadChats().catch(() => {});
  }
}

elements.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = elements.input.value.trim();
  if (!message || state.sending) return;
  elements.input.value = '';
  elements.input.style.height = 'auto';
  void sendMessage(message);
});

elements.input.addEventListener('input', () => {
  elements.input.style.height = 'auto';
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 160)}px`;
});

elements.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.newChat.addEventListener('click', () => {
  if (state.sending) return;
  state.chatId = null;
  state.conversationId = null;
  state.summaryContext = {};
  state.flightContext = {};
  localStorage.removeItem('gatewayChatId');
  elements.chatTitle.textContent = 'New chat';
  clearMessages();
  showEmpty();
  updateDebug();
  setStatus('Ready');
  void loadChats();
});

document.querySelector('#toggleDebug').addEventListener('click', () => {
  elements.shell.classList.toggle('debug-open');
  elements.debugPanel.setAttribute('aria-hidden', String(!elements.shell.classList.contains('debug-open')));
});
document.querySelector('#closeDebug').addEventListener('click', () => elements.shell.classList.remove('debug-open'));
document.querySelector('#openSidebar').addEventListener('click', () => elements.shell.classList.add('sidebar-open'));
document.querySelector('#closeSidebar').addEventListener('click', () => elements.shell.classList.remove('sidebar-open'));
document.querySelector('#scrim').addEventListener('click', () => elements.shell.classList.remove('sidebar-open', 'debug-open'));

refreshIcons();
updateDebug();
showEmpty();
await loadChats();
if (state.chatId) {
  await loadChat(state.chatId).catch(() => {
    state.chatId = null;
    localStorage.removeItem('gatewayChatId');
  });
}
