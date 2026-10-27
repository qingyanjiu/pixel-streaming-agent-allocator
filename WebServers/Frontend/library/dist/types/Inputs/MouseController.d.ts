import { StreamMessageController } from '../UeInstanceMessage/StreamMessageController';
import { InputCoordTranslator } from '../Util/InputCoordTranslator';
import { VideoPlayer } from '../VideoPlayer/VideoPlayer';
import type { ActiveKeys } from './InputClassesFactory';
import { IInputController } from './IInputController';
import { Config } from '../Config/Config';
/**
 * Extra types for Document and WheelEvent
 */
declare global {
    interface Document {
        mozPointerLockElement: unknown;
        mozExitPointerLock?(): void;
    }
    interface WheelEvent {
        wheelDelta: number;
    }
}
/**
 * The base class for mouse controllers. Since there is a bunch of shared behaviour between locked and
 * hover mouse controllers this is where that shared behaviour lives.
 */
export declare class MouseController implements IInputController {
    videoPlayer: VideoPlayer;
    streamMessageController: StreamMessageController;
    coordinateConverter: InputCoordTranslator;
    activeKeys: ActiveKeys;
    config: Config;
    onEnterListener: (event: MouseEvent) => void;
    onLeaveListener: (event: MouseEvent) => void;
    constructor(streamMessageController: StreamMessageController, videoPlayer: VideoPlayer, coordinateConverter: InputCoordTranslator, activeKeys: ActiveKeys, config: Config);
    register(): void;
    unregister(): void;
    registerMouseEnterAndLeaveEvents(): void;
    unregisterMouseEnterAndLeaveEvents(): void;
    private onMouseEnter;
    private onMouseLeave;
    private releaseMouseButtons;
    private pressMouseButtons;
    private sendMouseDown;
    private sendMouseUp;
}
