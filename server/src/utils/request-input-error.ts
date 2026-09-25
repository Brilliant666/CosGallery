/** Deliberate business input rejection, distinct from an unexpected runtime failure. */
export class RequestInputError extends Error {
  readonly status = 400;
  constructor(message: string, readonly code = 'INVALID_REQUEST') { super(message); }
}
