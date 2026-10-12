import { readFile } from "node:fs/promises";
import * as path from "path";

import { mdiExport, mdiImport, mdiMagnify, mdiOpenInNew, mdiRefresh } from "@mdi/js";
import type {
  ICollection,
  ICollectionSearchOptions,
  CollectionSortField,
  IFileInfo,
  IMod,
  SortDirection,
} from "@nexusmods/nexus-api";
import numeral from "numeral";
import React, { useEffect, useRef, useState } from "react";
import { useSelector } from "react-redux";

import { CollectionsDownloadClickedEvent } from "@/extensions/analytics/mixpanel/MixpanelEvents";
import { getGame } from "@/extensions/gamemode_management/util/getGame";
import { buildNXMCollectionUrl, nxmModUrl } from "@/extensions/nexus_integration/NXMUrl";
import type {
  IModSearchOptions,
  ModSortField,
} from "@/extensions/nexus_integration/types/IModSearch";
import {
  convertGameIdReverse,
  convertNXMIdReverse,
  nexusGameId,
} from "@/extensions/nexus_integration/util/convertGameId";
import type { IExtensionApi } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";
import { Button } from "@/ui/components/button/Button";
import { CollectionTile } from "@/ui/components/collection_tile/CollectionTile";
import { CollectionTileSkeleton } from "@/ui/components/collection_tile/CollectionTile.skeleton";
import { TextField } from "@/ui/components/form/text_field/TextField";
import { Listing } from "@/ui/components/listing/Listing";
import { ModTile } from "@/ui/components/mod_tile/ModTile";
import { ModTileSkeleton } from "@/ui/components/mod_tile/ModTile.skeleton";
import { Pagination } from "@/ui/components/pagination/Pagination";
import { Picker } from "@/ui/components/picker/Picker";
import { TabBar } from "@/ui/components/tabs/TabBar";
import { TabButton } from "@/ui/components/tabs/TabButton";
import { TabPanel } from "@/ui/components/tabs/TabPanel";
import { TabProvider } from "@/ui/components/tabs/Tabs.context";
import { Typography } from "@/ui/components/typography/Typography";
import { UserCanceled } from "@/util/api";
import * as fs from "@/util/fs";
import { activeGameId, gameById, knownGames } from "@/util/selectors";
import MainPage from "@/views/MainPage";

interface IBrowseNexusPageProps {
  api: IExtensionApi;
}

interface ISortOption {
  field: CollectionSortField;
  direction: SortDirection;
  label: string;
}

const SORT_OPTIONS: ISortOption[] = [
  { field: "createdAt", direction: "DESC", label: "Recently Listed" },
  { field: "endorsements", direction: "DESC", label: "Most Endorsed" },
  { field: "recentRating", direction: "DESC", label: "Highest Rated" },
  { field: "downloads", direction: "DESC", label: "Most Downloaded" },
];

interface IModSortOption {
  field: ModSortField;
  direction: SortDirection;
  label: string;
}

const MOD_SORT_OPTIONS: IModSortOption[] = [
  { field: "updatedAt", direction: "DESC", label: "Last Updated" },
  { field: "createdAt", direction: "DESC", label: "Recently Added" },
  { field: "endorsements", direction: "DESC", label: "Most Endorsed" },
  { field: "downloads", direction: "DESC", label: "Most Downloaded" },
];

const RETIRED_FILE_CATEGORIES = [4, 6, 7];

const WEB_MOD_URL_PATTERN = /nexusmods\.com\/(?:games\/)?([\w.-]+)\/mods\/(\d+)/i;
const NXM_MOD_URL_PATTERN = /nxm:\/\/([\w.-]+)\/mods\/(\d+)(?:\/files\/(\d+))?/i;

function pickDownloadFile(files: IFileInfo[]): IFileInfo | undefined {
  return (
    files.find((file) => file.is_primary) ??
    files
      .filter((file) => file.category_id === 1)
      .sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp)[0] ??
    files
      .filter((file) => !RETIRED_FILE_CATEGORIES.includes(file.category_id))
      .sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp)[0]
  );
}

