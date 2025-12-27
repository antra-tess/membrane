/**
 * Chat mode transforms
 * 
 * Converts normalized messages to role-based alternating format
 * for providers that don't support prefill mode.
 */

import type {
  NormalizedMessage,
  NormalizedRequest,
  ContentBlock,
} from '../types/index.js';
import { isTextContent, isToolUseContent, isToolResultContent } from '../types/index.js';

// ============================================================================
// Chat Transform Result
// ============================================================================

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ChatContent[];
}

export type ChatContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; data: string; mediaType: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface ChatTransformResult {
  /** System prompt */
  system: string;
  
  /** Messages in role-based format */
  messages: ChatMessage[];
  
  /** Stop sequences to use */
  stopSequences: string[];
}

// ============================================================================
// Transform Options
// ============================================================================

export interface ChatTransformOptions {
  /** Name of the assistant participant (default: 'Claude') */
  assistantName?: string;
  
  /** Names to treat as 'user' role */
  userParticipants?: string[];
  
  /** How to handle multiple consecutive same-role messages */
  mergeStrategy?: 'concatenate' | 'separate';
}

// ============================================================================
// Main Transform Function
// ============================================================================

/**
 * Transform normalized request to chat format
 */
export function transformToChat(
  request: NormalizedRequest,
  options: ChatTransformOptions = {}
): ChatTransformResult {
  const {
    assistantName = 'Claude',
    userParticipants = [],
    mergeStrategy = 'concatenate',
  } = options;
  
  const userSet = new Set(userParticipants);
  const messages: ChatMessage[] = [];
  
  for (const message of request.messages) {
    const role = determineRole(message.participant, assistantName, userSet);
    const content = transformContent(message.content);
    
    if (mergeStrategy === 'concatenate' && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.role === role) {
        // Merge with previous message
        lastMessage.content.push(...content);
        continue;
      }
    }
    
    messages.push({ role, content });
  }
  
  // Ensure alternating roles (required by most providers)
  const normalizedMessages = ensureAlternatingRoles(messages);
  
  // Build stop sequences
  const stopSequences = buildChatStopSequences(request);
  
  return {
    system: request.system ?? '',
    messages: normalizedMessages,
    stopSequences,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function determineRole(
  participant: string,
  assistantName: string,
  userSet: Set<string>
): 'user' | 'assistant' {
  if (participant === assistantName) {
    return 'assistant';
  }
  if (userSet.has(participant)) {
    return 'user';
  }
  // Default: non-assistant is user
  return 'user';
}

function transformContent(blocks: ContentBlock[]): ChatContent[] {
  const result: ChatContent[] = [];
  
  for (const block of blocks) {
    if (isTextContent(block)) {
      result.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && block.source.type === 'base64') {
      result.push({
        type: 'image',
        source: {
          type: 'base64',
          data: block.source.data,
          mediaType: block.source.mediaType,
        },
      });
    } else if (isToolUseContent(block)) {
      result.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    } else if (isToolResultContent(block)) {
      const content = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      result.push({
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content,
      });
    }
    // Other block types are skipped or could be handled here
  }
  
  return result;
}

function ensureAlternatingRoles(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  
  const result: ChatMessage[] = [];
  let lastRole: 'user' | 'assistant' | null = null;
  
  for (const message of messages) {
    if (lastRole === message.role) {
      // Insert empty message of opposite role
      const fillerRole = message.role === 'user' ? 'assistant' : 'user';
      result.push({
        role: fillerRole,
        content: [{ type: 'text', text: '...' }],
      });
    }
    
    result.push(message);
    lastRole = message.role;
  }
  
  // Ensure starts with user
  const first = result[0];
  if (result.length > 0 && first && first.role === 'assistant') {
    result.unshift({
      role: 'user',
      content: [{ type: 'text', text: '...' }],
    });
  }
  
  return result;
}

function buildChatStopSequences(request: NormalizedRequest): string[] {
  const sequences: string[] = [];
  
  // Add tool-related stop if tools are defined
  if (request.tools && request.tools.length > 0) {
    sequences.push('</function_calls>');
  }
  
  // Add any explicit stop sequences from request
  if (request.stopSequences) {
    if (Array.isArray(request.stopSequences)) {
      sequences.push(...request.stopSequences);
    } else {
      sequences.push(...request.stopSequences.sequences);
    }
  }
  
  return sequences;
}
