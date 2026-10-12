import { mdiCheck, mdiDownload, mdiOpenInNew, mdiThumbUp } from "@mdi/js";
import type { IMod } from "@nexusmods/nexus-api";
import numeral from "numeral";
import React, { type ComponentType, type PropsWithChildren, useEffect, useState } from "react";

import {
  HOVER_REFRESH_FLOOR,
  scheduleMembershipRefresh,
} from "@/extensions/nexus_integration/membership";
import type { IExtensionApi } from "@/types/IExtensionContext";
import { Bullet } from "@/ui/components/bullet/Bullet";
import { Button } from "@/ui/components/button/Button";
import { Icon } from "@/ui/components/icon/Icon";
import { AdultAwareImage } from "@/ui/components/image/AdultAwareImage";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

export interface IModTileProps {
  api: IExtensionApi;
  mod: Partial<IMod>;
  isLoggedIn?: boolean;
  onDownloadMod?: () => Promise<void>;
  onViewPage?: () => void;
  className?: string;
}

const Stat = ({ children, iconPath }: PropsWithChildren<{ iconPath: string }>) => (
  <div className="flex items-center gap-x-1">
    <Icon className="text-neutral-subdued" path={iconPath} size="sm" />

    <Typography appearance="moderate" typographyType="body-sm">
      {children}
    </Typography>
  </div>
);

export const ModTile: ComponentType<React.PropsWithChildren<IModTileProps>> = ({
  api,
  mod,
  isLoggedIn = true,
  onDownloadMod,
  onViewPage,
  className,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (isHovered && isLoggedIn && api?.events) {
      scheduleMembershipRefresh(api, HOVER_REFRESH_FLOOR);
    }
  }, [api, isHovered, isLoggedIn]);

  const downloadMod = () => {
    if (!pending && isLoggedIn) {
      setPending(true);
      Promise.resolve(onDownloadMod?.()).finally(() => setPending(false));
    }
  };

  const categoryName = mod.modCategory?.name ?? mod.category;

  return (
    <div
      className={joinClasses(["w-full rounded-md bg-surface-mid", className])}
      data-testid="mod-tile"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="flex items-start gap-x-3.5 p-3">
        <AdultAwareImage
          alt={mod.name ?? ""}
          className="w-full max-w-35 rounded-xs"
          fit="cover"
          imageType="mod"
          isAdult={!!mod.adultContent}
          src={mod.thumbnailUrl}
        />

        <div className="flex min-w-0 grow flex-col gap-y-1.5">
          <div className="flex flex-col gap-y-1">
            <Typography className="truncate font-semibold wrap-break-word" typographyType="body-lg">
              {mod.name}
            </Typography>

            <Typography
              appearance="moderate"
              className="flex items-center gap-x-1"
              typographyType="body-sm"
            >
              <span className="size-4 overflow-hidden rounded-full bg-surface-translucent-low">
                {!!mod.uploader?.avatar && (
                  <img
                    alt={mod.uploader?.name}
                    className="size-4 shrink-0"
                    src={mod.uploader.avatar}
                  />
                )}
              </span>

              {mod.uploader?.name ?? mod.author}
            </Typography>
          </div>

          <div className="flex items-center gap-x-1.5 border-t border-stroke-weak pt-1.5">
            <Typography brand="info" typographyType="body-sm">
              {categoryName}
            </Typography>

            {!!mod.adultContent && (
              <>
                <Bullet />

                <Typography brand="danger" typographyType="body-sm">
                  Adult
                </Typography>
              </>
            )}
          </div>

          <div className="flex items-center gap-x-5 border-t border-stroke-weak pt-1.5">
            <Stat iconPath={mdiThumbUp}>{numeral(mod.endorsements ?? 0).format("0 a")}</Stat>

            <Stat iconPath={mdiDownload}>{numeral(mod.downloads ?? 0).format("0 a")}</Stat>

            {!!mod.version && <Stat iconPath={mdiCheck}>{mod.version}</Stat>}
          </div>

          <Typography
            appearance="subdued"
            className="line-clamp-3 border-t border-stroke-weak pt-1.5 wrap-break-word"
            typographyType="body-sm"
          >
            {mod.summary}
          </Typography>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-x-2 rounded-b bg-surface-translucent-low px-3 py-2">
        {!isLoggedIn ? (
          <Button
            appearance="weak"
            brand="neutral"
            disabled={true}
            size="sm"
            title="Log in to download"
          >
            Log in to download
          </Button>
        ) : (
          <Button isLoading={pending} leftIconPath={mdiDownload} size="sm" onClick={downloadMod}>
            Download
          </Button>
        )}

        <Button
          appearance="weak"
          brand="neutral"
          leftIconPath={mdiOpenInNew}
          size="sm"
          onClick={onViewPage}
        >
          View page
        </Button>
      </div>
    </div>
  );
};
