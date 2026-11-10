import { watch } from "node:fs";
import { basename, dirname } from "node:path";

interface CloseableWatcher {
  close(): void;
}

type SafeWatchDirectory = (
  directory: string,
  listener: (fileName?: string) => void,
  onError: () => void,
) => CloseableWatcher;

export function createAppearanceWatcher(options: {
  readonly configPath: string;
  readonly resolveThemePath: () => string | undefined;
  /** Any change inside this folder reloads, so dropped-in themes appear. */
  readonly themesDirectory?: string;
  readonly onChange: () => void;
  readonly debounceMs?: number;
  readonly watchDirectory?: SafeWatchDirectory;
}): () => void {
  const watchDirectory: SafeWatchDirectory = options.watchDirectory ?? ((directory, listener, onError) => {
    const watcher = watch(directory, { persistent: false }, (_event, fileName) => listener(fileName?.toString()));
    watcher.on("error", onError);
    return watcher;
  });
  let watchers: CloseableWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const queueReload = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      try {
        options.onChange();
      } catch {
        // Keep the last valid appearance and continue watching for a repair.
      } finally {
        refresh();
      }
    }, options.debounceMs ?? 100);
  };

  const refresh = () => {
    watchers.forEach((watcher) => watcher.close());
    watchers = [];
    if (stopped) return;
    const paths = [options.configPath];
    try {
      const themePath = options.resolveThemePath();
      if (themePath) paths.push(themePath);
    } catch {
      // The config directory remains watched so a repaired document is detected.
    }
    for (const path of paths) {
      installTarget(path);
    }
    if (options.themesDirectory) installDirectory(options.themesDirectory);
  };

  const installDirectory = (directory: string) => {
    try {
      const installed = watchDirectory(
        directory,
        () => queueReload(),
        () => {
          installed.close();
          watchers = watchers.filter((watcher) => watcher !== installed);
          queueReload();
        },
      );
      watchers.push(installed);
    } catch {
      // Not created yet: watch for the folder itself, then switch on reload.
      installTarget(directory);
    }
  };

  const installTarget = (targetPath: string) => {
    let directory = dirname(targetPath);
    let targetName = basename(targetPath);
    while (true) {
      try {
        const installed = watchDirectory(
          directory,
          (fileName) => { if (fileName === undefined || fileName === targetName) queueReload(); },
          () => {
            installed.close();
            watchers = watchers.filter((watcher) => watcher !== installed);
            queueReload();
          },
        );
        watchers.push(installed);
        return;
      } catch {
        const parent = dirname(directory);
        if (parent === directory) return;
        targetName = basename(directory);
        directory = parent;
      }
    }
  };

  refresh();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    watchers.forEach((watcher) => watcher.close());
    watchers = [];
  };
}
