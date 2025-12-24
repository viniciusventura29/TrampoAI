import { Router, Request, Response } from 'express';
import { mcpManager } from '../services/mcp-manager.js';

const router = Router();

router.post('/connect', async (req: Request, res: Response) => {
  try {
    const { url, name } = req.body;

    if (!url) {
      res.status(400).json({ error: 'URL is required' });
      return;
    }

    const result = await mcpManager.connect(url, name);

    if (result.needsAuth) {
      res.json({
        needsAuth: true,
        authorizationUrl: result.authorizationUrl,
        connectionId: result.connectionId,
      });
      return;
    }

    res.json({
      needsAuth: false,
      id: result.connection?.id,
      url: result.connection?.url,
      name: result.connection?.name,
      status: result.connection?.status,
      tools: result.connection?.tools,
    });
  } catch (error) {
    console.error('Error connecting to MCP:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to connect to MCP server',
    });
  }
});

router.post('/oauth/callback', async (req: Request, res: Response) => {
  try {
    const { connectionId, code } = req.body;

    if (!connectionId || !code) {
      res.status(400).json({ error: 'connectionId and code are required' });
      return;
    }

    const result = await mcpManager.completeOAuthConnection(connectionId, code);

    res.json({
      needsAuth: false,
      id: result.connection?.id,
      url: result.connection?.url,
      name: result.connection?.name,
      status: result.connection?.status,
      tools: result.connection?.tools,
    });
  } catch (error) {
    console.error('Error completing OAuth:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to complete OAuth',
    });
  }
});

router.get('/connections', (_req: Request, res: Response) => {
  try {
    const connections = mcpManager.getConnections();
    const pending = mcpManager.getPendingConnections();
    res.json([...connections, ...pending]);
  } catch (error) {
    console.error('Error getting connections:', error);
    res.status(500).json({ error: 'Failed to get connections' });
  }
});

router.delete('/connections/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const success = await mcpManager.disconnect(id);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Connection not found' });
    }
  } catch (error) {
    console.error('Error disconnecting:', error);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

router.get('/tools', (_req: Request, res: Response) => {
  try {
    const tools = mcpManager.getAllTools();
    res.json(tools);
  } catch (error) {
    console.error('Error getting tools:', error);
    res.status(500).json({ error: 'Failed to get tools' });
  }
});

export default router;
