/**
 * Prefill mode transforms
 * 
 * Converts normalized messages to participant-based conversation log format:
 * 
 * Alice: Hello there!
 * 
 * Bob: Hi Alice!
 * 
 * Claude: [assistant continuation starts here...]
 * 
 * Key features:
 * - Cache control markers for Anthropic prompt caching
 * - Image flushing (images cause conversation flush to user turn)
 * - Tool injection into conversation
 */

import type {
  NormalizedMessage,
  NormalizedRequest,
  ContentBlock,
  ToolDefinition,
  CacheControl,
} from '../types/index.js';
import { isTextContent, isMediaContent } from '../types/index.js';
import { formatToolDefinitions, type ToolDefinitionForPrompt } from '../utils/tool-parser.js';

// ============================================================================
// Provider Content Block (with cache_control support)
// ============================================================================

/**
 * Content block in provider format (Anthropic-style)
 * Can include cache_control for prompt caching
 */
export interface ProviderTextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

export interface ProviderImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export type ProviderContentBlock = ProviderTextBlock | ProviderImageBlock;

// ============================================================================
// Provider Message (API-ready format)
// ============================================================================

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string | ProviderContentBlock[];
}

// ============================================================================
// Prefill Transform Result
// ============================================================================

export interface PrefillTransformResult {
  /** System prompt content blocks (may have cache_control) */
  systemContent: ProviderContentBlock[];
  
  /** Messages in provider format (ready for API) */
  messages: ProviderMessage[];
  
  /** For legacy compatibility: system as string */
  system: string;
  
  /** For legacy compatibility: user content as string */
  userContent: string;
  
  /** For legacy compatibility: assistant prefill as string */
  assistantPrefill: string;
  
  /** Stop sequences to use */
  stopSequences: string[];
  
  /** Number of cache markers applied */
  cacheMarkersApplied: number;
}

// ============================================================================
// Transform Options
// ============================================================================

export interface PrefillTransformOptions {
  /** Name of the assistant participant (default: 'Claude') */
  assistantName?: string;
  
  /** Maximum participants to include in stop sequences */
  maxParticipantsForStop?: number;
  
  /** Custom stop sequences to add */
  additionalStopSequences?: string[];
  
  /** 
   * Where to inject tool definitions:
   * - 'system': Inject into system prompt (default)
   * - 'conversation': Inject as user message ~N from end (chatperx style)
   * - 'none': No injection (use getToolInstructions() for manual placement)
   */
  toolInjectionMode?: 'system' | 'conversation' | 'none';
  
  /** Position to inject tools when mode is 'conversation' (from end of messages) */
  toolInjectionPosition?: number;
  
  /** Enable prompt caching (default: true) */
  promptCaching?: boolean;
  
  /** Message delimiter for base models (e.g., '</s>') */
  messageDelimiter?: string;
  
  /** Context prefix for simulacrum seeding */
  contextPrefix?: string;
  
  /** Start assistant response with <thinking> tag */
  prefillThinking?: boolean;
}

// ============================================================================
// Main Transform Function
// ============================================================================

/**
 * Transform normalized request to prefill format with cache control support
 */
