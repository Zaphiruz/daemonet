/** Supplies access tokens to the client. */
export interface TokenSource {
  getToken(): Promise<string>;
  /** Called with a fresh token whenever the source refreshes; returns an unsubscribe function. */
  onRefresh?(listener: (token: string) => void): () => void;
}

/** Local development servers with AUTH_DEV_BYPASS=true accept `dev:<name>`. */
export function devToken(name: string): TokenSource {
  return { getToken: async () => `dev:${name}` };
}

export function staticToken(token: string): TokenSource {
  return { getToken: async () => token };
}
