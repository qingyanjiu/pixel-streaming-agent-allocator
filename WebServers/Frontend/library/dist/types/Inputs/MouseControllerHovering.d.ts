import { StreamMessageController } from '../UeInstanceMessage/StreamMessageController';
import { InputCoordTranslator } from '../Util/InputCoordTranslator';
import { VideoPlayer } from '../VideoPlayer/VideoPlayer';
import type { ActiveKeys } from './InputClassesFactory';
import { MouseController } from './MouseController';
import { Config } from '../Config/Config';
/**
 * A mouse controller that allows the mouse to freely float over the video document.
 */
export declare class MouseControllerHovering extends MouseController {
    videoElementParent: HTMLDivElement;
    onMouseUpListener: (event: MouseEvent) => void;
    onMouseDownListener: (event: MouseEvent) => void;
    onMouseDblClickListener: (event: MouseEvent) => void;
    onMouseWheelListener: (event: WheelEvent) => void;
    onMouseMoveListener: (event: MouseEvent) => void;
    onContextMenuListener: (event: MouseEvent) => void;
    private pressedButtons;
    constructor(streamMessageController: StreamMessageController, videoPlayer: VideoPlayer, coordinateConverter: InputCoordTranslator, activeKeys: ActiveKeys, config: Config);
    register(): void;
    unregister(): void;
    private startCapturing;
    private stopCapturing;
    /**
     * Compute (offsetX, offsetY) relative to the video element from a window-
     * level event whose `target` may be any other element on the page.
     */
    private offsetFromVideo;
    private onMouseDown;
    private onMouseUp;
    private onContextMenu;
    private onMouseMove;
    private onMouseWheel;
    private onMouseDblClick;
}
