export class AppError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'invalid' | 'conflict' | 'unauthorized',
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export const forbidden = (message: string, hint?: string) => new AppError('forbidden', message, hint);
export const notFound = (message: string) => new AppError('not_found', message);
export const invalid = (message: string, hint?: string) => new AppError('invalid', message, hint);
export const conflict = (message: string, hint?: string) => new AppError('conflict', message, hint);