export function transformToPrefill(
  request: NormalizedRequest,
  options: PrefillTransformOptions = {}
): PrefillTransformResult {
  const {
    assistantName = 'Claude',
    maxParticipantsForStop = 10,
    additionalStopSequences = [],
    toolInjectionMode = 'system',
    toolInjectionPosition = 10,
    promptCaching = true,
    messageDelimiter = '',
    contextPrefix,
    prefillThinking = false,
  } = options;
  
  const messages = request.messages;
  const providerMessages: ProviderMessage[] = [];
  
  // Track cache marker GLOBALLY across all flushes
  // Everything BEFORE we see the marker gets cache_control
  // Everything AFTER does NOT
  let passedCacheMarker = false;
  let cacheMarkersApplied = 0;
  
  // Joiner between messages (if delimiter, no newlines needed)
  const joiner = messageDelimiter ? '' : '\n';
  
  // Track conversation lines for current section
  let currentConversation: string[] = [];
  let lastNonEmptyParticipant: string | null = null;
  
  // Build system prompt
  let systemText = request.system ?? '';
  
  // Inject tool definitions into system prompt if mode is 'system'
  if (toolInjectionMode === 'system' && request.tools && request.tools.length > 0) {
    const toolsXml = formatToolsForPrefill(request.tools);
    systemText = injectToolsIntoSystem(systemText, toolsXml);
  }
  
  // System prompt content (with cache_control if enabled)
  const systemContent: ProviderContentBlock[] = [];
  if (systemText) {
    const systemBlock: ProviderTextBlock = { type: 'text', text: systemText };
    if (promptCaching) {
      systemBlock.cache_control = { type: 'ephemeral' };
      cacheMarkersApplied++;
    }
    systemContent.push(systemBlock);
    // Note: system content goes in systemContent, not providerMessages
    // Anthropic's API requires system as a top-level parameter
  }
  
  // Add context prefix as first cached assistant message (for simulacrum seeding)
  if (contextPrefix) {
    // Need a user message first (Anthropic requires user->assistant alternation)
    providerMessages.push({
      role: 'user',
      content: '[conversation begins]',
    });
    
    const prefixBlock: ProviderTextBlock = { type: 'text', text: contextPrefix };
    if (promptCaching) {
      prefixBlock.cache_control = { type: 'ephemeral' };
      cacheMarkersApplied++;
    }
    providerMessages.push({
      role: 'assistant',
      content: [prefixBlock],
    });
  }
  
  // Process messages
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    
    const isLastMessage = i === messages.length - 1;
    const isAssistant = message.participant === assistantName;
    const hasCacheMarker = !!message.metadata?.cacheControl;
    
    // Extract text and images
    const { text, images } = formatContentForPrefill(message.content, message.participant);
    const hasImages = images.length > 0;
    const isEmpty = !text.trim() && !hasImages;
    
    // Check for tool results
    const hasToolResult = message.content.some(c => c.type === 'tool_result');
    
    // If message has images, flush current conversation and add as user message
    if (hasImages && !isEmpty) {
      // Flush current assistant conversation
      if (currentConversation.length > 0) {
        const content = currentConversation.join(joiner);
        providerMessages.push({
          role: 'assistant',
          content: content,
        });
        currentConversation = [];
      }
      
      // Add message with image as user turn
      const userContent: ProviderContentBlock[] = [];
      if (text) {
        userContent.push({ type: 'text', text: `${message.participant}: ${text}` });
      }
      userContent.push(...images);
      
      providerMessages.push({
        role: 'user',
        content: userContent,
      });
      
      lastNonEmptyParticipant = message.participant;
      continue;
    }
    
    // Skip empty messages (except last)
    if (isEmpty && !isLastMessage) {
      continue;
    }
    
    // Check if this message has the cache marker - switch to uncached mode AFTER this
    if (hasCacheMarker && !passedCacheMarker) {
      // Flush everything before this message WITH cache_control (if caching enabled)
      if (currentConversation.length > 0) {
        const content = currentConversation.join(joiner);
        const contentBlock: ProviderTextBlock = { type: 'text', text: content };
        if (promptCaching) {
          contentBlock.cache_control = { type: 'ephemeral' };
          cacheMarkersApplied++;
        }
        providerMessages.push({
          role: 'assistant',
          content: [contentBlock],
        });
        currentConversation = [];
      }
      passedCacheMarker = true;
    }
    
    // Check bot continuation logic
    const isBotMessage = message.participant === assistantName;
    const isContinuation = isBotMessage && lastNonEmptyParticipant === assistantName && !hasToolResult;
    
    if (isContinuation && isLastMessage) {
      // Bot continuation - don't add prefix, just complete from where we are
      continue;
    } else if (isLastMessage && isEmpty) {
      // Completion target - optionally start with thinking tag
      if (prefillThinking) {
        currentConversation.push(`${message.participant}: <thinking>`);
      } else {
        currentConversation.push(`${message.participant}:`);
      }
    } else if (text) {
      // Regular message - append delimiter if configured
      currentConversation.push(`${message.participant}: ${text}${messageDelimiter}`);
      if (!hasToolResult) {
        lastNonEmptyParticipant = message.participant;
      }
    }
  }
  
  // Flush any remaining conversation, insert tools near end if mode is 'conversation'
  if (currentConversation.length > 0) {
    const shouldInjectInConversation = 
      toolInjectionMode === 'conversation' && 
      request.tools && 
      request.tools.length > 0 && 
      currentConversation.length > toolInjectionPosition;
      
    if (shouldInjectInConversation) {
      // Insert tools ~N messages from the end
      const splitPoint = currentConversation.length - toolInjectionPosition;
      const beforeTools = currentConversation.slice(0, splitPoint);
      const afterTools = currentConversation.slice(splitPoint);
      
      // Add content before tools
      if (beforeTools.length > 0) {
        providerMessages.push({
          role: 'assistant',
          content: beforeTools.join(joiner),
        });
      }
      
      // Add tools as user message
      providerMessages.push({
        role: 'user',
        content: formatToolsForInjection(request.tools!),
      });
      
      // Add content after tools
      if (afterTools.length > 0) {
        providerMessages.push({
          role: 'assistant',
          content: afterTools.join(joiner),
        });
      }
    } else {
      // Short conversation - just add everything
      providerMessages.push({
        role: 'assistant',
        content: currentConversation.join(joiner),
      });
    }
  }
  
  // Build stop sequences from participants
  const stopSequences = buildStopSequences(
    messages,
    assistantName,
    maxParticipantsForStop,
    additionalStopSequences
  );
  
  // Build legacy string versions for backwards compatibility
  const legacyStrings = buildLegacyStrings(providerMessages, systemText);
  
  return {
    systemContent,
    messages: providerMessages,
    system: systemText,
    userContent: legacyStrings.userContent,
    assistantPrefill: legacyStrings.assistantPrefill,
    stopSequences,
    cacheMarkersApplied,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatContentForPrefill(
  content: ContentBlock[],
  participant: string
): { text: string; images: ProviderImageBlock[] } {
  const parts: string[] = [];
  const images: ProviderImageBlock[] = [];
  
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      // Convert to provider format
      if (block.source.type === 'base64') {
        images.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: block.source.mediaType,
            data: block.source.data,
          },
        });
      }
    } else if (block.type === 'tool_use') {
      // Format as: Name>[toolname]: {json}
      parts.push(`${participant}>[${block.name}]: ${JSON.stringify(block.input)}`);
    } else if (block.type === 'tool_result') {
      // Format as: Name<[tool_result]: result
      const resultText = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      parts.push(`${participant}<[tool_result]: ${resultText}`);
    }
  }
  
  return { text: parts.join('\n'), images };
}

