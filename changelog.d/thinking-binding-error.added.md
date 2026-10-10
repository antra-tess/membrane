- A 400 refusing a signed thinking block the request sent back
  ("Invalid `signature` in `thinking` block…": Anthropic's block binding
  under its default or `prefix_mismatch_behavior: "error"`, or a block
  whose signature was altered) is its own error type, `thinking_binding`,
  not retryable, instead of `invalid_request`. The request is well formed:
  a consumer that sheds or rewrites its newest message over
  `invalid_request` no longer takes it for a malformed one. `httpStatus`
  stays 400 and `providerErrorCode` `invalid_request_error`.
