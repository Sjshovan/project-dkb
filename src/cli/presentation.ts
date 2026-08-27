import cliProgress from 'cli-progress';
import ora from 'ora';
import { styleText } from 'node:util';
import type { DkbProgressEvent, DkbProgressReporter } from '../progress.js';

export interface CliPresentationOptions {
  json?: boolean;
  progress?: boolean;
}

export interface CliPresenter {
  readonly interactive: boolean;
  readonly progressEnabled: boolean;
  run<T>(label: string, action: (progress?: DkbProgressReporter) => Promise<T>, summary?: (value: T) => string[]): Promise<T>;
  check<T>(label: string, action: (progress?: DkbProgressReporter) => Promise<T>, passed: (value: T) => boolean, summary?: (value: T) => string[]): Promise<T>;
  print(value: unknown, summary?: (value: unknown) => string[]): void;
  progress(): DkbProgressReporter;
}

export function createCliPresenter(options: CliPresentationOptions): CliPresenter {
  const interactive = !options.json;
  const animated = interactive
    && options.progress !== false
    && (process.env.DKB_FORCE_TTY === '1' || (process.stdout.isTTY && process.stderr.isTTY));

  return {
    interactive,
    progressEnabled: animated,
    async run<T>(label: string, action: (progress?: DkbProgressReporter) => Promise<T>, summary?: (value: T) => string[]): Promise<T> {
      const progress = createProgressReporter({ interactive: animated, enabled: animated });
      const spinner = animated ? ora({ text: label, stream: process.stderr }).start() : null;
      let progressRendered = false;
      const reporter: DkbProgressReporter = (event) => {
        if (event.status === 'start') {
          progressRendered = true;
          spinner?.stop();
        }
        progress(event);
      };

      try {
        const value = await action(animated ? reporter : undefined);

        progress.close();
        if (interactive) {
          if (progressRendered) {
            console.error(successLine(`${label} complete`));
          } else if (spinner) {
            spinner.succeed(`${label} complete`);
          } else {
            console.error(successLine(`${label} complete`));
          }
          printSummary(summary?.(value) ?? defaultSummary(value));
          console.error(terminalText(['bold', 'green'], 'Done.', process.stderr));
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
    async check<T>(label: string, action: (progress?: DkbProgressReporter) => Promise<T>, passed: (value: T) => boolean, summary?: (value: T) => string[]): Promise<T> {
      const progress = createProgressReporter({ interactive: animated, enabled: animated });
      const spinner = animated ? ora({ text: label, stream: process.stderr }).start() : null;
      let progressRendered = false;
      const reporter: DkbProgressReporter = (event) => {
        if (event.status === 'start') {
          progressRendered = true;
          spinner?.stop();
        }
        progress(event);
      };

      try {
        const value = await action(animated ? reporter : undefined);
        const ok = passed(value);

        progress.close();
        if (interactive) {
          const outcome = `${label} ${ok ? 'passed' : 'failed'}`;

          if (progressRendered || !spinner) {
            console.error(ok ? successLine(outcome) : failureLine(outcome));
          } else if (ok) {
            spinner.succeed(outcome);
          } else {
            spinner.fail(outcome);
          }
          printSummary(summary?.(value) ?? defaultSummary(value));
          if (ok) {
            console.error(terminalText(['bold', 'green'], 'Done.', process.stderr));
          }
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
      return createProgressReporter({ interactive: animated, enabled: animated });
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
  for (const line of lines) {
    console.log(styleHumanLine(capitalizeLabel(line)));
  }
}

export function styleHumanLine(line: string): string {
  if (!line) {
    return line;
  }
  if (line === '(none)') {
    return terminalText('dim', line);
  }
  if (/^[A-Z][A-Z0-9 /_-]*(?: {2,}[A-Z][A-Z0-9 /_-]*)+$/u.test(line)) {
    return terminalText(['bold', 'cyan'], line);
  }

  const separator = line.indexOf(':');
  if (separator > 0) {
    const label = line.slice(0, separator + 1);
    const value = line.slice(separator + 1);
    const warning = /^Warning:$/iu.test(label);
    const styledLabel = warning
      ? terminalText(['bold', 'yellow'], label)
      : terminalText('bold', label);
    const styledValue = warning
      ? terminalText('yellow', value)
      : /^(Runtime|Path|Manifest|Output|Artifact|Registry|URL|Retry):$/iu.test(label)
      ? terminalText('cyan', value)
      : styleStatusWords(value);

    return `${styledLabel}${styledValue}`;
  }

  return styleStatusWords(line);
}

export function styleHelpText(output: string): string {
  return output.split('\n').map((line) => {
    if (/^[A-Z][A-Za-z ]+:$/u.test(line)) {
      return terminalText(['bold', 'cyan'], line);
    }
    if (/^\s{2}\S/u.test(line)) {
      const match = /^(\s+)(\S(?:.*?\S)?)(\s{2,}|$)(.*)$/u.exec(line);

      if (match) {
        return `${match[1]}${terminalText('cyan', match[2]!)}${match[3]}${match[4]}`;
      }
    }

    return line.replace(/^Usage:/u, terminalText('bold', 'Usage:'));
  }).join('\n');
}

export function terminalText(
  format: Parameters<typeof styleText>[0],
  value: string,
  stream: NodeJS.WritableStream = process.stdout,
): string {
  return styleText(format, value, { stream });
}

export function failureLine(value: string): string {
  return `${terminalText(['bold', 'red'], '×', process.stderr)} ${value}`;
}

function successLine(value: string): string {
  return `${terminalText(['bold', 'green'], '✓', process.stderr)} ${value}`;
}

function styleStatusWords(value: string): string {
  return value
    .replace(/\b(installed|published|ready|healthy|passed|complete|completed|ok|active|online|selected)\b/giu, (match) => terminalText('green', match))
    .replace(/\b(incomplete|pending|warning|degraded|skipped|known)\b/giu, (match) => terminalText('yellow', match))
    .replace(/\b(failed|error|invalid|unhealthy|missing|offline|unavailable|incompatible)\b/giu, (match) => terminalText('red', match));
}

function capitalizeLabel(line: string): string {
  if (!/^[a-z][^:]*:/u.test(line)) {
    return line;
  }

  return `${line[0]!.toUpperCase()}${line.slice(1)}`;
}

export function humanSummary(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value !== 'object') {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return renderArray(value);
  }

  const record = value as Record<string, unknown>;
  const preferredCollection = ['data', 'packages', 'registries', 'sessions', 'results', 'checks']
    .find((key) => Array.isArray(record[key]));
  const scalarLines = Object.entries(record)
    .filter(([, item]) => isScalar(item))
    .map(([key, item]) => `${humanKey(key)}: ${formatFieldValue(key, item)}`);

  if (preferredCollection) {
    const collection = record[preferredCollection] as unknown[];
    return [
      ...scalarLines,
      ...(scalarLines.length > 0 ? [''] : []),
      ...renderArray(collection),
    ];
  }

  const nestedLines = Object.entries(record)
    .filter(([, item]) => !isScalar(item))
    .flatMap(([key, item]) => renderNested(key, item));

  return [...scalarLines, ...nestedLines];
}

const defaultSummary = humanSummary;

function createProgressReporter(options: { interactive: boolean; enabled: boolean }): DkbProgressReporter & { close: () => void } {
  let bar: cliProgress.SingleBar | null = null;
  let spinner: ReturnType<typeof ora> | null = null;
  let currentPhase = '';
  let currentLabel = '';

  const close = () => {
    if (bar) {
      bar.stop();
      bar = null;
    }
    if (spinner) {
      spinner.stop();
      spinner = null;
    }
  };
  const reporter = ((event: DkbProgressEvent) => {
    if (!options.enabled) {
      return;
    }

    if (!options.interactive) {
      return;
    }

    if (event.status === 'start' || currentPhase !== event.phase || (!bar && !spinner)) {
      close();
      currentPhase = event.phase;
      currentLabel = event.label;

      if (event.total <= 0 || !Number.isFinite(event.total)) {
        spinner = ora({ text: event.label, stream: process.stderr }).start();
        return;
      }

      bar = new cliProgress.SingleBar({
        stream: process.stderr,
        format: event.unit === 'bytes'
          ? `${event.label} |{bar}| {percentage}% | {size}/{totalSize} | ETA {eta_formatted}`
          : `${event.label} |{bar}| {percentage}% | {value}/{total} ${event.unit} | ETA {eta_formatted}`,
        hideCursor: true,
        clearOnComplete: false,
        stopOnComplete: false,
        noTTYOutput: process.env.DKB_FORCE_TTY === '1',
      }, cliProgress.Presets.shades_classic);
      bar.start(event.total, Math.min(event.value, event.total), progressPayload(event));
      return;
    }

    if (bar && event.total > 0 && Number.isFinite(event.total)) {
      bar.update(Math.min(event.value, event.total), progressPayload(event));
    } else if (spinner && event.status === 'update' && event.value > 0) {
      spinner.text = `${event.label} (${event.unit === 'bytes' ? formatBytes(event.value) : `${event.value} ${event.unit}`})`;
    }

    if (event.status === 'finish') {
      if (bar) {
        bar.update(event.total, progressPayload(event));
        bar.stop();
        bar = null;
        console.error(successLine(currentLabel));
      } else if (spinner) {
        spinner.succeed(currentLabel);
        spinner = null;
      }
    }
  }) as DkbProgressReporter & { close: () => void };

  reporter.close = close;

  return reporter;
}

function progressPayload(event: DkbProgressEvent): Record<string, string> {
  return event.unit === 'bytes'
    ? { size: formatBytes(event.value), totalSize: formatBytes(event.total) }
    : {};
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = -1;

  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);

  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function renderNested(key: string, value: unknown): string[] {
  if (Array.isArray(value)) {
    const rows = renderArray(value);
    return rows.length > 0 ? ['', `${humanKey(key)}:`, ...rows.map((line) => `  ${line}`)] : [];
  }

  if (value && typeof value === 'object') {
    const rows = humanSummary(value);
    return rows.length > 0 ? ['', `${humanKey(key)}:`, ...rows.map((line) => `  ${line}`)] : [];
  }

  return [];
}

function renderArray(values: unknown[]): string[] {
  if (values.length === 0) {
    return ['(none)'];
  }

  if (values.every(isScalar)) {
    return values.map((item) => formatScalar(item));
  }

  if (!values.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    return [JSON.stringify(values, null, 2)];
  }

  const rows = values as Array<Record<string, unknown>>;
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row).filter((key) => isScalar(row[key])))));

  if (keys.length === 0) {
    return [JSON.stringify(values, null, 2)];
  }

  const widths = keys.map((key) => Math.max(
    humanKey(key).length,
    ...rows.map((row) => formatFieldValue(key, row[key]).length),
  ));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd();

  return [
    line(keys.map((key) => humanKey(key).toUpperCase())),
    ...rows.map((row) => line(keys.map((key) => formatFieldValue(key, row[key])))),
  ];
}

function isScalar(value: unknown): boolean {
  return value === null || value === undefined || ['string', 'number', 'boolean', 'bigint'].includes(typeof value);
}

function formatScalar(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return '-';
  }
  return String(value);
}

function formatFieldValue(key: string, value: unknown): string {
  const formatted = formatScalar(value);

  return key === 'status' ? formatted.replace(/_/g, ' ') : formatted;
}

function humanKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());
}
