import { mcpManager, MCPTool } from './mcp-manager.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenRouterTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: OpenRouterTool[];
  tool_choice?: 'auto' | 'none' | 'required';
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  output: string;
}

class OpenRouterService {
  private baseUrl = 'https://openrouter.ai/api/v1';
  private defaultModel = 'anthropic/claude-sonnet-4';

  private getApiKey(): string | null {
    return process.env.OPENROUTER_API_KEY || null;
  }

  hasApiKey(): boolean {
    return !!this.getApiKey();
  }

  /**
   * Allowed JSON Schema properties (draft 2020-12 compatible subset)
   */
  private readonly allowedSchemaProps = new Set([
    'type', 'properties', 'required', 'description', 'additionalProperties',
    'items', 'enum', 'default', 'title', 'anyOf', 'oneOf', 'allOf', 'not',
    'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format',
    'minItems', 'maxItems', 'uniqueItems', 'const', 'examples',
    'minProperties', 'maxProperties', 'propertyNames', 'nullable'
  ]);

  /**
   * Recursively sanitize a schema definition (for property definitions, items, etc.)
   */
  private sanitizeSchemaDefinition(schema: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(schema)) {
      // Skip properties starting with $ (like $schema, $id, $ref, $defs)
      if (key.startsWith('$')) {
        continue;
      }

      // Only include allowed JSON Schema properties
      if (!this.allowedSchemaProps.has(key)) {
        continue;
      }

      if (key === 'properties' && value && typeof value === 'object') {
        // `properties` is a map of field names to their schemas
        // Field names are NOT JSON Schema keywords, so we don't filter them
        const propsObj = value as Record<string, unknown>;
        const sanitizedProps: Record<string, unknown> = {};
        
        for (const [fieldName, fieldSchema] of Object.entries(propsObj)) {
          if (fieldSchema && typeof fieldSchema === 'object') {
            sanitizedProps[fieldName] = this.sanitizeSchemaDefinition(fieldSchema as Record<string, unknown>);
          } else {
            sanitizedProps[fieldName] = fieldSchema;
          }
        }
        result[key] = sanitizedProps;
      } else if (key === 'items' && value && typeof value === 'object') {
        // `items` defines the schema for array elements
        result[key] = this.sanitizeSchemaDefinition(value as Record<string, unknown>);
      } else if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
        // These are arrays of schemas
        result[key] = value.map(item => 
          item && typeof item === 'object' 
            ? this.sanitizeSchemaDefinition(item as Record<string, unknown>)
            : item
        );
      } else if (key === 'additionalProperties' && value && typeof value === 'object') {
        // additionalProperties can be a schema
        result[key] = this.sanitizeSchemaDefinition(value as Record<string, unknown>);
      } else if (key === 'required' && Array.isArray(value)) {
        // Remove duplicates from required array
        result[key] = [...new Set(value)];
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Sanitize JSON schema to ensure it's valid for Claude/OpenRouter
   * Must match JSON Schema draft 2020-12
   */
  private sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const sanitized = this.sanitizeSchemaDefinition(schema);

    // Ensure type is object for root schema
    if (!sanitized.type) {
      sanitized.type = 'object';
    }

    // Ensure properties exists for object types
    if (sanitized.type === 'object' && !sanitized.properties) {
      sanitized.properties = {};
    }

    return sanitized;
  }

  /**
   * Convert MCP tools to OpenRouter tool format
   */
  private convertMCPToolsToOpenRouterFormat(): OpenRouterTool[] {
    const allTools = mcpManager.getAllTools();
    
    return allTools.map(({ connectionId, tool }) => ({
      type: 'function' as const,
      function: {
        name: `${connectionId}__${tool.name}`,
        description: tool.description || `Tool ${tool.name}`,
        parameters: this.sanitizeSchema(tool.inputSchema),
      },
    }));
  }

  /**
   * Execute a tool call via MCP
   */
  private async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    const functionName = toolCall.function.name;
    const [connectionId, ...toolNameParts] = functionName.split('__');
    const toolName = toolNameParts.join('__');

