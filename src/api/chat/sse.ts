import type { ServerResponse } from 'node:http';

export class SseWriter {
  private readonly response: ServerResponse;
  private sequence = 0;
  private closed = false;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(response: ServerResponse) {
    this.response = response;
    this.sequence = 0;
    this.closed = false;
    this.heartbeat = null;
  }

  start(): void {
    this.response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.response.flushHeaders?.();
    this.heartbeat = setInterval(() => {
      if (!this.closed) this.response.write(': heartbeat\n\n');
    }, 15_000);
  }

  send(event: string, data: unknown): boolean {
    if (this.closed || this.response.destroyed) return false;
    this.sequence += 1;
    this.response.write(`id: ${this.sequence}\n`);
    this.response.write(`event: ${event}\n`);
    this.response.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (!this.response.destroyed) this.response.end();
  }
}
