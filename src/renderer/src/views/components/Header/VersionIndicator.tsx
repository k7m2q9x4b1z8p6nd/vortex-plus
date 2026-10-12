import { mdiRefresh } from "@mdi/js";
import React, { type FC, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";

import { getUpdaterStatus } from "@/extensions/updater/updaterStatus";
import type { IState } from "@/types/IState";
import { Button } from "@/ui/components/button/Button";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";

import { getApplication } from "../../../util/application";

export const VersionIndicator: FC<React.PropsWithChildren<unknown>> = () => {
  const { t } = useTranslation();
  const version = getApplication().version;
  const updateChannel = useSelector((state: IState) => state.settings.update.channel);
  const checking = useSelector(
    (state: IState) => state.session.updater?.snapshot?.state.type === "checking",
  );

  const checkForUpdates = useCallback(() => {
    const channel = updateChannel === "none" ? "stable" : updateChannel;
    window.api.updater.checkForUpdates(channel, true);
    getUpdaterStatus()?.wake();
  }, [updateChannel]);

  return (
    <Tooltip content={t("Check for updates")} placement="bottom">
      <Button
        appearance="weak"
        aria-label={t("Check for updates")}
        brand="neutral"
        className="text-translucent-weaker!"
        data-testid="version-indicator"
        isLoading={checking}
        leftIconPath={mdiRefresh}
        size="sm"
        onClick={checkForUpdates}
      >
        {`v${version}`}
      </Button>
    </Tooltip>
  );
};
