import cliProgress from 'cli-progress';
import ora from 'ora';
import type { DkbProgressEvent, DkbProgressReporter } from '../progress.js';

export interface CliPresentationOptions {
  json?: boolean;
  progress?: boolean;
}

export interface CliPresenter {
  readonly interactive: boolean;
  readonly progressEnabled: boolean;
  run<T>(label: string, action: (progress: DkbProgressReporter) => Promise<T>, summary?: (value: T) => string[]): Promise<T>;
  print(value: unknown, summary?: (value: unknown) => string[]): void;
  progress(): DkbProgressReporter;
}

export function createCliPresenter(options: CliPresentationOptions): CliPresenter {
  const interactive = !options.json
    && options.progress !== false
    && (process.env.DKB_FORCE_TTY === '1' || (process.stdout.isTTY && process.stderr.isTTY));

  return {
    interactive,
    progressEnabled: options.progress !== false,
    async run<T>(label: string, action: (progress: DkbProgressReporter) => Promise<T>, summary?: (value: T) => string[]): Promise<T> {
      const progress = createProgressReporter({ interactive, enabled: options.progress !== false });
      const spinner = interactive ? ora({ text: label, stream: process.stderr }).start() : null;
      let progressRendered = false;
      const reporter: DkbProgressReporter = (event) => {
        if (event.status === 'start') {
          progressRendered = true;
          spinner?.stop();
        }
        progress(event);
      };

      try {
        const value = await action(reporter);

        progress.close();
        if (spinner) {
          if (progressRendered) {
            console.error(`√ ${label}`);
          } else {
            spinner.succeed(label);
          }
          printSummary(summary?.(value) ?? defaultSummary(value));
        } else {
          printJson(value);
        }

        return value;
      } catch (error) {
        progress.close();
        if (spinner) {
          spinner.fail(label);
        }

        throw error;
      }
    },
    print(value: unknown, summary?: (value: unknown) => string[]): void {
      if (interactive) {
        printSummary(summary?.(value) ?? defaultSummary(value));
      } else {
        printJson(value);
      }
    },
    progress(): DkbProgressReporter {
      return createProgressReporter({ interactive, enabled: options.progress !== false });
    },
  };
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function milliseconds(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s`;
  }

  return `${Math.round(value)}ms`;
}

export function countLabel(value: unknown, singular: string, plural = `${singular}s`): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return `${value} ${value === 1 ? singular : plural}`;
}

function printSummary(lines: string[]): void {
  for (const line of lines.filter(Boolean)) {
    console.error(line);
  }
}

function defaultSummary(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const status = 'status' in value ? String((value as { status: unknown }).status) : undefined;

  return status ? [`status: ${status}`] : [];
}

function createProgressReporter(options: { interactive: boolean; enabled: boolean }): DkbProgressReporter & { close: () => void } {
  let bar: cliProgress.SingleBar | null = null;
  let currentPhase = '';

  const close = () => {
    if (bar) {
      bar.stop();
      bar = null;
    }
  };
  const reporter = ((event: DkbProgressEvent) => {
    if (!options.enabled) {
      return;
    }

    if (!options.interactive) {
      return;
    }

    if (event.total <= 0 || !Number.isFinite(event.total)) {
      return;
    }

    if (event.status === 'start' || currentPhase !== event.phase || !bar) {
      close();
      currentPhase = event.phase;
      bar = new cliProgress.SingleBar({
        stream: process.stderr,
        format: `${event.label} |{bar}| {percentage}% | {value}/{total} ${event.unit} | ETA {eta_formatted}`,
        hideCursor: true,
        clearOnComplete: false,
        stopOnComplete: false,
        noTTYOutput: process.env.DKB_FORCE_TTY === '1',
      }, cliProgress.Presets.shades_classic);
      bar.start(event.total, Math.min(event.value, event.total));
      return;
    }

    bar.update(Math.min(event.value, event.total));

    if (event.status === 'finish') {
      close();
    }
  }) as DkbProgressReporter & { close: () => void };

  reporter.close = close;

  return reporter;
}
