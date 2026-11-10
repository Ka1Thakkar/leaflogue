import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { validateLibraryBackup } from "@leaflogue/storage";

export interface DesktopPaths {
  readonly configDirectory: string;
  readonly defaultConfigFile: string;
  readonly configLocatorFile: string;
  readonly dataDirectory: string;
  readonly libraryFile: string;
  readonly cacheDirectory: string;
  readonly stateDirectory: string;
  readonly logsDirectory: string;
  readonly crashDumpsDirectory: string;
  readonly legacyUserDataDirectory: string;
}

export function resolveDesktopPaths(options: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly legacyUserDataDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
}): DesktopPaths {
  const environment = options.environment ?? process.env;
  if (options.platform !== "linux") {
    const root = options.legacyUserDataDirectory;
    return paths(root, root, join(root, "Cache"), join(root, "State"), root);
  }
  const configDirectory = join(xdgRoot(environment.XDG_CONFIG_HOME, join(options.homeDirectory, ".config")), "leaflogue");
  const dataDirectory = join(xdgRoot(environment.XDG_DATA_HOME, join(options.homeDirectory, ".local", "share")), "leaflogue");
  const cacheDirectory = join(xdgRoot(environment.XDG_CACHE_HOME, join(options.homeDirectory, ".cache")), "leaflogue");
  const stateDirectory = join(xdgRoot(environment.XDG_STATE_HOME, join(options.homeDirectory, ".local", "state")), "leaflogue");
  return paths(configDirectory, dataDirectory, cacheDirectory, stateDirectory, options.legacyUserDataDirectory);
}

export function prepareDesktopDirectories(value: DesktopPaths): void {
  for (const directory of [value.configDirectory, value.dataDirectory, value.cacheDirectory, value.stateDirectory, value.logsDirectory, value.crashDumpsDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
}

/**
 * Moves only Leaflogue-owned durable data out of Electron's legacy userData
 * directory. Sources are retained so an older build can still be recovered.
 * The SQLite backup API supplies a coherent snapshot, including committed WAL
 * data, while publishing the device identity before the database makes a
 * process interruption safe to resume.
 */
export async function migrateLegacyDesktopFiles(value: DesktopPaths): Promise<readonly string[]> {
  if (normalize(value.legacyUserDataDirectory) === normalize(value.dataDirectory)) return [];
  const copied = migrateLegacyConfiguration(value);
  if (existsSync(value.libraryFile)) return copied;

  const source = legacyLibrarySource(value.legacyUserDataDirectory);
  if (!source) return copied;
  const identitySource = join(value.legacyUserDataDirectory, "library.sqlite.device-id");
  const identityDestination = `${value.libraryFile}.device-id`;
  if (isOwnedRegularFile(identitySource) && existsSync(identityDestination)) {
    if (readFileSync(identitySource, "utf8") !== readFileSync(identityDestination, "utf8")) {
      throw new Error("Leaflogue cannot safely migrate a library over a different device identity");
    }
  }

  const stagedLibrary = `${value.libraryFile}.${randomUUID()}.migrating`;
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(database, stagedLibrary);
  } finally {
    database.close();
  }
  try {
    chmodSync(stagedLibrary, 0o600);
    validateLibraryBackup(stagedLibrary);
    if (copyProtectedFileIfAbsent(identitySource, identityDestination)) copied.push("library.sqlite.device-id");
    if (installPreparedFileIfAbsent(stagedLibrary, value.libraryFile)) copied.push("library.sqlite");
  } finally {
    rmSync(stagedLibrary, { force: true });
  }
  return copied;
}

function migrateLegacyConfiguration(value: DesktopPaths): string[] {
  const copied: string[] = [];
  const legacyLocator = join(value.legacyUserDataDirectory, "remote-config-location.json");
  const legacyConfig = join(value.legacyUserDataDirectory, "config.json");

  // A valid locator is the effective active-config selection, so publish it
  // first. If the process stops here, the next launch still selects the same
  // external config; copying a legacy default alongside it is unnecessary.
  if (validConfigLocator(legacyLocator) && copyProtectedFileIfAbsent(legacyLocator, value.configLocatorFile)) {
    copied.push("remote-config-location.json");
  }
  // A legacy config that other users can read was already refused by the
  // reader, so it is not carried forward (its secrets may be exposed).
  if (!existsSync(value.configLocatorFile) && isOwnerOnlyFile(legacyConfig) && copyProtectedFileIfAbsent(legacyConfig, value.defaultConfigFile)) {
    copied.push("config.json");
  }
  return copied;
}

function legacyLibrarySource(legacyDirectory: string): string | undefined {
  const live = join(legacyDirectory, "library.sqlite");
  const previous = `${live}.previous`;
  const restoreJournal = `${live}.restore-state.json`;
  // During an interrupted restore, the previous file is the last activated
  // library. Never snapshot the unverified live replacement.
  if (isOwnedRegularFile(restoreJournal) && isOwnedRegularFile(previous)) return previous;
  if (isOwnedRegularFile(live)) return live;
  // A retained previous file without its journal is still preferable to
  // silently creating a blank library; validation occurs before publication.
  if (isOwnedRegularFile(previous)) return previous;
  return undefined;
}

function paths(configDirectory: string, dataDirectory: string, cacheDirectory: string, stateDirectory: string, legacyUserDataDirectory: string): DesktopPaths {
  return {
    configDirectory,
    defaultConfigFile: join(configDirectory, "config.json"),
    configLocatorFile: join(configDirectory, "config-location.json"),
    dataDirectory,
    libraryFile: join(dataDirectory, "library.sqlite"),
    cacheDirectory,
    stateDirectory,
    logsDirectory: join(stateDirectory, "logs"),
    crashDumpsDirectory: join(stateDirectory, "crash-dumps"),
    legacyUserDataDirectory,
  };
}

function xdgRoot(value: string | undefined, fallback: string): string {
  const candidate = value?.trim();
  return candidate && isAbsolute(candidate) ? candidate : fallback;
}

function validConfigLocator(path: string): boolean {
  if (!isOwnedRegularFile(path)) return false;
  try {
    const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof document !== "object" || document === null || !("path" in document)) return false;
    const candidate = (document as { path: unknown }).path;
    return typeof candidate === "string" && candidate.length <= 4_096 && !candidate.includes("\0") && isAbsolute(candidate);
  } catch {
    return false;
  }
}

function copyProtectedFileIfAbsent(source: string, destination: string): boolean {
  if (!isOwnedRegularFile(source) || existsSync(destination) || normalize(source) === normalize(destination)) return false;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.migrating`;
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o600);
    return installPreparedFileIfAbsent(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function installPreparedFileIfAbsent(source: string, destination: string): boolean {
  try {
    linkSync(source, destination);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function isOwnerOnlyFile(path: string): boolean {
  return isOwnedRegularFile(path) && (process.platform === "win32" || (lstatSync(path).mode & 0o077) === 0);
}

function isOwnedRegularFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink()
    && (typeof process.getuid !== "function" || info.uid === process.getuid());
}
