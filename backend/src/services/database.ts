import { Database } from 'bun:sqlite';
import path from 'path';

// Database file path
const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'trampoai.db');

// Ensure data directory exists
import fs from 'fs';
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Create database connection
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.exec('PRAGMA journal_mode = WAL;');

// Initialize tables
db.exec(`
  -- OAuth Sessions table
  CREATE TABLE IF NOT EXISTS oauth_sessions (
    connection_id TEXT PRIMARY KEY,
    tokens TEXT,
    code_verifier TEXT,
    client_info TEXT,
    authorization_url TEXT,
    state TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );

  -- MCP Connections table (for reconnection after restart)
  CREATE TABLE IF NOT EXISTS mcp_connections (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'disconnected',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );

  -- Create index for faster lookups
  CREATE INDEX IF NOT EXISTS idx_oauth_sessions_updated ON oauth_sessions(updated_at);
  CREATE INDEX IF NOT EXISTS idx_mcp_connections_status ON mcp_connections(status);
`);

console.log(`📦 Database initialized at ${DB_PATH}`);

// OAuth Session functions
export interface OAuthSessionRow {
  connection_id: string;
  tokens: string | null;
  code_verifier: string | null;
  client_info: string | null;
  authorization_url: string | null;
  state: string | null;
  created_at: number;
  updated_at: number;
}

export interface MCPConnectionRow {
  id: string;
  url: string;
  name: string;
  status: string;
  created_at: number;
  updated_at: number;
}

// Prepared statements for better performance
const getOAuthSession = db.prepare<OAuthSessionRow, [string]>(
  'SELECT * FROM oauth_sessions WHERE connection_id = ?'
);

const upsertOAuthSession = db.prepare(`
  INSERT INTO oauth_sessions (connection_id, tokens, code_verifier, client_info, authorization_url, state, updated_at)
  VALUES ($connection_id, $tokens, $code_verifier, $client_info, $authorization_url, $state, unixepoch())
  ON CONFLICT(connection_id) DO UPDATE SET
    tokens = COALESCE($tokens, tokens),
    code_verifier = COALESCE($code_verifier, code_verifier),
    client_info = COALESCE($client_info, client_info),
    authorization_url = $authorization_url,
    state = COALESCE($state, state),
    updated_at = unixepoch()
`);

const deleteOAuthSessionStmt = db.prepare('DELETE FROM oauth_sessions WHERE connection_id = ?');

// MCP Connection statements
const getMCPConnection = db.prepare<MCPConnectionRow, [string]>(
  'SELECT * FROM mcp_connections WHERE id = ?'
);

const getAllMCPConnections = db.prepare<MCPConnectionRow, []>(
  'SELECT * FROM mcp_connections ORDER BY updated_at DESC'
);

const upsertMCPConnection = db.prepare(`
  INSERT INTO mcp_connections (id, url, name, status, updated_at)
  VALUES ($id, $url, $name, $status, unixepoch())
  ON CONFLICT(id) DO UPDATE SET
    url = $url,
    name = $name,
    status = $status,
    updated_at = unixepoch()
`);

const deleteMCPConnectionStmt = db.prepare('DELETE FROM mcp_connections WHERE id = ?');

const updateMCPConnectionStatus = db.prepare(`
  UPDATE mcp_connections SET status = ?, updated_at = unixepoch() WHERE id = ?
`);

// Export database functions
export const oauthDb = {
  get(connectionId: string): OAuthSessionRow | null {
    return getOAuthSession.get(connectionId) || null;
  },

  upsert(connectionId: string, data: {
    tokens?: string;
    code_verifier?: string;
    client_info?: string;
    authorization_url?: string | null;
    state?: string;
  }): void {
    upsertOAuthSession.run({
      $connection_id: connectionId,
      $tokens: data.tokens ?? null,
      $code_verifier: data.code_verifier ?? null,
      $client_info: data.client_info ?? null,
      $authorization_url: data.authorization_url ?? null,
      $state: data.state ?? null,
    });
  },

  delete(connectionId: string): void {
    deleteOAuthSessionStmt.run(connectionId);
  },

  clearTokens(connectionId: string): void {
    db.prepare('UPDATE oauth_sessions SET tokens = NULL, updated_at = unixepoch() WHERE connection_id = ?').run(connectionId);
  },

  clearCodeVerifier(connectionId: string): void {
    db.prepare('UPDATE oauth_sessions SET code_verifier = NULL, updated_at = unixepoch() WHERE connection_id = ?').run(connectionId);
  },

  clearClientInfo(connectionId: string): void {
    db.prepare('UPDATE oauth_sessions SET client_info = NULL, updated_at = unixepoch() WHERE connection_id = ?').run(connectionId);
  },

  clearAuthorizationUrl(connectionId: string): void {
    db.prepare('UPDATE oauth_sessions SET authorization_url = NULL, updated_at = unixepoch() WHERE connection_id = ?').run(connectionId);
  },
};

export const mcpDb = {
  get(id: string): MCPConnectionRow | null {
    return getMCPConnection.get(id) || null;
  },

  getAll(): MCPConnectionRow[] {
    return getAllMCPConnections.all();
  },

  upsert(id: string, url: string, name: string, status: string): void {
    upsertMCPConnection.run({
      $id: id,
      $url: url,
      $name: name,
      $status: status,
    });
  },

  delete(id: string): void {
    deleteMCPConnectionStmt.run(id);
  },

  updateStatus(id: string, status: string): void {
    updateMCPConnectionStatus.run(status, id);
  },
};

// Cleanup old sessions (older than 24 hours)
export function cleanupOldSessions(): void {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  db.prepare('DELETE FROM oauth_sessions WHERE updated_at < ?').run(oneDayAgo);
  console.log('🧹 Cleaned up old OAuth sessions');
}

// Close database on process exit
process.on('beforeExit', () => {
  db.close();
});

export default db;

