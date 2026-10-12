// Keep the existing native colon encoding. Ordinary underscores are valid
// wire characters; decoding every `__` would corrupt literal caller names.
export function sanitizeToolName(name: string): string {
  return name.replace(/:/g, '__');
}

export function restoreToolName(name: string, tools?: readonly { name: string }[]): string {
  return tools?.find(tool => tool.name === name)?.name
    ?? tools?.find(tool => sanitizeToolName(tool.name) === name)?.name
    ?? name;
}
