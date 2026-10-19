import { runDockerOwnerWorker, type DockerLibraryOwner } from './dockerOwnerWorker.js';

export { assertLocalOwnerVolume, validateDockerLibraryOwner, type DockerLibraryOwner } from './dockerOwnerWorker.js';

/** Public resource routing owns host inventory and refreshes; this transport stays offline. */
export function runDockerLibraryOwner(owner: DockerLibraryOwner, request: unknown, options: {
  signal?: AbortSignal;
  onOutput?: (channel: 'stdout' | 'stderr', bytes: Buffer) => void;
} = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return runDockerOwnerWorker('library', owner, request, options);
}
