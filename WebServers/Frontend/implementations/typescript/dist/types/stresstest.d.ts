import { Application } from '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.8';
export declare class PixelStreamingFrame {
    element: HTMLElement;
    pixelStreamingApp: Application;
    constructor(element: HTMLElement, pixelStreamingApp: Application);
}
export declare class StressTester {
    play: boolean;
    maxPeers: number;
    totalStreams: number;
    streamCreationIntervalMs: number;
    streamDeletionIntervalMs: number;
    pixelStreamingFrames: Array<PixelStreamingFrame>;
    creationIntervalHandle: number;
    deletionIntervalHandle: number;
    streamsContainer: HTMLElement;
    constructor();
    startStressTest(): void;
    private setupNumPeersSlider;
    private startStreamCreation;
    private startStreamDeletion;
    private setupPlayPause;
    private createPixelStreamingFrame;
    private updateTotalStreams;
}
