import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { v4 as uuidv4 } from 'uuid';
import {
  createOAuthClientProvider,
  deleteOAuthSession,
  clearAuthorizationUrl,
} from './oauth-provider.js';
import { mcpDb } from './database.js';

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPConnection {
  id: string;
  url: string;
  name: string;
  status: 'connected' | 'disconnected' | 'error' | 'pending_auth';
  tools: MCPTool[];
  client: Client;
  transport: SSEClientTransport | StreamableHTTPClientTransport;
}

export interface ConnectResult {
  connection?: Omit<MCPConnection, 'client' | 'transport'>;
  needsAuth: boolean;
  authorizationUrl?: string;
  connectionId?: string;
}

// Store pending connections waiting for OAuth
const pendingConnections = new Map<string, {
  url: string;
  name: string;
  transport: SSEClientTransport | StreamableHTTPClientTransport;
  client: Client;
  authProvider: ReturnType<typeof createOAuthClientProvider>;
}>();

class MCPManager {
  private connections: Map<string, MCPConnection> = new Map();

  private getRedirectUrl(): string {
    const baseUrl = process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:5173';
    return `${baseUrl}/oauth/callback`;
  }

  /**
   * Try to reconnect to saved connections on startup
   */
  async reconnectSavedConnections(): Promise<void> {
    const savedConnections = mcpDb.getAll();
    
    if (savedConnections.length === 0) {
      console.log('📭 No saved connections to restore');
      return;
    }

    console.log(`🔄 Attempting to reconnect ${savedConnections.length} saved connections...`);

    for (const saved of savedConnections) {
      try {
        console.log(`🔌 Reconnecting to ${saved.name} (${saved.url})...`);
        await this.reconnect(saved.id, saved.url, saved.name);
      } catch (error) {
        console.log(`⚠️ Could not reconnect to ${saved.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        mcpDb.updateStatus(saved.id, 'disconnected');
      }
    }
  }

  /**
   * Reconnect to a saved connection using existing OAuth tokens
   */
  private async reconnect(id: string, url: string, name: string): Promise<void> {
    const redirectUrl = this.getRedirectUrl();
    const authProvider = createOAuthClientProvider(id, redirectUrl);

    // Check if we have tokens
    const tokens = authProvider.tokens();
    if (!tokens) {
      console.log(`   No tokens found for ${name}, skipping`);
      mcpDb.updateStatus(id, 'disconnected');
      return;
    }

    // Create transport
    let transport: SSEClientTransport | StreamableHTTPClientTransport;
    try {
      transport = new StreamableHTTPClientTransport(new URL(url), { authProvider });
    } catch {
      transport = new SSEClientTransport(new URL(url), { authProvider });
    }

    const client = new Client(
      { name: 'trampoai-client', version: '1.0.0' },
      { capabilities: {} }
    );

    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools: MCPTool[] = toolsResult.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));

    const connection: MCPConnection = {
      id,
      url,
      name,
      status: 'connected',
      tools,
      client,
      transport,
    };

    this.connections.set(id, connection);
    mcpDb.updateStatus(id, 'connected');
    console.log(`   ✅ Reconnected to ${name} (${tools.length} tools)`);
  }

  async connect(url: string, name?: string): Promise<ConnectResult> {
    const id = uuidv4();
    const redirectUrl = this.getRedirectUrl();
    const authProvider = createOAuthClientProvider(id, redirectUrl);

    // Create transport - prefer StreamableHTTP, fall back to SSE
    let transport: SSEClientTransport | StreamableHTTPClientTransport;
    let useSSE = false;
    
    try {
      transport = new StreamableHTTPClientTransport(new URL(url), {
        authProvider,
      });
      console.log(`🔌 Using StreamableHTTP transport for ${url}`);
    } catch {
      // Fall back to SSE transport
      transport = new SSEClientTransport(new URL(url), {
        authProvider,
      });
      useSSE = true;
      console.log(`🔌 Using SSE transport for ${url}`);
    }

    const client = new Client(
      { name: 'trampoai-client', version: '1.0.0' },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);

      const toolsResult = await client.listTools();
      const tools: MCPTool[] = toolsResult.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));

      const connectionName = name || new URL(url).hostname;
      const connection: MCPConnection = {
        id,
        url,
        name: connectionName,
        status: 'connected',
        tools,
        client,
        transport,
      };

      this.connections.set(id, connection);
      
      // Save to database for persistence
      mcpDb.upsert(id, url, connectionName, 'connected');
      
      console.log(`✅ Connected to MCP: ${connection.name} (${tools.length} tools)`);

      return {
        connection: {
          id: connection.id,
          url: connection.url,
          name: connection.name,
          status: connection.status,
          tools: connection.tools,
        },
        needsAuth: false,
      };
    } catch (error) {
      console.log(`⚠️ Connection error for ${url}:`, error instanceof Error ? error.message : error);
      
      // Check if this is an OAuth required error
      if (error instanceof UnauthorizedError) {
        const authorizationUrl = authProvider.getAuthorizationUrl();
        
        console.log(`🔐 UnauthorizedError caught. Authorization URL: ${authorizationUrl || 'NOT FOUND'}`);
        
        if (authorizationUrl) {
          console.log(`🔐 OAuth required for ${url}`);
          console.log(`📋 Authorization URL: ${authorizationUrl}`);
          
          const connectionName = name || new URL(url).hostname;
          
          // Save as pending in database
          mcpDb.upsert(id, url, connectionName, 'pending_auth');
          
          // Create a fresh transport for the retry
          const retryTransport = useSSE 
            ? new SSEClientTransport(new URL(url), { authProvider })
            : new StreamableHTTPClientTransport(new URL(url), { authProvider });
          
          const retryClient = new Client(
            { name: 'trampoai-client', version: '1.0.0' },
            { capabilities: {} }
          );
          
          pendingConnections.set(id, {
            url,
            name: connectionName,
            transport: retryTransport,
            client: retryClient,
            authProvider,
          });

          clearAuthorizationUrl(id);

          return {
            needsAuth: true,
            authorizationUrl,
            connectionId: id,
          };
        } else {
          console.log(`❌ UnauthorizedError but no authorization URL was captured`);
          console.log(`   This might mean the server didn't return a proper WWW-Authenticate header`);
        }
      }

      console.error(`❌ Failed to connect to MCP at ${url}:`, error);
      deleteOAuthSession(id);
      mcpDb.delete(id);
      throw new Error(`Failed to connect to MCP server: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async completeOAuthConnection(connectionId: string, authorizationCode: string): Promise<ConnectResult> {
    const pending = pendingConnections.get(connectionId);
    
    if (!pending) {
      throw new Error(`No pending connection found for ID: ${connectionId}`);
    }

    try {
      console.log(`🔑 Completing OAuth for connection ${connectionId}`);
      console.log(`📋 Authorization code received: ${authorizationCode.substring(0, 10)}...`);
      
      // Complete the OAuth flow with the authorization code
      await pending.transport.finishAuth(authorizationCode);
      console.log(`✅ finishAuth completed successfully`);
      
      // Now try to connect again
      await pending.client.connect(pending.transport);
      console.log(`✅ Client connected after OAuth`);

      const toolsResult = await pending.client.listTools();
      const tools: MCPTool[] = toolsResult.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));

      const connection: MCPConnection = {
        id: connectionId,
        url: pending.url,
        name: pending.name,
        status: 'connected',
        tools,
        client: pending.client,
        transport: pending.transport,
      };

      this.connections.set(connectionId, connection);
      pendingConnections.delete(connectionId);
      
      // Update status in database
      mcpDb.updateStatus(connectionId, 'connected');

      console.log(`✅ OAuth complete! Connected to MCP: ${connection.name} (${tools.length} tools)`);

      return {
        connection: {
          id: connection.id,
          url: connection.url,
          name: connection.name,
          status: connection.status,
          tools: connection.tools,
        },
        needsAuth: false,
      };
    } catch (error) {
      console.error(`❌ Failed to complete OAuth for connection ${connectionId}:`, error);
      pendingConnections.delete(connectionId);
      deleteOAuthSession(connectionId);
      mcpDb.delete(connectionId);
      throw new Error(`Failed to complete OAuth: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async disconnect(id: string): Promise<boolean> {
    const connection = this.connections.get(id);
    const pending = pendingConnections.get(id);

    if (!connection && !pending) {
      return false;
    }

    try {
      if (connection) {
        await connection.client.close();
        this.connections.delete(id);
        console.log(`🔌 Disconnected from MCP: ${connection.name}`);
      }
      
      if (pending) {
        pendingConnections.delete(id);
      }
      
      deleteOAuthSession(id);
      mcpDb.delete(id);
      return true;
    } catch (error) {
      console.error(`Error disconnecting from MCP ${id}:`, error);
      this.connections.delete(id);
      pendingConnections.delete(id);
      deleteOAuthSession(id);
      mcpDb.delete(id);
      return true;
    }
  }

  getConnections(): Omit<MCPConnection, 'client' | 'transport'>[] {
    return Array.from(this.connections.values()).map(({ client, transport, ...rest }) => rest);
  }

  getPendingConnections(): { id: string; url: string; name: string; status: 'pending_auth' }[] {
    return Array.from(pendingConnections.entries()).map(([id, pending]) => ({
      id,
      url: pending.url,
      name: pending.name,
      status: 'pending_auth' as const,
    }));
  }

  getConnection(id: string): MCPConnection | undefined {
    return this.connections.get(id);
  }

  getAllTools(): { connectionId: string; connectionName: string; tool: MCPTool }[] {
    const allTools: { connectionId: string; connectionName: string; tool: MCPTool }[] = [];

    for (const connection of this.connections.values()) {
      for (const tool of connection.tools) {
        allTools.push({
          connectionId: connection.id,
          connectionName: connection.name,
          tool,
        });
      }
    }

    return allTools;
  }

  async callTool(connectionId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`MCP connection not found: ${connectionId}`);
    }

    try {
      const result = await connection.client.callTool({ name: toolName, arguments: args });
      return result;
    } catch (error) {
      console.error(`Error calling tool ${toolName}:`, error);
      throw new Error(`Failed to call tool ${toolName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  findToolConnection(toolName: string): { connectionId: string; tool: MCPTool } | undefined {
    for (const connection of this.connections.values()) {
      const tool = connection.tools.find((t) => t.name === toolName);
      if (tool) {
        return { connectionId: connection.id, tool };
      }
    }
    return undefined;
  }
}

export const mcpManager = new MCPManager();
