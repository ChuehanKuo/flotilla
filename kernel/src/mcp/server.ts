import type { Server as HttpServer } from 'node:http';
import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { KernelApi } from '../tools/coordination.js';
import { TokenStore } from './tokens.js';

export interface McpNodeContext {
  nodeId: string;
  role: 'captain' | 'crew';
  api: KernelApi;
  taskId: string;
  // WHY optional, used-when-present: v0.3's fleet is a fixed two-tier
  // hierarchy (kernel.ts spawns the captain with the literal nodeId
  // 'captain'; every crew node's parent is that captain, and crew is
  // role-gated off delegate so it can never grow a third tier), so role
  // alone is ALREADY sufficient to address upward correctly today —
  // upstream() below falls back to that inference when parentId is absent
  // (every existing caller/test). When the real caller (kernel.ts) supplies
  // it, addressing is correct by construction instead of by relying on that
  // gate holding.
  parentId?: string;
}

type ToolResult = { content: [{ type: 'text'; text: string }] };

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function roleError(tool: string): ToolResult {
  return textResult(`error: ${tool} is not available to this role`);
}

// WHY parentId first, role-inference as fallback: see McpNodeContext's
// parentId doc comment above.
function upstream(ctx: McpNodeContext): string {
  return ctx.parentId ?? (ctx.role === 'captain' ? 'operator' : 'captain');
}

function makeNodeServer(ctx: McpNodeContext): McpServer {
  const server = new McpServer({ name: 'flota', version: '0.3.0' });

  server.registerTool(
    'delegate',
    {
      title: 'Delegate',
      description: 'Spawn a crew agent to work a subtask in parallel. Returns immediately; results arrive later as DELIVER messages.',
      inputSchema: {
        role: z.string().describe('short role name, e.g. metrics-scan'),
        charter: z.string().describe("the crew agent's role instructions"),
        task: z.string().describe('the concrete task order'),
      },
    },
    async ({ role, charter, task }) => {
      if (ctx.role !== 'captain') return roleError('delegate');
      const result = ctx.api.delegate(ctx.nodeId, { role, charter, task });
      return textResult(result);
    },
  );

  server.registerTool(
    'report',
    {
      title: 'Report',
      description: 'Report interim progress upward without ending your task.',
      inputSchema: { text: z.string() },
    },
    async ({ text }) => {
      if (ctx.role !== 'crew') return roleError('report');
      ctx.api.emitMessage({ kind: 'REPORT', from: ctx.nodeId, to: upstream(ctx), taskId: ctx.taskId, text });
      return textResult('reported');
    },
  );

  server.registerTool(
    'deliver',
    {
      title: 'Deliver',
      description: 'Deliver your finished work product for your current task. Ends your task.',
      inputSchema: { text: z.string().describe('the complete work product') },
    },
    async ({ text }) => {
      ctx.api.emitMessage({ kind: 'DELIVER', from: ctx.nodeId, to: upstream(ctx), taskId: ctx.taskId, text });
      return textResult('delivered');
    },
  );

  server.registerTool(
    'escalate',
    {
      title: 'Escalate',
      description: 'Escalate a decision you cannot make yourself. Pauses your task until answered.',
      inputSchema: { question: z.string() },
    },
    async ({ question }) => {
      ctx.api.emitMessage({ kind: 'ESCALATE', from: ctx.nodeId, to: upstream(ctx), taskId: ctx.taskId, text: question });
      return textResult('escalated — you will be woken when answered');
    },
  );

  server.registerTool(
    'answer',
    {
      title: 'Answer',
      description: 'Answer an escalation from one of your crew, resuming their task.',
      inputSchema: { taskId: z.string(), text: z.string() },
    },
    async ({ taskId, text }) => {
      if (ctx.role !== 'captain') return roleError('answer');
      ctx.api.emitMessage({ kind: 'ANSWER', from: ctx.nodeId, to: '', taskId, text });
      return textResult('answered');
    },
  );

  return server;
}

export class FlotaMcpServer {
  private tokens = new TokenStore<McpNodeContext>();
  private app = express();
  private httpServer?: HttpServer;
  private wantStop = false;

  constructor() {
    // WHY 10mb: deliver carries a node's complete work product (a code file or
    // long report); express.json()'s 100kb default would 413 those before the
    // route runs, surfacing to the agent as an opaque transport failure.
    this.app.use(express.json({ limit: '10mb' }));
    this.app.post('/mcp', async (req, res) => {
      // WHY the try/catch: a rejected connect/handleRequest (e.g. a
      // write-after-disconnect race) would otherwise be an unhandled rejection
      // that terminates the in-process kernel — taking the whole mission down.
      try {
        await this.handlePost(req, res);
      } catch {
        if (!res.headersSent) res.status(500).json({ error: 'internal' });
        else res.destroy();
      }
    });
  }

  registerNode(ctx: McpNodeContext): string {
    return this.tokens.issue(ctx.nodeId, ctx);
  }

  unregisterNode(nodeId: string): void {
    this.tokens.revoke(nodeId);
  }

  private async handlePost(req: Request, res: Response): Promise<void> {
    const auth = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    const ctx = match ? this.tokens.resolve(match[1]) : undefined;
    if (!ctx) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // Stateless mode (per the SDK's own doc comment, confirmed in the spike):
    // a fresh McpServer + transport per request, closed when the response
    // ends. The tool handlers registered on `server` close over this
    // request's resolved node ctx, which is how a stateless transport still
    // gets per-node routing.
    const server = makeNodeServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  start(): Promise<{ url: string; port: number }> {
    return new Promise((resolve) => {
      const srv = this.app.listen(0, '127.0.0.1', () => {
        // WHY honour a stop() that raced ahead of 'listening': a caller can
        // stop()/cancel() synchronously in the same tick as start() (e.g.
        // Mission.cancel() right after Mission.start()), before this callback
        // fires. stop() below can't close a not-yet-listening server, so it
        // sets wantStop; we close here the instant we ARE listening. The
        // start() promise still resolves so the caller's `await` unblocks
        // (then sees mission.done and bails) instead of hanging forever.
        const addr = srv.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        if (this.wantStop) srv.close();
        resolve({ url: `http://127.0.0.1:${port}/mcp`, port });
      });
      this.httpServer = srv;
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      // WHY the listening guard: http.Server.close() called before the
      // 'listening' event never invokes its callback with success and can
      // suppress 'listening' entirely — the close would hang. Defer to the
      // start() callback (via wantStop) when we're mid-bind.
      if (!this.httpServer.listening) {
        this.wantStop = true;
        resolve();
        return;
      }
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
