import path from "path";

import { getErrorCode, getErrorMessageOrDefault } from "@vortex/shared";
import SevenZip from "node-7z";

import type { IExtensionApi } from "@/types/IExtensionContext";
import * as fs from "@/util/fs";
import getVortexPath from "@/util/getVortexPath";
import type { TFunction } from "@/util/i18n";
import { log } from "@/util/log";
import * as selectors from "@/util/selectors";

import { setModsEnabled } from "../../profile_management/actions/profiles";
import { setModAttributes } from "../actions/mods";

const MODPACK_FORMAT = "vortex-modpack";
const MANIFEST_NAME = "modlist.json";

interface IModPackEntry {
  name: string;
  file: string;
  enabled: boolean;
  modId?: number;
  fileId?: number;
  downloadGame?: string;
  version?: string;
  source?: string;
}

interface IModPackManifest {
  format: string;
  version: number;
  gameId: string;
  exportedAt: string;
  mods: IModPackEntry[];
}

const safeFileName = (input: string): string => input.replace(/[^a-zA-Z0-9._-]/g, "_") || "mod";

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.statAsync(filePath);
    return true;
  } catch (err) {
    if (getErrorCode(err) !== "ENOENT") {
      throw err;
    }
    return false;
  }
};

const exportModLinks = async (
  api: IExtensionApi,
  t: TFunction,
  target: string,
  ordered: Array<{ id: string; modId?: number; fileId?: number; downloadGame?: string }>,
  gameId: string,
): Promise<void> => {
  const lines: string[] = [];
  let skipped = 0;
  for (const mod of ordered) {
    if (mod.modId === undefined || mod.fileId === undefined) {
      skipped += 1;
      continue;
    }
    lines.push(`nxm://${mod.downloadGame ?? gameId}/mods/${mod.modId}/files/${mod.fileId}`);
  }
  await fs.writeFileAsync(target, lines.join("\r\n") + "\r\n", { encoding: "utf8" });
  api.sendNotification({
    type: skipped === 0 ? "success" : "warning",
    message: t("Exported {{count}} mod links ({{skipped}} skipped)", {
      replace: { count: lines.length, skipped },
    }),
  });
};