async function adultContentDialog(
  api: IExtensionApi,
  collection: ICollection,
  adultContent: boolean,
): Promise<boolean> {
  try {
    const result = await api.showDialog(
      "question",
      "Adult content warning",
      {
        bbcode: api.translate(
          `The collection "[b]{{collectionName}}[/b]" has been classified as adult content because it contains: nudity, sexualisation, extreme violence and gore, or excessive profanity.<br/><br/>` +
            `Your site preferences are set to hide adult content, you can update your preferences on the Nexus Mods website.`,
          { replace: { collectionName: collection.name } },
        ),
      },
      [{ label: api.translate("Cancel") }, { label: api.translate("Open site preferences") }],
    );
    return result.action === "Cancel" ? false : true;
  } catch {
    return adultContent;
  }
}

function BrowseNexusPage(props: IBrowseNexusPageProps) {
  const { api } = props;
  const t = (input: string, options?: Record<string, unknown>) =>
    api.translate(input, {
      isNamespaceKey: true,
      ns: ["collection", "common"],
      ...options,
    });

  const scrollRef = useRef<HTMLDivElement>(null);

  const gameId = useSelector((state: IState) => activeGameId(state));
  const gameDomainName = nexusGameId(getGame(gameId), gameId);

  const isLoggedIn = useSelector((state: IState) => {
    const nexus = state.confidential?.account?.["nexus"];
    return !!(nexus?.APIKey || nexus?.OAuthCredentials);
  });
  const adultContentFilter = useSelector(
    (state: IState) => state.persistent["nexus"]?.userInfo?.adult,
  );
  const [collections, setCollections] = useState<ICollection[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [allCollectionsTotal, setAllCollectionsTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [sortBy, setSortBy] = useState<ISortOption>(SORT_OPTIONS[1]); // Default to "Most Endorsed"
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeSearch, setActiveSearch] = useState<string>(""); // The search term actually being used
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [selectedTab, setSelectedTab] = useState<string>("collections");
  const [refreshTrigger, setRefreshTrigger] = useState<number>(0);
  const [searchValidationError, setSearchValidationError] = useState<string>("");

  const [mods, setMods] = useState<Partial<IMod>[]>([]);
  const [modsTotalCount, setModsTotalCount] = useState<number>(0);
  const [modsLoading, setModsLoading] = useState<boolean>(true);
  const [modsError, setModsError] = useState<Error | null>(null);
  const [modsSortBy, setModsSortBy] = useState<IModSortOption>(MOD_SORT_OPTIONS[0]);
  const [modsSearchQuery, setModsSearchQuery] = useState<string>("");
  const [modsActiveSearch, setModsActiveSearch] = useState<string>("");
  const [modsPage, setModsPage] = useState<number>(1);
  const [modsRefreshTrigger, setModsRefreshTrigger] = useState<number>(0);
  const [modsSearchValidationError, setModsSearchValidationError] = useState<string>("");
  const [modsImporting, setModsImporting] = useState<boolean>(false);
  const itemsPerPage = 20;

  const handleSearch = () => {
    // Clear any previous validation errors
    setSearchValidationError("");

    // If search query is too short (1 character), show validation error
    if (searchQuery.length === 1) {
      setSearchValidationError(t("collection:browse.searchTooShort"));
      return;
    }

    // If search query is empty, clear the search
    // If search query is 2+ characters, perform the search
    setActiveSearch(searchQuery);
    setCurrentPage(1);
  };

  const handleRefresh = () => {
    setLoading(true);
    setError(null);
    setRefreshTrigger((prev) => prev + 1);
  };

  const handleModsSearch = () => {
    setModsSearchValidationError("");
    if (modsSearchQuery.length === 1) {
      setModsSearchValidationError(t("collection:browse.searchTooShort"));
      return;
    }
    setModsActiveSearch(modsSearchQuery);
    setModsPage(1);
  };

  const handleModsRefresh = () => {
    setModsLoading(true);
    setModsError(null);
    setModsRefreshTrigger((prev) => prev + 1);
  };

  const queueModDownload = (
    resolvedGameId: string,
    nxmUrl: string,
    domainName: string,
    modId: number,
    fileId: number,
    name?: string,
  ) => {
    api.events.emit(
      "start-download",
      [nxmUrl],
      {
        game: resolvedGameId,
        source: "nexus",
        name,
        nexus: {
          ids: {
            gameId: domainName,
            modId,
            fileId,
          },
        },
      },
      undefined,
      (err: Error) => {
        if (err && !(err instanceof UserCanceled)) {
          api.showErrorNotification("Failed to download mod", err);
        }
      },
      undefined,
      { allowInstall: "force" },
    );
  };

  const handleDownloadMod = async (mod: Partial<IMod>) => {
    const files = await Promise.resolve(api.ext.nexusGetModFiles(gameId, mod.modId));
    const file = pickDownloadFile(files ?? []);
    if (file === undefined) {
      api.sendNotification({
        type: "warning",
        title: t("collection:browse.mods.noFiles"),
        message: mod.name,
      });
      return;
    }

    queueModDownload(
      gameId,
      nxmModUrl(gameById(api.getState(), gameId), gameId, mod.modId, file.file_id),
      gameDomainName,
      mod.modId,
      file.file_id,
      mod.name,
    );
  };

  const handleExportMods = async () => {
    try {
      const filePath = await api.saveFile({
        defaultPath: `${gameDomainName}-mods.txt`,
        filters: [{ name: "Text File", extensions: ["txt"] }],
        title: t("collection:browse.mods.exportTitle"),
      });
      if (!filePath) {
        return;
      }
      const lines = mods
        .filter((mod) => mod?.modId != null)
        .map(
          (mod) =>
            `https://www.nexusmods.com/${mod.game?.domainName ?? gameDomainName}/mods/${mod.modId}`,
        );
      await fs.ensureDirWritableAsync(path.dirname(filePath));
      await fs.writeFileAsync(filePath, lines.join("\n") + "\n", "utf8");
      api.sendNotification({
        type: "success",
        message: t("collection:browse.mods.exportDone", {
          replace: { count: lines.length },
        }),
      });
    } catch (err) {
      api.showErrorNotification(t("collection:browse.mods.exportFailed"), err, {
        allowReport: false,
      });
    }
  };

  const handleImportMods = async () => {
    const filePath = await api.selectFile({
      filters: [{ name: "Text File", extensions: ["txt"] }],
      title: t("collection:browse.mods.importTitle"),
    });
    if (!filePath) {
      return;
    }
    try {
      const content = await readFile(filePath, "utf8");
      const seen = new Set<string>();
      const entries: { line: string; domain: string; modId: number; fileId?: number }[] = [];
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        const nxm = line.match(NXM_MOD_URL_PATTERN);
        const match = nxm ?? line.match(WEB_MOD_URL_PATTERN);
        if (!match) {
          continue;
        }
        const key = `${match[1].toLowerCase()}/${match[2]}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        entries.push({
          line,
          domain: match[1],
          modId: parseInt(match[2], 10),
          fileId: nxm?.[3] !== undefined ? parseInt(nxm[3], 10) : undefined,
        });
      }
      if (entries.length === 0) {
        api.sendNotification({
          type: "warning",
          message: t("collection:browse.mods.importNoLinks"),
        });
        return;
      }

      setModsImporting(true);
      const state = api.getState();
      const games = knownGames(state);
      let queued = 0;
      let failed = 0;
      for (const entry of entries) {
        try {
          const resolvedGameId = entry.line.startsWith("nxm:")
            ? convertNXMIdReverse(games, entry.domain)
            : convertGameIdReverse(games, entry.domain);
          let fileId = entry.fileId;
          if (fileId === undefined) {
            const files = await Promise.resolve(
              api.ext.nexusGetModFiles(resolvedGameId, entry.modId),
            );
            fileId = pickDownloadFile(files ?? [])?.file_id;
          }
          if (fileId === undefined) {
            failed += 1;
            continue;
          }
          queueModDownload(
            resolvedGameId,
            entry.line.startsWith("nxm:")
              ? entry.line
              : nxmModUrl(gameById(state, resolvedGameId), resolvedGameId, entry.modId, fileId),
            entry.domain,
            entry.modId,
            fileId,
          );
          queued += 1;
        } catch {
          failed += 1;
        }
      }
      api.sendNotification({
        type: failed === 0 ? "success" : "warning",
        message: t("collection:browse.mods.importDone", {
          replace: { queued, failed },
        }),
      });
    } catch (err) {
      api.showErrorNotification(t("collection:browse.mods.importFailed"), err, {
        allowReport: false,
      });
    } finally {
      setModsImporting(false);
    }
  };

  const handleAddCollection = (collection: ICollection) => {
    const revisionNumber = collection.latestPublishedRevision?.revisionNumber || "latest";
    // Use the game domain name from the collection data (already converted)
    const nxmUrl = buildNXMCollectionUrl(
      collection.game.domainName,
      collection.slug,
      revisionNumber,
    );

    // Track the download click event
    api.events.emit(
      "analytics-track-mixpanel-event",
      new CollectionsDownloadClickedEvent(collection.slug, collection.game.id),
    );

    if (adultContentFilter === false && collection.latestPublishedRevision?.adultContent) {
      void adultContentDialog(api, collection, false).then((proceed) => {
        if (proceed) {
          window.api.shell.openUrl("https://next.nexusmods.com/settings/content-blocking");
        }
      });
    } else {
      // Use the Vortex API to handle the NXM link.
      // Populate modInfo.nexus.ids so the persisted download is recognised as
      // a collection by `nexusIdsFromDownloadId` — without these fields the
      // download-completed analytics in DownloadObserver can't tell it apart
      // from a non-Nexus download and silently skips the event.
      api.events.emit(
        "start-download",
        [nxmUrl],
        {
          game: gameId,
          source: "nexus",
          name: collection.name,
          nexus: {
            ids: {
              gameId: collection.game.domainName,
              collectionId: collection.id,
              revisionId: collection.latestPublishedRevision?.id,
              collectionSlug: collection.slug,
              revisionNumber: collection.latestPublishedRevision?.revisionNumber,
            },
          },
        },
        undefined,
        (err: Error) => {
          if (err && !(err instanceof UserCanceled)) {
            api.showErrorNotification("Failed to add collection", err);
          }
        },
        undefined,
        { allowInstall: "force" },
      );
    }
  };

  useEffect(() => {
    if (!gameId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const options: ICollectionSearchOptions = {
      gameId: gameDomainName,
      count: 20,
      offset: (currentPage - 1) * itemsPerPage,
      sort: {
        field: sortBy.field,
        direction: sortBy.direction,
      },
      search: activeSearch || undefined,
      categoryName: [{ op: "NOT_EQUALS", value: "Wabbajack Mod List" }],
      collectionStatuses: ["listed"],
    };

    // Fetch collections using the new search API with sorting and search
    Promise.resolve(api.ext.nexusSearchCollections(options))
      .then((result: { nodes: ICollection[]; totalCount: number }) => {
        setCollections(result.nodes || []);
        setTotalCount(result.totalCount || 0);
        // Store unfiltered total when no search is active
        if (!activeSearch) {
          setAllCollectionsTotal(result.totalCount || 0);
        }
        setLoading(false);
      })
      .catch((err: Error) => {
        // Provide user-friendly error message for wildcard search requirement
        if (err.message && err.message.includes("Wildcard value must have 2 or more characters")) {
          const friendlyError = new Error(t("collection:browse.searchTooShort"));
          setError(friendlyError);
          // Also clear the invalid search so user can try again
          setActiveSearch("");
        } else {
          setError(err);
        }
        setLoading(false);
      });
  }, [gameId, sortBy, activeSearch, currentPage, api, refreshTrigger]);

  useEffect(() => {
    if (!gameId || selectedTab !== "mods") {
      return;
    }

    setModsLoading(true);
    setModsError(null);

    const options: IModSearchOptions = {
      gameId: gameDomainName,
      count: itemsPerPage,
      offset: (modsPage - 1) * itemsPerPage,
      sort: {
        field: modsSortBy.field,
        direction: modsSortBy.direction,
      },
      search: modsActiveSearch || undefined,
      adultContent: adultContentFilter === true ? undefined : false,
    };

    Promise.resolve(api.ext.nexusSearchMods(options))
      .then((result: { nodes: Partial<IMod>[]; totalCount: number }) => {
        setMods(result?.nodes ?? []);
        setModsTotalCount(result?.totalCount ?? 0);
        setModsLoading(false);
      })
      .catch((err: Error) => {
        if (err.message && err.message.includes("Wildcard value must have 2 or more characters")) {
          setModsError(new Error(t("collection:browse.searchTooShort")));
          setModsActiveSearch("");
        } else {
          setModsError(err);
        }
        setModsLoading(false);
      });
  }, [
    gameId,
    gameDomainName,
    adultContentFilter,
    selectedTab,
    modsSortBy,
    modsActiveSearch,
    modsPage,
    api,
    modsRefreshTrigger,
  ]);

  if (!gameId) {
    return (
      <MainPage id="browse-collections-page">
        <MainPage.Body>
          <div className="p-5 text-center">
            <p>{t("collection:browse.selectGame")}</p>
          </div>
        </MainPage.Body>
      </MainPage>
    );
  }

  return (
    <MainPage id="browse-collections-page">
      <MainPage.Body className="h-full overflow-y-auto pt-6" ref={scrollRef}>
        <TabProvider
          tab={selectedTab}
          tabListId="browse-nexus-tabs"
          onSetSelectedTab={setSelectedTab}
        >
          <TabBar className="overflow-clip pl-6">
            <TabButton
              count={allCollectionsTotal}
              name={t("collection:browse.tabs.collections")}
              panelId="collections"
            />

            <TabButton name={t("collection:browse.tabs.mods")} panelId="mods" />
          </TabBar>

          <TabPanel id="collections">
            <div className="space-y-3 p-6">
              <form
                className="flex items-start gap-x-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSearch();
                }}
              >
                <TextField
                  errorMessage={searchValidationError || undefined}
                  fieldClassName="max-w-60"
                  hideLabel={true}
                  label={t("collection:browse.searchPlaceholder")}
                  placeholder={t("collection:browse.searchPlaceholder")}
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);

                    // Clear validation error when user types
                    if (searchValidationError) {
                      setSearchValidationError("");
                    }
                  }}
                />

                <Button
                  appearance="moderate"
                  brand="neutral"
                  leftIconPath={mdiMagnify}
                  title={t("common:actions.search")}
                  type="submit"
                />
              </form>

              <div className="flex justify-between">
                <div className="flex items-center gap-x-2">
                  <Button
                    appearance="moderate"
                    brand="neutral"
                    leftIconPath={mdiRefresh}
                    title={t("collection:browse.refresh")}
                    onClick={handleRefresh}
                  />

                  <Typography
                    appearance="moderate"
                    brand="neutral-translucent"
                    typographyType="body-sm"
                  >
                    {t("collection:browse.resultsCount", {
                      total: numeral(totalCount).format("0,0"),
                    })}
                  </Typography>
                </div>

                <Picker
                  options={SORT_OPTIONS.map((option) => ({
                    label: option.label,
                    value: option,
                  }))}
                  value={sortBy}
                  onChange={(value) => {
                    setSortBy(value);
                    setCurrentPage(1);
                  }}
                />
              </div>

              <Listing
                className="grid grid-cols-[repeat(auto-fit,minmax(26rem,1fr))] gap-4"
                entityCount={collections?.length}
                isError={!!error}
                isLoading={loading}
                noResultsChildren={
                  <Button
                    appearance="moderate"
                    brand="neutral"
                    leftIconPath={mdiOpenInNew}
                    onClick={() =>
                      window.api.shell.openUrl(
                        `https://www.nexusmods.com/games/${gameDomainName}/mods`,
                      )
                    }
                  >
                    {t("collection:browse.modsComingSoon.openWebsite")}
                  </Button>
                }
                noResultsMessage={t("collection:browse.noCollections.message")}
                noResultsTitle={t("collection:browse.noCollections.title")}
                skeletonCount={12}
                SkeletonTile={CollectionTileSkeleton}
              >
                {collections?.map((collection) => (
                  <CollectionTile
                    api={api}
                    collection={collection}
                    isLoggedIn={isLoggedIn}
                    key={collection.id}
                    onAddCollection={() => handleAddCollection(collection)}
                    onViewPage={() =>
                      window.api.shell.openUrl(
                        `https://www.nexusmods.com/games/${collection.game.domainName}/collections/${collection.slug}`,
                      )
                    }
                  />
                ))}
              </Listing>

              <Pagination
                currentPage={currentPage}
                recordsPerPage={itemsPerPage}
                scrollRef={scrollRef}
                totalRecords={totalCount}
                onPaginationUpdate={(newPage) => setCurrentPage(newPage)}
              />
            </div>
          </TabPanel>

          <TabPanel id="mods">
            <div className="space-y-3 p-6">
              <form
                className="flex items-start gap-x-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleModsSearch();
                }}
              >
                <TextField
                  errorMessage={modsSearchValidationError || undefined}
                  fieldClassName="max-w-60"
                  hideLabel={true}
                  label={t("collection:browse.mods.searchPlaceholder")}
                  placeholder={t("collection:browse.mods.searchPlaceholder")}
                  value={modsSearchQuery}
                  onChange={(e) => {
                    setModsSearchQuery(e.target.value);

                    if (modsSearchValidationError) {
                      setModsSearchValidationError("");
                    }
                  }}
                />

                <Button
                  appearance="moderate"
                  brand="neutral"
                  leftIconPath={mdiMagnify}
                  title={t("common:actions.search")}
                  type="submit"
                />
              </form>

              <div className="flex justify-between">
                <div className="flex items-center gap-x-2">
                  <Button
                    appearance="moderate"
                    brand="neutral"
                    leftIconPath={mdiRefresh}
                    title={t("collection:browse.refresh")}
                    onClick={handleModsRefresh}
                  />

                  <Button
                    appearance="moderate"
                    brand="neutral"
                    disabled={mods.length === 0}
                    leftIconPath={mdiExport}
                    onClick={handleExportMods}
                  >
                    {t("collection:browse.mods.export")}
                  </Button>

                  <Button
                    appearance="moderate"
                    brand="neutral"
                    disabled={!isLoggedIn || modsImporting}
                    isLoading={modsImporting}
                    leftIconPath={mdiImport}
                    onClick={handleImportMods}
                  >
                    {t("collection:browse.mods.import")}
                  </Button>

                  <Typography
                    appearance="moderate"
                    brand="neutral-translucent"
                    typographyType="body-sm"
                  >
                    {t("collection:browse.resultsCount", {
                      total: numeral(modsTotalCount).format("0,0"),
                    })}
                  </Typography>
                </div>

                <Picker
                  options={MOD_SORT_OPTIONS.map((option) => ({
                    label: option.label,
                    value: option,
                  }))}
                  value={modsSortBy}
                  onChange={(value) => {
                    setModsSortBy(value);
                    setModsPage(1);
                  }}
                />
              </div>

              <Listing
                className="grid grid-cols-[repeat(auto-fit,minmax(26rem,1fr))] gap-4"
                entityCount={mods?.length}
                isError={!!modsError}
                isLoading={modsLoading}
                noResultsChildren={
                  <Button
                    appearance="moderate"
                    brand="neutral"
                    leftIconPath={mdiOpenInNew}
                    onClick={() =>
                      window.api.shell.openUrl(
                        `https://www.nexusmods.com/games/${gameDomainName}/mods`,
                      )
                    }
                  >
                    {t("collection:browse.mods.openWebsite")}
                  </Button>
                }
                noResultsMessage={t("collection:browse.mods.noMods.message")}
                noResultsTitle={t("collection:browse.mods.noMods.title")}
                skeletonCount={12}
                SkeletonTile={ModTileSkeleton}
              >
                {mods?.map((mod) => (
                  <ModTile
                    api={api}
                    isLoggedIn={isLoggedIn}
                    key={mod.id ?? mod.uid}
                    mod={mod}
                    onDownloadMod={() => handleDownloadMod(mod)}
                    onViewPage={() =>
                      window.api.shell.openUrl(
                        `https://www.nexusmods.com/${mod.game?.domainName ?? gameDomainName}/mods/${mod.modId}`,
                      )
                    }
                  />
                ))}
              </Listing>

              <Pagination
                currentPage={modsPage}
                recordsPerPage={itemsPerPage}
                scrollRef={scrollRef}
                totalRecords={modsTotalCount}
                onPaginationUpdate={(newPage) => setModsPage(newPage)}
              />
            </div>
          </TabPanel>
        </TabProvider>
      </MainPage.Body>
    </MainPage>
  );
}

export default BrowseNexusPage;
