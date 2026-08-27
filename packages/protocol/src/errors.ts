export class DkbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DkbError';
  }
}
