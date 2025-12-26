import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mcpRoutes from './routes/mcp.js';
import chatRoutes from './routes/chat.js';
import { mcpManager } from './services/mcp-manager.js';
import { cleanupOldSessions } from './services/database.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true,
}));

// Increase body size limit for large conversation histories
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use('/api/mcp', mcpRoutes);
app.use('/api/chat', chatRoutes);

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
