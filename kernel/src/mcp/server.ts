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
}

type ToolResult = { content: [{ type: 'text'; text: string }] };

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function roleError(tool: string): ToolResult {
  return textResult(`error: ${tool} is not available to this role`);
}

// WHY 'to' is derived from role rather than carried on McpNodeContext: v0.3's
// fleet is a fixed two-tier hierarchy (kernel.ts spawns the captain with the
// literal nodeId 'captain'; every crew node's parent is that captain). The
// brief's McpNodeContext intentionally has no parentId field — role alone is
// enough to address upward: captain -> operator, crew -> captain.
function upstream(ctx: McpNodeContext): string {
  return ctx.role === 'captain' ? 'operator' : 'captain';
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

  constructor() {
    this.app.use(express.json());
    this.app.post('/mcp', (req, res) => {
      void this.handlePost(req, res);
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
      this.httpServer = this.app.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve({ url: `http://127.0.0.1:${port}/mcp`, port });
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
