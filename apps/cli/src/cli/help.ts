import { Command, Help } from 'commander';
import { styleHelpText } from './presentation.js';

const ROOT_COMMAND_GROUPS = [
  {
    title: 'Common Commands',
    names: [
      'init',
      'add',
      'search',
      'install',
      'list',
      'show',
      'retrieve',
      'uninstall',
      'outdated',
      'upgrade',
      'publish',
      'serve',
      'inspect',
      'validate',
      'health',
      'version',
      'help',
    ],
  },
  {
    title: 'Management Commands',
    names: ['artifact', 'build', 'collection', 'compiler', 'console', 'library', 'mcp', 'pipeline', 'plugin', 'registry', 'remote', 'runtime', 'stack', 'trace'],
  },
  {
    title: 'Advanced Commands',
    names: [
      'audit-alignment',
      'compile',
      'query',
      'read',
      'read-targets',
      'restore',
      'verify',
      'watch',
    ],
  },
] as const;

export function configureDkbHelp(command: Command): void {
  command.configureHelp({
    ...command.configureHelp(),
    sortOptions: true,
    sortSubcommands: true,
    formatHelp: formatDkbHelp,
  });
}

function formatDkbHelp(command: Command, helper: Help): string {
  const standard = new Help();
  standard.sortOptions = helper.sortOptions;
  standard.sortSubcommands = helper.sortSubcommands;
  standard.showGlobalOptions = helper.showGlobalOptions;
  standard.helpWidth = helper.helpWidth;
  const output = standard.formatHelp(command, standard);

  if (command.name() !== 'dkb') {
    return styleHelpText(output);
  }

  const commands = standard.visibleCommands(command);
  const termWidth = standard.padWidth(command, standard);
  const helpWidth = standard.helpWidth || 80;
  const configuredNames = new Set<string>(ROOT_COMMAND_GROUPS.flatMap((group) => [...group.names]));
  const commandGroups = [
    ...ROOT_COMMAND_GROUPS,
    {
      title: 'Other Commands',
      names: commands
        .map((candidate) => candidate.name())
        .filter((name) => !configuredNames.has(name)),
    },
  ];
  const grouped = commandGroups.flatMap((group) => {
    const items = group.names
      .map((name) => commands.find((candidate) => candidate.name() === name))
      .filter((candidate): candidate is Command => Boolean(candidate))
      .map((candidate) => {
        const term = standard.subcommandTerm(candidate);
        const description = standard.subcommandDescription(candidate);
        const line = description ? `${term.padEnd(termWidth + 2)}${description}` : term;

        return `  ${standard.wrap(line, helpWidth - 2, termWidth + 2)}`;
      });

    return items.length > 0 ? [`${group.title}:`, ...items, ''] : [];
  });

  return styleHelpText(output.replace(/Commands:\n[\s\S]*$/u, grouped.join('\n')));
}