    try {
      const args = JSON.parse(toolCall.function.arguments);
      const result = await mcpManager.callTool(connectionId, toolName, args);
      
      return {
        tool_call_id: toolCall.id,
        name: functionName,
        output: JSON.stringify(result, null, 2),
      };
    } catch (error) {
      return {
        tool_call_id: toolCall.id,
        name: functionName,
        output: JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Tool execution failed' 
        }),
      };
    }
  }

  /**
   * Clean messages to remove non-standard fields before sending to API
   */
  private cleanMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(msg => {
      const clean: ChatMessage = {
        role: msg.role,
        content: msg.content,
      };

      // Only include tool_call_id for tool messages
      if (msg.role === 'tool' && msg.tool_call_id) {
        clean.tool_call_id = msg.tool_call_id;
      }

      // Only include tool_calls for assistant messages, and clean them
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        clean.tool_calls = msg.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments || '{}',
          },
        }));
      }

      return clean;
    });
  }

  /**
   * Send a chat completion request to OpenRouter
   */
  async chat(
    messages: ChatMessage[],
    options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      useTools?: boolean;
    } = {}
  ): Promise<{ message: ChatMessage; toolResults?: ToolResult[] }> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('OpenRouter API key not configured. Set OPENROUTER_API_KEY in .env');
    }

    const model = options.model || this.defaultModel;
    
    // Clean messages to remove non-standard fields (refusal, reasoning, index, etc.)
    const cleanedMessages = this.cleanMessages(messages);
    
    // Always send tools so model can continue calling them after receiving results
    const tools = options.useTools !== false
      ? this.convertMCPToolsToOpenRouterFormat() 
      : [];

    const request: ChatCompletionRequest = {
      model,
      messages: cleanedMessages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
    };

    if (tools.length > 0) {
      request.tools = tools;
      request.tool_choice = 'auto';
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://trampoai.local',
        'X-Title': 'TrampoAI',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      try {
        const error = JSON.parse(errorBody);
        throw new Error(error.error?.message || `OpenRouter API error: ${response.status}`);
      } catch (parseError) {
        if (parseError instanceof SyntaxError) {
          throw new Error(`OpenRouter API error: ${response.status} - ${errorBody}`);
        }
        throw parseError;
      }
    }

    const responseText = await response.text();
    let data: ChatCompletionResponse;
    
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error('Invalid JSON response from OpenRouter');
    }

    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      throw new Error('No choices in OpenRouter response');
    }

    const assistantMessage = data.choices[0]?.message;

    if (!assistantMessage) {
      throw new Error('No message in OpenRouter response');
    }

    // Keep content as null if there are tool_calls (API expectation)
    // Otherwise ensure it's a string
    if (assistantMessage.content === undefined) {
      assistantMessage.content = assistantMessage.tool_calls ? null : '';
    }

    // If there are tool calls, execute them
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      const toolResults: ToolResult[] = [];
      
      for (const toolCall of assistantMessage.tool_calls) {
        const result = await this.executeTool(toolCall);
        toolResults.push(result);
      }

      return { message: assistantMessage, toolResults };
    }

    return { message: assistantMessage };
  }

  /**
   * System prompt to ensure the model completes tasks
   */
  private readonly systemPrompt: ChatMessage = {
    role: 'system',
    content: `Você é um assistente útil com acesso a ferramentas MCP (Model Context Protocol). 

REGRAS IMPORTANTES:
1. Quando o usuário pedir para fazer algo, COMPLETE A TAREFA até o fim
2. Se você disse que vai fazer algo, FAÇA - não pare no meio
3. Use as ferramentas disponíveis para completar tarefas
4. Se uma ferramenta falhar, tente outra abordagem
5. Sempre responda em português brasileiro
6. Seja conciso e direto

Quando precisar criar, modificar ou buscar informações, use as ferramentas disponíveis.`,
  };

  /**
   * Complete chat with automatic tool execution loop
   */
  async chatWithToolLoop(
    messages: ChatMessage[],
    options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      maxIterations?: number;
    } = {}
  ): Promise<{
    messages: ChatMessage[];
    finalMessage: ChatMessage;
  }> {
    const maxIterations = options.maxIterations ?? 10;
    
    // Add system prompt if not present
    const hasSystemPrompt = messages.some(m => m.role === 'system');
    const conversationMessages = hasSystemPrompt 
      ? [...messages] 
      : [this.systemPrompt, ...messages];
    
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;
      
      const { message, toolResults } = await this.chat(conversationMessages, options);
      conversationMessages.push(message);

      // If no tool calls, we're done
      if (!message.tool_calls || message.tool_calls.length === 0) {
        return {
          messages: conversationMessages,
          finalMessage: message,
        };
      }

      // Add tool results to conversation
      if (toolResults) {
        for (const result of toolResults) {
          conversationMessages.push({
            role: 'tool',
            tool_call_id: result.tool_call_id,
            content: result.output,
          });
        }
      }
    }

    throw new Error(`Max iterations (${maxIterations}) reached without completing`);
  }

  /**
   * Get available models from OpenRouter
   */
  async getModels(): Promise<{ id: string; name: string; context_length: number; pricing: { prompt: string; completion: string } }[]> {
    const apiKey = this.getApiKey();
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = await response.json();
    return data.data || [];
  }
}

export const openRouterService = new OpenRouterService();

