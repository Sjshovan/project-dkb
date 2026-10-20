export class DkbError extends Error {
  readonly code: string;

  constructor(message: string, code = 'DKB_ERROR') {
    super(message);
    this.name = 'DkbError';
    this.code = code;
  }
}

export class DkbUnsupportedCapabilityError extends DkbError {
  readonly capability: string;

  constructor(capability: string, message: string) {
    super(message, 'unsupported_capability');
    this.name = 'DkbUnsupportedCapabilityError';
    this.capability = capability;
  }
}
