import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mcpRoutes from './routes/mcp.js';
import { mcpManager } from './services/mcp-manager.js';
import { cleanupOldSessions } from './services/database.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true,
}));

app.use(express.json());

app.use('/api/mcp', mcpRoutes);

app.get('/api/health', (_, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, async () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  
  // Cleanup old sessions
  cleanupOldSessions();
  
  // Try to reconnect saved connections
  await mcpManager.reconnectSavedConnections();
});
