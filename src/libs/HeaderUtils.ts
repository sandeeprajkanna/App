import * as Expensicons from '@components/Icon/Expensicons';
import OnyxReport from '@src/types/onyx/Report';
import IconAsset from '@src/types/utils/IconAsset';
import * as Report from './actions/Report';
import * as Session from './actions/Session';
import * as Localize from './Localize';

type MenuItem = {
    icon: IconAsset;
    text: string;
    onSelected: () => void;
};

function getPinMenuItem(report: OnyxReport): MenuItem {
    const isPinned = !!report.isPinned;

    return {
        icon: Expensicons.Pin,
        text: Localize.translateLocal(isPinned ? 'common.unPin' : 'common.pin'),
        onSelected: Session.checkIfActionIsAllowed(() => Report.togglePinnedState(report.reportID, isPinned)),
    };
}

export {
    // eslint-disable-next-line import/prefer-default-export
    getPinMenuItem,
};