function formatToolsForPrefill(tools: ToolDefinition[]): string {
  const toolsForPrompt: ToolDefinitionForPrompt[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: Object.fromEntries(
      Object.entries(tool.inputSchema.properties).map(([name, schema]) => [
        name,
        {
          type: schema.type,
          description: schema.description,
          required: tool.inputSchema.required?.includes(name),
          enum: schema.enum,
        },
      ])
    ),
  }));
  
  return formatToolDefinitions(toolsForPrompt);
}

function injectToolsIntoSystem(system: string, toolsXml: string): string {
  const toolsSection = `
<available_tools>
${toolsXml}
</available_tools>

When you want to use a tool, output:
<function_calls>
<invoke name="tool_name">
<parameter name="param_name">value</parameter>
</invoke>
</function_calls>
`;
  
  return system + '\n\n' + toolsSection;
}

// Tool format constants (assembled to avoid triggering stop sequences)
const FUNCTIONS_OPEN = '<' + 'functions>';
const FUNCTIONS_CLOSE = '</' + 'functions>';
const FUNCTION_OPEN = '<' + 'function>';
const FUNCTION_CLOSE = '</' + 'function>';
const FUNC_CALLS_OPEN = '<' + 'function_calls>';
const FUNC_CALLS_CLOSE = '</' + 'function_calls>';
const INVOKE_OPEN = '<' + 'invoke name="';
const INVOKE_CLOSE = '</' + 'invoke>';
const PARAM_OPEN = '<' + 'parameter name="';
const PARAM_CLOSE = '</' + 'parameter>';

