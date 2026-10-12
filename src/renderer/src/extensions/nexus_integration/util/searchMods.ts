import { GraphError, HTTPError, NexusError, RateLimitError } from "@nexusmods/nexus-api";
import { getErrorMessageOrDefault } from "@vortex/shared";

import { log } from "../../../logging";
import type { IExtensionApi } from "../../../types/IExtensionContext";
import { getApplication } from "../../../util/application";
import { NEXUS_API_URL } from "../constants";
import { hasConfidentialWithNexus } from "../guards";
import type { IModSearchOptions, IModSearchResult } from "../types/IModSearch";
import { getAccessToken } from "./oauthSession";

const REQUEST_TIMEOUT_MS = 30000;

const MODS_SEARCH_QUERY = `query modsSearch($filter: ModsFilter, $sort: [ModsSort!], $offset: Int, $count: Int) {
  mods(filter: $filter, sort: $sort, offset: $offset, count: $count) {
    totalCount
    nodes {
      id
      modId
      uid
      name
      summary
      author
      category
      modCategory { id name }
      endorsements
      downloads
      fileSize
      version
      createdAt
      updatedAt
      pictureUrl
      thumbnailUrl
      thumbnailLargeUrl
      thumbnailBlurredUrl
      thumbnailLargeBlurredUrl
      adultContent
      status
      game { id domainName name }
      uploader { name avatar memberId }
    }
  }
}`;

function graphQLUrl(): string {
  return `${NEXUS_API_URL}/v2/graphql`;
}

function searchFilter(options: IModSearchOptions): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    op: "AND",
    gameDomainName: [{ op: "EQUALS", value: options.gameId }],
    status: [{ op: "EQUALS", value: "published" }],
  };
  if (options.search !== undefined && options.search.trim().length > 0) {
    filter["name"] = [{ op: "WILDCARD", value: options.search.trim() }];
  }
  if (options.adultContent !== undefined) {
    filter["adultContent"] = [{ op: "EQUALS", value: options.adultContent }];
  }
  return filter;
}

function searchVariables(options: IModSearchOptions): Record<string, unknown> {
  const { field = "endorsements", direction = "DESC" } = options.sort ?? {};
  return {
    count: options.count ?? 20,
    offset: options.offset ?? 0,
    filter: searchFilter(options),
    sort: [{ [field]: { direction } }],
  };
}

function graphError(errors: ReadonlyArray<Record<string, any>>): GraphError {
  const codeEntry = errors.find((iter) => iter?.extensions?.code !== undefined);
  const entries = errors.map((err) => ({
    message: err.message,
    path: err.path,
    locations: err.locations,
    code: err.extensions?.code,
  }));
  return new GraphError(
    codeEntry?.message ?? entries[0]?.message ?? "GraphQL request failed",
    codeEntry?.extensions?.code,
    [],
    entries,
    MODS_SEARCH_QUERY,
  );
}

async function postSearch(
  api: IExtensionApi,
  variables: Record<string, unknown>,
  token: string | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `Vortex/${getApplication().version}`,
  };
  if (token !== undefined) {
    headers["Authorization"] = `Bearer ${token}`;
  } else {
    const { confidential } = api.getState();
    const apiKey = hasConfidentialWithNexus(confidential)
      ? confidential.account.nexus?.APIKey
      : undefined;
    if (apiKey !== undefined) {
      headers["apikey"] = apiKey;
    }
  }
  return fetch(graphQLUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify({ query: MODS_SEARCH_QUERY, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export async function searchMods(
  api: IExtensionApi,
  options: IModSearchOptions,
): Promise<IModSearchResult> {
  const variables = searchVariables(options);

  let token = await getAccessToken(api);
  let response = await postSearch(api, variables, token);
  if (response.status === 401 && token !== undefined) {
    const fresh = await getAccessToken(api, token).catch((err) => {
      log("warn", "OAuth refresh refused during mods search", {
        message: getErrorMessageOrDefault(err),
      });
      return undefined;
    });
    if (fresh !== undefined && fresh !== token) {
      token = fresh;
      response = await postSearch(api, variables, token);
    }
  }

  if (response.status === 429) {
    throw new RateLimitError();
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new HTTPError(response.status, response.statusText, bodyText, graphQLUrl());
  }

  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new NexusError(
      "API currently not reachable, please try again later.",
      response.status,
      graphQLUrl(),
      "API_UNREACHABLE",
    );
  }

  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw graphError(body.errors);
  }

  const page = body.data?.mods;
  return { nodes: page?.nodes ?? [], totalCount: page?.totalCount ?? 0 };
}
