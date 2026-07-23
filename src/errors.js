export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

export function isHttpError(error) {
  return error instanceof HttpError || (
    error &&
    Number.isInteger(error.status) &&
    typeof error.code === 'string' &&
    error.expose === true
  );
}
