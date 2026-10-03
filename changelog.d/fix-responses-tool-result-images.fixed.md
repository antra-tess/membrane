- OpenAI Responses (`openai-responses` and the Codex subscription transport):
  a tool result that carries images is now sent as a native
  `function_call_output.output` array of `input_text` / `input_image` parts.
  Both the `OpenAIResponsesFormatter` and the subscription input normalizer
  previously `JSON.stringify`'d any non-string tool-result content, so the
  model received the image's base64 as text: it could not see the image, and
  a single ~760 KB screenshot cost roughly 500k input tokens (the same image as
  a native part is ~500). Image-free content arrays keep the existing string
  form, so replayed histories without tool images are byte-identical.