export const exportModPack = async (api: IExtensionApi, t: TFunction): Promise<void> => {
  const state = api.getState();
  const gameId = selectors.activeGameId(state);
  const profile = selectors.activeProfile(state);
  const mods = state.persistent.mods[gameId];

  if (gameId === undefined || profile === undefined || mods === undefined) {
    api.sendNotification({ type: "error", message: t("No game is currently being managed") });
    return;
  }

  const ordered = Object.values(mods)
    .filter((mod) => mod?.installationPath !== undefined && mod.type !== "collection")
    .sort(
      (lhs, rhs) =>
        (profile.modState[lhs.id]?.enabledTime ?? 0) -
          (profile.modState[rhs.id]?.enabledTime ?? 0) || lhs.id.localeCompare(rhs.id),
    );

  if (ordered.length === 0) {
    api.sendNotification({ type: "info", message: t("No mods to export") });
    return;
  }

  const target = await api.saveFile({
    title: t("Export Mods"),
    defaultPath: `${gameId}-mods-backup.zip`,
    filters: [
      { name: "Vortex Mod Backup", extensions: ["zip"] },
      { name: "Mod Links", extensions: ["txt"] },
    ],
  });

  if (target === undefined) {
    return;
  }

  const linkEntries = ordered.map((mod) => ({
    id: mod.id,
    modId: mod.attributes?.modId,
    fileId: mod.attributes?.fileId,
    downloadGame: mod.attributes?.downloadGame,
  }));

  if (target.toLowerCase().endsWith(".txt")) {
    try {
      await exportModLinks(api, t, target, linkEntries, gameId);
    } catch (err) {
      api.showErrorNotification(t("Failed to export mods"), err, { allowReport: false });
    }
    return;
  }

  const staging = path.join(getVortexPath("temp"), `modpack-${Date.now()}`);

  try {
    await fs.ensureDirWritableAsync(path.join(staging, "mods"));

    const installRoot = selectors.installPathForGame(state, gameId);
    const downloadRoot = selectors.downloadPathForGame(state, gameId);
    const downloads = state.persistent.downloads.files;
    const szip = new SevenZip();
    const entries: IModPackEntry[] = [];

    for (const [index, mod] of ordered.entries()) {
      const name = mod.attributes?.logicalFileName ?? mod.id;
      const base = `${index.toString().padStart(4, "0")}-${safeFileName(name)}`;
      const archive = mod.archiveId !== undefined ? downloads[mod.archiveId] : undefined;
      const archivePath =
        archive?.localPath !== undefined ? path.join(downloadRoot, archive.localPath) : undefined;

      let file: string;
      if (archivePath !== undefined && (await exists(archivePath))) {
        file = `mods/${base}${path.extname(archive.localPath)}`;
        const dest = path.join(staging, file);
        await fs.linkAsync(archivePath, dest).catch(() => fs.copyAsync(archivePath, dest));
      } else {
        file = `mods/${base}.zip`;
        const source =
          installRoot !== undefined ? path.join(installRoot, mod.installationPath) : undefined;
        if (source === undefined || !(await exists(source))) {
          continue;
        }
        await szip.add(path.join(staging, file), [path.join(source, "*")]);
      }

      entries.push({
        name,
        file,
        enabled: profile.modState[mod.id]?.enabled ?? false,
        modId: mod.attributes?.modId,
        fileId: mod.attributes?.fileId,
        downloadGame: mod.attributes?.downloadGame,
        version: mod.attributes?.version,
        source: mod.attributes?.source,
      });
    }

    const manifest: IModPackManifest = {
      format: MODPACK_FORMAT,
      version: 1,
      gameId,
      exportedAt: new Date().toISOString(),
      mods: entries,
    };

    await fs.writeFileAsync(path.join(staging, MANIFEST_NAME), JSON.stringify(manifest), {
      encoding: "utf8",
    });

    await szip.add(target, [path.join(staging, MANIFEST_NAME), path.join(staging, "mods")]);

    api.sendNotification({
      type: "success",
      message: t("Exported {{count}} mods", { replace: { count: entries.length } }),
    });
  } catch (err) {
    log("error", "failed to export mods", { message: getErrorMessageOrDefault(err) });
    api.showErrorNotification(t("Failed to export mods"), err, { allowReport: false });
  } finally {
    await fs.removeAsync(staging).catch(() => undefined);
  }
};

const NXM_LINE = /^nxm:\/\/[^\s/]+\/mods\/\d+\/files\/\d+/i;

const importModLinks = async (
  api: IExtensionApi,
  t: TFunction,
  filePath: string,
): Promise<void> => {
  const content = (await fs.readFileAsync(filePath, { encoding: "utf8" })) as string;
  const links = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (NXM_LINE.test(trimmed)) {
      links.add(trimmed);
    }
  }

  if (links.size === 0) {
    api.sendNotification({ type: "info", message: t("No mod links found in the file") });
    return;
  }

  api.events.emit(
    "start-download",
    [...links],
    {},
    undefined,
    (err: Error) => {
      if (err && err.message !== "canceled") {
        api.showErrorNotification(t("Failed to download mod links"), err, {
          allowReport: false,
        });
      }
    },
    undefined,
    { allowInstall: "force" },
  );

  api.sendNotification({
    type: "success",
    message: t("Queued {{count}} mod downloads", { replace: { count: links.size } }),
  });
};

