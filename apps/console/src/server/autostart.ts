import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleStateRoot } from './processState.js';

const WINDOWS_TASK_NAME = 'DKB Console';
const SYSTEMD_UNIT = 'dkb-console.service';
const LAUNCHD_LABEL = 'io.dkb.console';

export type ConsoleAutostartProvider = 'windows-task' | 'systemd-user' | 'launch-agent';

export interface ConsoleAutostartStatus {
  enabled: boolean;
  provider: ConsoleAutostartProvider;
  registration: string;
  configuration: 'current' | 'stale' | 'untracked';
  cliEntrypoint?: string;
  enabledAt?: string;
  launcher?: string;
  launcherAvailable: boolean;
}

export interface ConsoleAutostartResult extends ConsoleAutostartStatus {
  changed: boolean;
}

interface ConsoleAutostartReceipt {
  format: 'dkb.console-autostart.v1';
  provider: ConsoleAutostartProvider;
  nodeExecutable: string;
  serviceEntrypoint: string;
  cliEntrypoint: string;
  registration: string;
  launcher?: string;
  enabledAt: string;
}

export interface ConsoleAutostartEnvironment {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  nodeExecutable?: string;
  serviceEntrypoint?: string;
  runCommand?: (command: string, args: string[]) => Promise<CommandResult>;
  windowsUser?: string;
  userId?: number;
  appDataDirectory?: string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function enableConsoleAutostart(
  cliEntrypoint: string,
  environment: ConsoleAutostartEnvironment = {},
): Promise<ConsoleAutostartResult> {
  const context = resolveContext(cliEntrypoint, environment);
  await Promise.all([fs.access(context.nodeExecutable), fs.access(context.serviceEntrypoint), fs.access(context.cliEntrypoint)]);
  await fs.mkdir(path.dirname(context.registration), { recursive: true });

  if (context.provider === 'windows-task') {
    const taskXml = windowsTaskXml(context, environment.windowsUser ?? windowsUser());
    await fs.writeFile(context.registration, `\uFEFF${taskXml}`, { encoding: 'utf16le', mode: 0o600 });
    try {
      await requireSuccess(context.runCommand, 'schtasks.exe', ['/Create', '/TN', WINDOWS_TASK_NAME, '/XML', context.registration, '/F'], 'register the Windows login task');
      await createWindowsLauncher(context);
    } catch (error) {
      await context.runCommand('schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']);
      await Promise.all([fs.rm(context.registration, { force: true }), context.launcher ? fs.rm(context.launcher, { force: true }) : Promise.resolve()]);
      throw error;
    }
  } else if (context.provider === 'systemd-user') {
    await fs.writeFile(context.registration, systemdUnit(context), { encoding: 'utf8', mode: 0o600 });
    await requireSuccess(context.runCommand, 'systemctl', ['--user', 'daemon-reload'], 'reload the user service manager');
    await requireSuccess(context.runCommand, 'systemctl', ['--user', 'enable', SYSTEMD_UNIT], 'enable the DKB Console user service');
  } else {
    await fs.writeFile(context.registration, launchAgentPlist(context), { encoding: 'utf8', mode: 0o600 });
    const domain = `gui/${environment.userId ?? process.getuid?.() ?? os.userInfo().uid}`;
    await context.runCommand('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
    await requireSuccess(context.runCommand, 'launchctl', ['enable', `${domain}/${LAUNCHD_LABEL}`], 'enable the DKB Console LaunchAgent');
    await requireSuccess(context.runCommand, 'launchctl', ['bootstrap', domain, context.registration], 'enable the DKB Console LaunchAgent');
  }

  const receipt: ConsoleAutostartReceipt = {
    format: 'dkb.console-autostart.v1',
    provider: context.provider,
    nodeExecutable: context.nodeExecutable,
    serviceEntrypoint: context.serviceEntrypoint,
    cliEntrypoint: context.cliEntrypoint,
    registration: context.registration,
    launcher: context.launcher,
    enabledAt: new Date().toISOString(),
  };
  await writeReceipt(receipt);
  return { enabled: true, provider: context.provider, registration: context.registration, configuration: 'current', cliEntrypoint: context.cliEntrypoint, enabledAt: receipt.enabledAt, launcher: context.launcher, launcherAvailable: context.launcher ? await exists(context.launcher) : false, changed: true };
}

export async function disableConsoleAutostart(environment: ConsoleAutostartEnvironment = {}): Promise<ConsoleAutostartResult> {
  const receipt = await readReceipt();
  const context = resolveContext(receipt?.cliEntrypoint ?? process.argv[1] ?? '', environment, receipt);
  const before = await consoleAutostartStatus(receipt?.cliEntrypoint, environment);

  if (context.provider === 'windows-task') {
    await context.runCommand('schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']);
  } else if (context.provider === 'systemd-user') {
    await context.runCommand('systemctl', ['--user', 'disable', SYSTEMD_UNIT]);
    await fs.rm(context.registration, { force: true });
    await context.runCommand('systemctl', ['--user', 'daemon-reload']);
  } else {
    const domain = `gui/${environment.userId ?? process.getuid?.() ?? os.userInfo().uid}`;
    await context.runCommand('launchctl', ['disable', `${domain}/${LAUNCHD_LABEL}`]);
    await context.runCommand('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
    await fs.rm(context.registration, { force: true });
  }

  await Promise.all([
    fs.rm(autostartReceiptPath(), { force: true }),
    context.provider === 'windows-task' ? fs.rm(context.registration, { force: true }) : Promise.resolve(),
    context.launcher ? fs.rm(context.launcher, { force: true }) : Promise.resolve(),
  ]);
  return { enabled: false, provider: context.provider, registration: context.registration, configuration: 'untracked', launcher: context.launcher, launcherAvailable: false, changed: before.enabled };
}

export async function startConsoleAutostart(environment: ConsoleAutostartEnvironment = {}): Promise<void> {
  const receipt = await readReceipt();
  if (!receipt) throw new Error('DKB Console automatic startup is not configured. Run: dkb console enable');
  const context = resolveContext(receipt.cliEntrypoint, environment, receipt);
  const status = await consoleAutostartStatus(receipt.cliEntrypoint, environment);
  if (!status.enabled) throw new Error('DKB Console automatic startup is disabled. Run: dkb console enable');

  if (context.provider === 'windows-task') {
    await requireSuccess(context.runCommand, 'schtasks.exe', ['/Run', '/TN', WINDOWS_TASK_NAME], 'start the Windows login task');
  } else if (context.provider === 'systemd-user') {
    await requireSuccess(context.runCommand, 'systemctl', ['--user', 'restart', SYSTEMD_UNIT], 'start the DKB Console user service');
  } else {
    const domain = `gui/${environment.userId ?? process.getuid?.() ?? os.userInfo().uid}`;
    await requireSuccess(context.runCommand, 'launchctl', ['kickstart', '-k', `${domain}/${LAUNCHD_LABEL}`], 'start the DKB Console LaunchAgent');
  }
}

export async function consoleAutostartStatus(
  currentCliEntrypoint?: string,
  environment: ConsoleAutostartEnvironment = {},
): Promise<ConsoleAutostartStatus> {
  const receipt = await readReceipt();
  const context = resolveContext(currentCliEntrypoint ?? receipt?.cliEntrypoint ?? process.argv[1] ?? '', environment, receipt);
  let enabled = false;

  if (context.provider === 'windows-task') {
    const result = await context.runCommand('schtasks.exe', ['/Query', '/TN', WINDOWS_TASK_NAME, '/XML']);
    // Task Scheduler omits <Enabled> when the value is the schema default
    // (true), but writes it explicitly when an operator disables the task.
    enabled = result.code === 0 && !/<Enabled>false<\/Enabled>/iu.test(result.stdout);
  } else if (context.provider === 'systemd-user') {
    enabled = (await context.runCommand('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT])).code === 0;
  } else {
    const domain = `gui/${environment.userId ?? process.getuid?.() ?? os.userInfo().uid}`;
    enabled = (await context.runCommand('launchctl', ['print', `${domain}/${LAUNCHD_LABEL}`])).code === 0;
  }

  const current = receipt
    && path.resolve(receipt.nodeExecutable) === path.resolve(context.nodeExecutable)
    && path.resolve(receipt.serviceEntrypoint) === path.resolve(context.serviceEntrypoint)
    && (!currentCliEntrypoint || path.resolve(receipt.cliEntrypoint) === path.resolve(currentCliEntrypoint));
  return {
    enabled,
    provider: context.provider,
    registration: context.registration,
    configuration: receipt ? (current ? 'current' : 'stale') : 'untracked',
    cliEntrypoint: receipt?.cliEntrypoint,
    enabledAt: receipt?.enabledAt,
    launcher: receipt?.launcher ?? context.launcher,
    launcherAvailable: await exists(receipt?.launcher ?? context.launcher),
  };
}

function resolveContext(
  cliEntrypoint: string,
  environment: ConsoleAutostartEnvironment,
  receipt?: ConsoleAutostartReceipt | null,
) {
  const platform = environment.platform ?? process.platform;
  const provider = providerFor(platform);
  const homeDirectory = path.resolve(environment.homeDirectory ?? os.homedir());
  const registration = receipt?.provider === provider
    ? receipt.registration
    : provider === 'windows-task'
      ? path.join(consoleStateRoot(), 'autostart', 'windows-task.xml')
      : provider === 'systemd-user'
        ? path.join(homeDirectory, '.config', 'systemd', 'user', SYSTEMD_UNIT)
        : path.join(homeDirectory, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const launcher = receipt?.provider === provider && receipt.launcher
    ? receipt.launcher
    : provider === 'windows-task'
      ? path.join(path.resolve(environment.appDataDirectory ?? process.env.APPDATA ?? path.join(homeDirectory, 'AppData', 'Roaming')), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DKB Console.lnk')
      : undefined;
  return {
    provider,
    registration: path.resolve(registration),
    nodeExecutable: path.resolve(environment.nodeExecutable ?? process.execPath),
    serviceEntrypoint: path.resolve(environment.serviceEntrypoint ?? fileURLToPath(new URL('./service.js', import.meta.url))),
    cliEntrypoint: path.resolve(cliEntrypoint),
    homeDirectory,
    launcher: launcher ? path.resolve(launcher) : undefined,
    runCommand: environment.runCommand ?? runCommand,
  };
}

async function createWindowsLauncher(context: ReturnType<typeof resolveContext>): Promise<void> {
  if (!context.launcher) return;
  await fs.mkdir(path.dirname(context.launcher), { recursive: true });
  const script = [
    `$shell = New-Object -ComObject WScript.Shell`,
    `$shortcut = $shell.CreateShortcut('${powershellText(context.launcher)}')`,
    `$shortcut.TargetPath = '${powershellText(context.nodeExecutable)}'`,
    `$shortcut.Arguments = '${powershellText(`"${context.cliEntrypoint}" console`)}'`,
    `$shortcut.WorkingDirectory = '${powershellText(context.homeDirectory)}'`,
    `$shortcut.WindowStyle = 7`,
    `$shortcut.Description = 'Open the DKB Host Console'`,
    `$shortcut.Save()`,
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await requireSuccess(context.runCommand, 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], 'create the DKB Console Start Menu shortcut');
  if (!await exists(context.launcher)) throw new Error('Could not create the DKB Console Start Menu shortcut. Run: dkb console enable');
}

function providerFor(platform: NodeJS.Platform): ConsoleAutostartProvider {
  if (platform === 'win32') return 'windows-task';
  if (platform === 'linux') return 'systemd-user';
  if (platform === 'darwin') return 'launch-agent';
  throw new Error(`DKB Console automatic startup is not supported on ${platform}. The Console can still be started with: dkb console`);
}

function windowsTaskXml(context: ReturnType<typeof resolveContext>, user: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Keep the loopback DKB Host Console available for this user.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(context.nodeExecutable)}</Command><Arguments>${xml(`"${context.serviceEntrypoint}" "${context.cliEntrypoint}"`)}</Arguments></Exec></Actions>
</Task>
`;
}

function systemdUnit(context: ReturnType<typeof resolveContext>): string {
  return `[Unit]
Description=DKB Host Console
After=graphical-session.target

[Service]
Type=simple
ExecStart=${systemdQuote(context.nodeExecutable)} ${systemdQuote(context.serviceEntrypoint)} ${systemdQuote(context.cliEntrypoint)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function launchAgentPlist(context: ReturnType<typeof resolveContext>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(context.nodeExecutable)}</string><string>${xml(context.serviceEntrypoint)}</string><string>${xml(context.cliEntrypoint)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
</dict></plist>
`;
}

function systemdQuote(value: string): string {
  return `"${value.replace(/%/gu, '%%').replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function xml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

function windowsUser(): string {
  const domain = process.env.USERDOMAIN;
  const username = process.env.USERNAME ?? os.userInfo().username;
  return domain ? `${domain}\\${username}` : username;
}

function powershellText(value: string): string {
  return value.replace(/'/gu, "''");
}

async function exists(target: string | undefined): Promise<boolean> {
  if (!target) return false;
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: typeof (error as NodeJS.ErrnoException | null)?.code === 'number' ? Number((error as NodeJS.ErrnoException).code) : error ? 1 : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

async function requireSuccess(
  runner: (command: string, args: string[]) => Promise<CommandResult>,
  command: string,
  args: string[],
  action: string,
): Promise<void> {
  const result = await runner(command, args);
  if (result.code === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(`Could not ${action}${detail ? `: ${detail}` : '.'}`);
}

function autostartReceiptPath(): string {
  return path.join(consoleStateRoot(), 'autostart.json');
}

async function readReceipt(): Promise<ConsoleAutostartReceipt | null> {
  try {
    const value = JSON.parse(await fs.readFile(autostartReceiptPath(), 'utf8')) as Partial<ConsoleAutostartReceipt>;
    if (value.format !== 'dkb.console-autostart.v1' || !value.provider || !value.nodeExecutable || !value.serviceEntrypoint || !value.cliEntrypoint || !value.registration || !value.enabledAt) return null;
    return value as ConsoleAutostartReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeReceipt(receipt: ConsoleAutostartReceipt): Promise<void> {
  const target = autostartReceiptPath();
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rm(target, { force: true });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}
