- Preserve Responses cache behavior through older adapter decorators: absent
  `supportsResponsesPromptCaching` falls back to an affirmative
  `requiresNativeResponsesInput`. API decorators forwarding that capability keep
  explicit writes and TTL; subscription decorators suppress formatter carriers,
  boundary refusals and extra warnings without forwarding the new flag.