function formatToolsForInjection(tools: ToolDefinition[]): string {
  // Format each tool as JSON inside <function> tags
  const formatted = tools.map((tool) => {
    const toolDef = {
      description: tool.description,
      name: tool.name,
      parameters: tool.inputSchema,
    };
    return `${FUNCTION_OPEN}${JSON.stringify(toolDef)}${FUNCTION_CLOSE}`;
  });
  
  // Build instruction with example
  const instruction = `
When making function calls using tools that accept array or object parameters ensure those are structured using JSON. For example:
${FUNC_CALLS_OPEN}
${INVOKE_OPEN}example_complex_tool">
${PARAM_OPEN}parameter">[{"color": "orange", "options": {"key": true}}]${PARAM_CLOSE}
${INVOKE_CLOSE}
${FUNC_CALLS_CLOSE}`;
  
  return `${FUNCTIONS_OPEN}
${formatted.join('\n')}
${FUNCTIONS_CLOSE}
${instruction}`;
}

function buildStopSequences(
  messages: NormalizedMessage[],
  assistantName: string,
  maxParticipants: number,
  additionalSequences: string[]
): string[] {
  // Collect unique participants (excluding assistant)
  const participants = new Set<string>();
  
  // Scan from end of messages
  for (let i = messages.length - 1; i >= 0 && participants.size < maxParticipants; i--) {
    const message = messages[i];
    if (!message) continue;
    const participant = message.participant;
    if (participant !== assistantName) {
      participants.add(participant);
    }
  }
  
  // Build stop sequences
  const sequences: string[] = [];
  
  // Participant-based stops
  for (const participant of participants) {
    sequences.push(`\n${participant}:`);
  }
  
  // Tool-related stop
  sequences.push('</function_calls>');
  
  // Additional sequences
  sequences.push(...additionalSequences);
  
  return sequences;
}

function buildLegacyStrings(
  messages: ProviderMessage[],
  systemText: string
): { userContent: string; assistantPrefill: string } {
  // Extract user content (first user message after system)
  let userContent = '';
  let assistantPrefill = '';
  
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        userContent += msg.content + '\n\n';
      } else {
        // Extract text from blocks
        for (const block of msg.content) {
          if (block.type === 'text') {
            userContent += block.text + '\n\n';
          }
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        assistantPrefill += msg.content;
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            assistantPrefill += block.text;
          }
        }
      }
    }
  }
  
  return {
    userContent: userContent.trim(),
    assistantPrefill: assistantPrefill,
  };
}

// ============================================================================
// Prefill Continuation
// ============================================================================

/**
 * Build a continuation request from accumulated output
 */
export function buildContinuationPrefill(
  originalResult: PrefillTransformResult,
  accumulated: string
): PrefillTransformResult {
  // Update the last assistant message with accumulated content
  const newMessages = [...originalResult.messages];
  
  // Find the last assistant message or add one
  const lastIdx = newMessages.length - 1;
  if (lastIdx >= 0 && newMessages[lastIdx]?.role === 'assistant') {
    newMessages[lastIdx] = {
      role: 'assistant',
      content: accumulated,
    };
  } else {
    newMessages.push({
      role: 'assistant',
      content: accumulated,
    });
  }
  
  return {
    ...originalResult,
    messages: newMessages,
    assistantPrefill: accumulated,
  };
}
