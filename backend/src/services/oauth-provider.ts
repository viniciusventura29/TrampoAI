import { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { oauthDb } from './database.js';

export interface OAuthSession {
  tokens?: OAuthTokens;
  codeVerifier?: string;
  clientInfo?: OAuthClientInformationMixed;
  authorizationUrl?: string;
  state?: string;
}

/**
 * Creates an OAuth client provider for a specific MCP connection.
 * This provider handles the OAuth flow when connecting to MCP servers that require authentication.
 * Now uses SQLite for persistence!
 */
export function createOAuthClientProvider(
  connectionId: string,
  redirectUrl: string
): OAuthClientProvider & { getAuthorizationUrl: () => string | undefined } {
  console.log(`🔧 Creating OAuth provider for connection ${connectionId}`);
  console.log(`   Redirect URL: ${redirectUrl}`);

  // Helper to get session from DB
  const getSession = (): OAuthSession => {
    const row = oauthDb.get(connectionId);
    if (!row) return {};
    
    return {
      tokens: row.tokens ? JSON.parse(row.tokens) : undefined,
      codeVerifier: row.code_verifier || undefined,
      clientInfo: row.client_info ? JSON.parse(row.client_info) : undefined,
      authorizationUrl: row.authorization_url || undefined,
      state: row.state || undefined,
    };
  };

  return {
    get redirectUrl() {
      console.log(`📍 [${connectionId}] redirectUrl getter called, returning: ${redirectUrl}`);
      return redirectUrl;
    },

    get clientMetadata(): OAuthClientMetadata {
      const metadata: OAuthClientMetadata = {
        redirect_uris: [new URL(redirectUrl)],
        client_name: 'TrampoAI',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none', // Public client
      };
      console.log(`📋 [${connectionId}] clientMetadata getter called`);
      return metadata;
    },

    state(): string {
      const state = crypto.randomUUID();
      console.log(`🎲 [${connectionId}] state() called, generated: ${state}`);
      oauthDb.upsert(connectionId, { state });
      return state;
    },

    clientInformation(): OAuthClientInformationMixed | undefined {
      const session = getSession();
      console.log(`🏢 [${connectionId}] clientInformation() called, returning: ${session.clientInfo ? 'exists' : 'undefined'}`);
      return session.clientInfo;
    },

    saveClientInformation(clientInfo: OAuthClientInformationMixed): void {
      console.log(`💾 [${connectionId}] saveClientInformation() called`);
      oauthDb.upsert(connectionId, { client_info: JSON.stringify(clientInfo) });
    },

    tokens(): OAuthTokens | undefined {
      const session = getSession();
      console.log(`🎫 [${connectionId}] tokens() called, returning: ${session.tokens ? 'tokens exist' : 'undefined'}`);
      return session.tokens;
    },

    saveTokens(tokens: OAuthTokens): void {
      console.log(`💾 [${connectionId}] saveTokens() called`);
      console.log(`   access_token: ${tokens.access_token?.substring(0, 20)}...`);
      console.log(`   token_type: ${tokens.token_type}`);
      console.log(`   expires_in: ${tokens.expires_in}`);
      console.log(`   refresh_token: ${tokens.refresh_token ? 'present' : 'none'}`);
      oauthDb.upsert(connectionId, { tokens: JSON.stringify(tokens) });
    },

    redirectToAuthorization(authorizationUrl: URL): void {
      console.log(`🔐 [${connectionId}] redirectToAuthorization() called!`);
      console.log(`🔗 Authorization URL: ${authorizationUrl.toString()}`);
      oauthDb.upsert(connectionId, { authorization_url: authorizationUrl.toString() });
    },

    saveCodeVerifier(codeVerifier: string): void {
      console.log(`🔒 [${connectionId}] saveCodeVerifier() called: ${codeVerifier.substring(0, 20)}...`);
      oauthDb.upsert(connectionId, { code_verifier: codeVerifier });
    },

    codeVerifier(): string {
      const session = getSession();
      console.log(`🔑 [${connectionId}] codeVerifier() called, returning: ${session.codeVerifier ? session.codeVerifier.substring(0, 20) + '...' : 'NOT FOUND'}`);
      if (!session.codeVerifier) {
        throw new Error('No code verifier found');
      }
      return session.codeVerifier;
    },

    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): void {
      console.log(`🗑️ [${connectionId}] invalidateCredentials() called with scope: ${scope}`);
      
      if (scope === 'all') {
        oauthDb.delete(connectionId);
      } else if (scope === 'tokens') {
        oauthDb.clearTokens(connectionId);
      } else if (scope === 'verifier') {
        oauthDb.clearCodeVerifier(connectionId);
      } else if (scope === 'client') {
        oauthDb.clearClientInfo(connectionId);
      }
    },

    // Custom method to get the authorization URL after redirect
    getAuthorizationUrl(): string | undefined {
      const session = getSession();
      console.log(`📤 [${connectionId}] getAuthorizationUrl() called, returning: ${session.authorizationUrl ? 'URL exists' : 'NOT FOUND'}`);
      return session.authorizationUrl;
    },
  };
}

/**
 * Get the OAuth session for a connection
 */
export function getOAuthSession(connectionId: string): OAuthSession | undefined {
  const row = oauthDb.get(connectionId);
  if (!row) return undefined;
  
  return {
    tokens: row.tokens ? JSON.parse(row.tokens) : undefined,
    codeVerifier: row.code_verifier || undefined,
    clientInfo: row.client_info ? JSON.parse(row.client_info) : undefined,
    authorizationUrl: row.authorization_url || undefined,
    state: row.state || undefined,
  };
}

/**
 * Clear the authorization URL after it's been sent to the client
 */
export function clearAuthorizationUrl(connectionId: string): void {
  oauthDb.clearAuthorizationUrl(connectionId);
}

/**
 * Delete the OAuth session for a connection
 */
export function deleteOAuthSession(connectionId: string): void {
  oauthDb.delete(connectionId);
}
