export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Errors raised by providers. `retryable` errors are retried automatically (with backoff) up to max attempts. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string = "provider_error",
    readonly retryable = false,
  ) {
    super(message);
  }
}

export class AbortedError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "AbortedError";
  }
}
