export * from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.8';
export * from '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.8';
import { PixelStreaming } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.8';
declare global {
    interface Window {
        pixelStreaming: PixelStreaming;
    }
}
