// The upstream opencode web app sends this header on the PTY connect-token
// endpoint instead of the Kilo-specific `x-kilo-ticket`. The value must still
// match PTY_CONNECT_TOKEN_HEADER_VALUE ("1"); only the header name is aliased.
export const PTY_CONNECT_ALIAS_HEADERS = ["x-opencode-ticket"]