export const importModPack = async (api: IExtensionApi, t: TFunction): Promise<void> => {
  const picked = await api.selectFile({
    title: t("Import Mods"),
    filters: [
      { name: "Vortex Mod Backup", extensions: ["zip"] },
      { name: "Mod Links", extensions: ["txt"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (picked === undefined) {
    return;
  }

  if (picked.toLowerCase().endsWith(".txt")) {
    try {
      await importModLinks(api, t, picked);
    } catch (err) {
      api.showErrorNotification(t("Failed to import mods"), err, { allowReport: false });
    }
    return;
  }

  const tempDir = path.join(getVortexPath("temp"), `modpack-import-${Date.now()}`);
  const tempRoot = path.resolve(tempDir);

  try {
    await new SevenZip().extractFull(picked, tempDir);
    const manifestRaw = (await fs.readFileAsync(path.join(tempDir, MANIFEST_NAME), {
      encoding: "utf8",
    })) as string;
    const manifest = JSON.parse(manifestRaw) as IModPackManifest;
    if (manifest === null || manifest.format !== MODPACK_FORMAT || !Array.isArray(manifest.mods)) {
      api.showErrorNotification(
        t("Failed to import mods"),
        new Error(t("Not a Vortex mod backup")),
        { allowReport: false },
      );
      return;
    }

    const state = api.getState();
    const gameId = selectors.activeGameId(state);
    const profile = selectors.activeProfile(state);
    if (gameId === undefined || profile === undefined) {
      api.sendNotification({ type: "error", message: t("No game is currently being managed") });
      return;
    }
    if (manifest.gameId !== gameId) {
      api.sendNotification({
        type: "warning",
        message: t("This backup was exported for a different game"),
      });
    }

    const installed: Array<{ id: string; entry: IModPackEntry }> = [];
    let failed = 0;
    for (const entry of manifest.mods) {
      const archivePath =
        typeof entry?.file === "string" ? path.resolve(tempDir, entry.file) : undefined;
      if (
        archivePath === undefined ||
        !archivePath.startsWith(tempRoot + path.sep) ||
        !(await exists(archivePath))
      ) {
        failed += 1;
        continue;
      }
      const modId = await new Promise<string | undefined>((resolve) => {
        api.events.emit("start-install", archivePath, (err: Error, id: string) =>
          resolve(err ? undefined : id),
        );
      });
      if (modId === undefined) {
        failed += 1;
        continue;
      }
      installed.push({ id: modId, entry });

      const attributes: { [key: string]: string | number } = {};
      if (entry.modId !== undefined) attributes.modId = entry.modId;
      if (entry.fileId !== undefined) attributes.fileId = entry.fileId;
      if (entry.downloadGame !== undefined) attributes.downloadGame = entry.downloadGame;
      if (entry.version !== undefined) attributes.version = entry.version;
      if (entry.source !== undefined) attributes.source = entry.source;
      if (Object.keys(attributes).length > 0) {
        api.store.dispatch(setModAttributes(gameId, modId, attributes));
      }
    }

    const enableIds = installed.filter((item) => item.entry.enabled).map((item) => item.id);
    const disableIds = installed.filter((item) => !item.entry.enabled).map((item) => item.id);
    if (enableIds.length > 0) {
      await setModsEnabled(api, profile.id, enableIds, true, { skipStateChangeEvent: true });
    }
    if (disableIds.length > 0) {
      await setModsEnabled(api, profile.id, disableIds, false, { skipStateChangeEvent: true });
    }

    if (installed.length > 0) {
      api.events.emit("deploy-mods", (err: Error) => {
        if (err) {
          log("warn", "deployment after mod import failed", { message: err.message });
        }
      });
    }

    api.sendNotification({
      type: failed === 0 ? "success" : "warning",
      message: t("Imported {{installed}} mods ({{failed}} failed)", {
        replace: { installed: installed.length, failed },
      }),
    });
  } catch (err) {
    log("error", "failed to import mods", { message: getErrorMessageOrDefault(err) });
    api.showErrorNotification(t("Failed to import mods"), err, { allowReport: false });
  } finally {
    await fs.removeAsync(tempDir).catch(() => undefined);
  }
};
