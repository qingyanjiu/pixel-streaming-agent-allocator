"use strict";
// Copyright Epic Games, Inc. All Rights Reserved.
Object.defineProperty(exports, "__esModule", { value: true });
exports.VideoPlayer = void 0;
const Config_1 = require("../Config/Config");
const lib_pixelstreamingcommon_ue5_8_1 = require("@epicgames-ps/lib-pixelstreamingcommon-ue5.8");
/**
 * The video player html element
 */
class VideoPlayer {
    /**
     * @param videoElementParent the html div the the video player will be injected into
     * @param config the applications configuration. We're interested in the startVideoMuted flag
     */
    constructor(videoElementParent, config) {
        this.lastTimeResized = new Date().getTime();
        this.videoElement = document.createElement('video');
        this.config = config;
        this.videoElement.id = 'streamingVideo';
        this.videoElement.disablePictureInPicture = true;
        this.videoElement.playsInline = true;
        this.videoElement.style.width = '100%';
        this.videoElement.style.height = '100%';
        this.videoElement.style.position = 'absolute';
        this.videoElement.style.pointerEvents = 'all';
        videoElementParent.appendChild(this.videoElement);
        this.onResizePlayerCallback = () => {
            lib_pixelstreamingcommon_ue5_8_1.Logger.Warning('Resolution changed, restyling player, did you forget to override this function?');
        };
        this.onMatchViewportResolutionCallback = () => {
            lib_pixelstreamingcommon_ue5_8_1.Logger.Warning('Resolution changed and match viewport resolution is turned on, did you forget to override this function?');
        };
        // set play for video (and audio)
        this.videoElement.onclick = () => {
            if (this.audioElement !== undefined && this.audioElement.paused) {
                void this.audioElement.play();
            }
            if (this.videoElement.paused) {
                void this.videoElement.play();
            }
        };
        this.videoElement.onloadedmetadata = () => {
            this.onVideoInitialized();
        };
        // set resize events to the windows if it is resized or its orientation is changed
        window.addEventListener('resize', () => this.resizePlayerStyle(), true);
        window.addEventListener('orientationchange', () => this.onOrientationChange());
    }
    destroy() {
        this.videoElement.src = '';
        this.videoElement.srcObject = null;
        this.videoElement.remove();
        if (this.audioElement) {
            this.audioElement.src = '';
            this.audioElement.srcObject = null;
            this.audioElement.remove();
        }
    }
    setAudioElement(audioElement) {
        this.audioElement = audioElement;
    }
    /**
     * Sets up the video element with any application config and plays the video element.
     * @returns A promise for if playing the video was successful or not.
     */
    play() {
        this.videoElement.muted = this.config.isFlagEnabled(Config_1.Flags.StartVideoMuted);
        this.videoElement.autoplay = this.config.isFlagEnabled(Config_1.Flags.AutoPlayVideo);
        return this.videoElement.play();
    }
    /**
     * @returns True if the video element is paused.
     */
    isPaused() {
        return this.videoElement.paused;
    }
    /**
     * @returns - whether the video element is playing.
     */
    isVideoReady() {
        return this.videoElement.readyState !== undefined && this.videoElement.readyState > 0;
    }
    /**
     * @returns True if the video element has a valid video source (srcObject).
     */
    hasVideoSource() {
        return this.videoElement.srcObject !== undefined && this.videoElement.srcObject !== null;
    }
    /**
     * Get the current context of the html video element
     * @returns - the current context of the video element
     */
    getVideoElement() {
        return this.videoElement;
    }
    /**
     * Get the current context of the html video elements parent
     * @returns - the current context of the video elements parent
     */
    getVideoParentElement() {
        var _a;
        return (_a = this.videoElement.parentElement) !== null && _a !== void 0 ? _a : undefined;
    }
    /**
     * Set the Video Elements src object tracks to enable
     * @param enabled - Enable Tracks on the Src Object
     */
    setVideoEnabled(enabled) {
        // this is a temporary hack until type scripts video element is updated to reflect the need for tracks on a html video element
        const videoElement = this.videoElement;
        videoElement.srcObject
            .getTracks()
            .forEach((track) => (track.enabled = enabled));
    }
    /**
     * An override for when the video has been initialized with a srcObject
     */
    onVideoInitialized() {
        // Default Functionality: Do Nothing
    }
    /**
     * On the orientation change of a window clear the timeout
     */
    onOrientationChange() {
        clearTimeout(this.orientationChangeTimeout);
        this.orientationChangeTimeout = window.setTimeout(() => {
            this.resizePlayerStyle();
        }, 500);
    }
    /**
     * Resizes the player style based on the window height and width
     * @returns - nil if requirements are satisfied
     */
    resizePlayerStyle() {
        const videoElementParent = this.getVideoParentElement();
        if (!videoElementParent) {
            return;
        }
        this.updateVideoStreamSize();
        if (videoElementParent.classList.contains('fixed-size')) {
            this.onResizePlayerCallback();
            return;
        }
        // controls for resizing the player
        this.resizePlayerStyleToFillParentElement();
        this.onResizePlayerCallback();
    }
    /**
     * Resizes the player element to fill the parent element
     */
    resizePlayerStyleToFillParentElement() {
        const videoElementParent = this.getVideoParentElement();
        //Video is not initialized yet so set videoElementParent to size of parent element
        const styleWidth = '100%';
        const styleHeight = '100%';
        const styleTop = 0;
        const styleLeft = 0;
        videoElementParent.setAttribute('style', 'top: ' +
            styleTop +
            'px; left: ' +
            styleLeft +
            'px; width: ' +
            styleWidth +
            '; height: ' +
            styleHeight +
            '; cursor: default;');
    }
    updateVideoStreamSize() {
        if (!this.config.isFlagEnabled(Config_1.Flags.MatchViewportResolution)) {
            return;
        }
        const now = new Date().getTime();
        if (now - this.lastTimeResized > 300) {
            const videoElementParent = this.getVideoParentElement();
            if (!videoElementParent) {
                return;
            }
            const viewportResolutionScale = this.config.hasNumericSetting(Config_1.NumericParameters.ViewportResScale)
                ? this.config.getNumericSettingValue(Config_1.NumericParameters.ViewportResScale)
                : 1.0;
            const scaledWidth = Math.round(videoElementParent.clientWidth * viewportResolutionScale);
            const scaledHeight = Math.round(videoElementParent.clientHeight * viewportResolutionScale);
            if (scaledWidth > VideoPlayer.maxEncoderDimension ||
                scaledHeight > VideoPlayer.maxEncoderDimension) {
                lib_pixelstreamingcommon_ue5_8_1.Logger.Warning(`Requested stream resolution (${scaledWidth}x${scaledHeight}) exceeds the common H.264 encoder limit of ${VideoPlayer.maxEncoderDimension}x${VideoPlayer.maxEncoderDimension}; encoding may fail. Lower ViewportResScale or disable MatchViewportResolution.`);
            }
            this.onMatchViewportResolutionCallback(scaledWidth, scaledHeight);
            this.lastTimeResized = new Date().getTime();
        }
        else {
            lib_pixelstreamingcommon_ue5_8_1.Logger.Info('Resizing too often - skipping');
            clearTimeout(this.resizeTimeoutHandle);
            this.resizeTimeoutHandle = window.setTimeout(() => this.updateVideoStreamSize(), 100);
        }
    }
}
exports.VideoPlayer = VideoPlayer;
// Common H.264 maximum encoding dimension. Streams beyond this commonly fail to encode.
VideoPlayer.maxEncoderDimension = 4096;
//# sourceMappingURL=VideoPlayer.js.map