import { DkbUnsupportedCapabilityError } from '@sjshovan/dkb-protocol/errors.js';

/**
 * Keeps an intentional public command visible without pretending its backing
 * contract exists. Planned commands must fail explicitly and point to the
 * currently supported workflow.
 */
export function notYetImplemented(command: string, detail: string, currentWorkflow?: string): never {
  throw new DkbUnsupportedCapabilityError(command, [
    `Not yet implemented: ${command}.`,
    detail,
    currentWorkflow ? `Current workflow: ${currentWorkflow}` : '',
  ].filter(Boolean).join(' '));
}
