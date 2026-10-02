export class HttpError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST") =>
  new HttpError(400, code, message);

export const notFound = (message: string, code = "NOT_FOUND") =>
  new HttpError(404, code, message);

export const unauthorized = (message = "Sign in with your wallet") =>
  new HttpError(401, "UNAUTHORIZED", message);
