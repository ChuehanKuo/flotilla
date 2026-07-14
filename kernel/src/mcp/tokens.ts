import { randomBytes } from 'node:crypto';

// Per-node opaque bearer tokens for the in-process MCP server. One token per
// registered node; re-registering a nodeId revokes its prior token so a
// node can never be reached through a stale credential.
export class TokenStore<T> {
  private byToken = new Map<string, T>();
  private byNode = new Map<string, string>();

  issue(nodeId: string, value: T): string {
    this.revoke(nodeId);
    const token = randomBytes(24).toString('hex');
    this.byToken.set(token, value);
    this.byNode.set(nodeId, token);
    return token;
  }

  revoke(nodeId: string): void {
    const token = this.byNode.get(nodeId);
    if (token === undefined) return;
    this.byToken.delete(token);
    this.byNode.delete(nodeId);
  }

  resolve(token: string): T | undefined {
    return this.byToken.get(token);
  }
}
