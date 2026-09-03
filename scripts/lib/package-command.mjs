import { execFile } from 'node:child_process';

/** Keep npm's child handle, but settle only after the child and its stdio close. */
export function executePackageCommand(command, args, options = {}) {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  let child;
  const operation = new Promise((resolve, reject) => {
    let completed;
    let closed = false;
    const finish = () => {
      if (!closed || !completed) return;
      if (completed.error) reject(Object.assign(completed.error, { stdout: completed.stdout, stderr: completed.stderr }));
      else resolve({ stdout: completed.stdout, stderr: completed.stderr });
    };
    child = execFile(command, args, options, (error, stdout, stderr) => {
      completed = { error, stdout, stderr };
      finish();
    });
    // Abort can invoke execFile's callback before close. Cleanup must not race
    // a still-running npm process or its open package/database files.
    child.once('close', () => { closed = true; finish(); });
  });
  return Object.assign(operation, { child });
}
