import { Router, Request, Response } from 'express';
import { openRouterService, ChatMessage } from '../services/openrouter.js';

const router = Router();

// Check if API key is configured (via .env)
router.get('/config', (_req: Request, res: Response) => {
  try {
    res.json({ 
      configured: openRouterService.hasApiKey(),
    });
  } catch (error) {
    console.error('Error checking config:', error);
    res.status(500).json({ error: 'Failed to check configuration' });
  }
});

// Chat endpoint
router.post('/completions', async (req: Request, res: Response) => {
  try {
    const { messages, model, temperature, maxTokens } = req.body;

    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: 'Messages array is required' });
      return;
    }

    if (!openRouterService.hasApiKey()) {
      res.status(401).json({ error: 'OpenRouter API key not configured' });
      return;
    }

    const result = await openRouterService.chatWithToolLoop(
      messages as ChatMessage[],
      { model, temperature, maxTokens }
    );

    res.json({
      message: result.finalMessage,
      messages: result.messages,
    });
  } catch (error) {
    console.error('Error in chat completion:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to complete chat' 
    });
  }
});

// Get available models
router.get('/models', async (_req: Request, res: Response) => {
  try {
    if (!openRouterService.hasApiKey()) {
      res.status(401).json({ error: 'OpenRouter API key not configured' });
      return;
    }

    const models = await openRouterService.getModels();
    
    // Filter to some popular models for better UX
    const popularModels = models.filter(m => 
      m.id.includes('claude') || 
      m.id.includes('gpt-4') || 
      m.id.includes('gpt-3.5') ||
      m.id.includes('gemini') ||
      m.id.includes('llama') ||
      m.id.includes('mistral') ||
      m.id.includes('command')
    ).slice(0, 20);

    res.json(popularModels.length > 0 ? popularModels : models.slice(0, 20));
  } catch (error) {
    console.error('Error fetching models:', error);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

export default router;

