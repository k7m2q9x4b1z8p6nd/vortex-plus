import type { IMod, SortDirection } from "@nexusmods/nexus-api";

export type ModSortField =
  | "relevance"
  | "name"
  | "downloads"
  | "uniqueDownloads"
  | "endorsements"
  | "createdAt"
  | "updatedAt"
  | "size"
  | "lastComment";

export interface IModSearchOptions {
  gameId: string;
  count?: number;
  offset?: number;
  sort?: { field: ModSortField; direction: SortDirection };
  search?: string;
  adultContent?: boolean;
}

export interface IModSearchResult {
  nodes: Partial<IMod>[];
  totalCount: number;
}
