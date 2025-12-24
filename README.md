# TrampoAI - MCP Chat Interface

Uma aplicação web para conectar a MCP (Model Context Protocol) servers e interagir com eles através de um chat alimentado pelo Claude.

## Funcionalidades

- **Conectar MCP Servers**: Adicione qualquer MCP server via URL SSE
- **Chat com Claude**: Converse naturalmente e o Claude usará as tools disponíveis
- **Visualizar Tools**: Veja todas as tools disponíveis de cada MCP conectado
- **Execução Automática**: O Claude identifica e executa tools automaticamente
- **Interface Moderna**: Design escuro com visual clean e responsivo

## Arquitetura

```
Frontend (React + Vite) ←→ Backend (Express) ←→ MCP Servers
                                    ↓
                            Anthropic API (Claude)
```

## Requisitos

- Node.js 18+
- npm ou yarn
- Chave de API do Anthropic

## Setup

### 1. Backend

```bash
cd backend
npm install

# Criar arquivo .env com sua API key
echo "ANTHROPIC_API_KEY=sua_chave_aqui" > .env
echo "PORT=3001" >> .env

# Rodar em desenvolvimento
npm run dev
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

### 3. Acessar

Abra http://localhost:5173 no navegador.

## Como Usar

1. **Conectar um MCP**: Na barra lateral, adicione a URL SSE do seu MCP server
2. **Ver Tools**: Clique na aba "Tools" para ver as tools disponíveis
3. **Conversar**: Use o chat para pedir tarefas - o Claude usará as tools automaticamente

## Exemplo de MCP Server

Se você não tem um MCP server, pode usar o [MCP Inspector](https://github.com/modelcontextprotocol/inspector) para testar:

```bash
npx @modelcontextprotocol/inspector
```

## Estrutura do Projeto

```
TrampoAI/
├── frontend/           # React + Vite + TypeScript
│   ├── src/
│   │   ├── components/ # Componentes React
│   │   ├── hooks/      # Custom hooks
│   │   └── services/   # API calls
│   └── ...
├── backend/            # Express + TypeScript
│   ├── src/
│   │   ├── routes/     # API routes
│   │   └── services/   # MCP & Claude logic
│   └── ...
└── README.md
```

## Tecnologias

- **Frontend**: React 18, Vite, TypeScript, Tailwind CSS, Lucide Icons
- **Backend**: Node.js, Express, TypeScript
- **MCP**: @modelcontextprotocol/sdk
- **LLM**: Anthropic SDK (Claude Sonnet 4)

## Licença

MIT
