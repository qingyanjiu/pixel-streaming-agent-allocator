"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MouseControllerHovering = void 0;
const MouseController_1 = require("./MouseController");
const Config_1 = require("../Config/Config");
/**
 * A mouse controller that allows the mouse to freely float over the video document.
 */
class MouseControllerHovering extends MouseController_1.MouseController {
    constructor(streamMessageController, videoPlayer, coordinateConverter, activeKeys, config) {
        super(streamMessageController, videoPlayer, coordinateConverter, activeKeys, config);
        // Buttons currently held down. While non-empty, mousemove/mouseup are
        // listened for on `window` rather than the video element so the press is
        // tracked even when the cursor leaves the element. UE pairs every
        // MouseDown with a later MouseUp; without this the engine can be left
        // with a stuck button when the user releases outside the video element.
        this.pressedButtons = new Set();
        this.videoElementParent = videoPlayer.getVideoParentElement();
        this.onMouseUpListener = this.onMouseUp.bind(this);
        this.onMouseDownListener = this.onMouseDown.bind(this);
        this.onMouseDblClickListener = this.onMouseDblClick.bind(this);
        this.onMouseWheelListener = this.onMouseWheel.bind(this);
        this.onMouseMoveListener = this.onMouseMove.bind(this);
        this.onContextMenuListener = this.onContextMenu.bind(this);
    }
    register() {
        super.register();
        this.videoElementParent.addEventListener('mousemove', this.onMouseMoveListener);
        this.videoElementParent.addEventListener('mousedown', this.onMouseDownListener);
        this.videoElementParent.addEventListener('mouseup', this.onMouseUpListener);
        this.videoElementParent.addEventListener('contextmenu', this.onContextMenuListener);
        this.videoElementParent.addEventListener('wheel', this.onMouseWheelListener);
        this.videoElementParent.addEventListener('dblclick', this.onMouseDblClickListener);
    }
    unregister() {
        this.videoElementParent.removeEventListener('mousemove', this.onMouseMoveListener);
        this.videoElementParent.removeEventListener('mousedown', this.onMouseDownListener);
        this.videoElementParent.removeEventListener('mouseup', this.onMouseUpListener);
        this.videoElementParent.removeEventListener('contextmenu', this.onContextMenuListener);
        this.videoElementParent.removeEventListener('wheel', this.onMouseWheelListener);
        this.videoElementParent.removeEventListener('dblclick', this.onMouseDblClickListener);
        // If a button was held when unregister was called, clean up the
        // window-level listeners too.
        if (this.pressedButtons.size > 0) {
            window.removeEventListener('mousemove', this.onMouseMoveListener);
            window.removeEventListener('mouseup', this.onMouseUpListener);
            this.pressedButtons.clear();
        }
        super.unregister();
    }
    startCapturing() {
        // Move move/up listeners off the element and onto the window so they
        // keep firing while the cursor is outside the video.
        this.videoElementParent.removeEventListener('mousemove', this.onMouseMoveListener);
        this.videoElementParent.removeEventListener('mouseup', this.onMouseUpListener);
        window.addEventListener('mousemove', this.onMouseMoveListener);
        window.addEventListener('mouseup', this.onMouseUpListener);
    }
    stopCapturing() {
        window.removeEventListener('mousemove', this.onMouseMoveListener);
        window.removeEventListener('mouseup', this.onMouseUpListener);
        this.videoElementParent.addEventListener('mousemove', this.onMouseMoveListener);
        this.videoElementParent.addEventListener('mouseup', this.onMouseUpListener);
    }
    /**
     * Compute (offsetX, offsetY) relative to the video element from a window-
     * level event whose `target` may be any other element on the page.
     */
    offsetFromVideo(event) {
        if (event.currentTarget === this.videoElementParent) {
            return { x: event.offsetX, y: event.offsetY };
        }
        const rect = this.videoElementParent.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }
    onMouseDown(event) {
        if (!this.videoPlayer.isVideoReady()) {
            return;
        }
        const off = this.offsetFromVideo(event);
        const coord = this.coordinateConverter.translateUnsigned(off.x, off.y);
        this.streamMessageController.toStreamerHandlers.get('MouseDown')([event.button, coord.x, coord.y]);
        event.preventDefault();
        if (this.pressedButtons.size === 0) {
            this.startCapturing();
        }
        this.pressedButtons.add(event.button);
    }
    onMouseUp(event) {
        if (!this.videoPlayer.isVideoReady()) {
            return;
        }
        const off = this.offsetFromVideo(event);
        const coord = this.coordinateConverter.translateUnsigned(off.x, off.y);
        this.streamMessageController.toStreamerHandlers.get('MouseUp')([event.button, coord.x, coord.y]);
        event.preventDefault();
        this.pressedButtons.delete(event.button);
        if (this.pressedButtons.size === 0) {
            this.stopCapturing();
        }
    }
    onContextMenu(event) {
        if (!this.videoPlayer.isVideoReady()) {
            return;
        }
        event.preventDefault();
    }
    onMouseMove(event) {
        if (!this.videoPlayer.isVideoReady()) {
            return;
        }
        const off = this.offsetFromVideo(event);
        const coord = this.coordinateConverter.translateUnsigned(off.x, off.y);
        const delta = this.coordinateConverter.translateSigned(event.movementX, event.movementY);
        this.streamMessageController.toStreamerHandlers.get('MouseMove')([
            coord.x,
            coord.y,
            delta.x,
            delta.y
        ]);
        // Only call preventDefault when the event originated on the video
        // element. On window-level events the target may be a page element
        // for which preventDefault would be wrong.
        if (event.currentTarget === this.videoElementParent) {
            event.preventDefault();
        }
    }
    onMouseWheel(event) {
        if (!this.videoPlayer.isVideoReady()) {
            return;
        }
        const coord = this.coordinateConverter.translateUnsigned(event.offsetX, event.offsetY);
        this.streamMessageController.toStreamerHandlers.get('MouseWheel')([
            event.wheelDelta,
            coord.x,
            coord.y
        ]);
        event.preventDefault();
    }
    onMouseDblClick(event) {
        if (!this.videoPlayer.isVideoReady()) {
            return;
        }
        const coord = this.coordinateConverter.translateUnsigned(event.offsetX, event.offsetY);
        this.streamMessageController.toStreamerHandlers.get('MouseDouble')([event.button, coord.x, coord.y]);
        // The streamer plugin treats `MouseDouble` as a press-class event (it routes to
        // Slate's RoutePointerDoubleClickEvent / IGenericApplicationMessageHandler::OnMouseDoubleClick)
        // but never synthesizes the matching release. The browser's preceding `mouseup` was
        // already consumed by the prior `MouseUp` message, so without this UE is left thinking
        // the button is still held — manifesting as e.g. camera pans that latch on after a
        // double-click. See issue #10.
        // Disable Flags.MouseDoubleClickAutoRelease to restore the pre-fix behaviour.
        if (this.config.isFlagEnabled(Config_1.Flags.MouseDoubleClickAutoRelease)) {
            this.streamMessageController.toStreamerHandlers.get('MouseUp')([event.button, coord.x, coord.y]);
        }
    }
}
exports.MouseControllerHovering = MouseControllerHovering;
//# sourceMappingURL=MouseControllerHovering.js.map