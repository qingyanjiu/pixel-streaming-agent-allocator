import { AggregatedStats, LatencyInfo, SettingNumber } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.8';
/**
 * Session test UI elements and results handling.
 * Creates a button to start the test and collects stats and latency info during the test.
 * After the test is finished, it generates CSV files for stats and latency info.
 * The test runs for a specified time frame, which can be set in the UI.
 */
export declare class SessionTest {
    _rootElement: HTMLElement;
    _latencyTestButton: HTMLInputElement;
    _testTimeFrameSetting: SettingNumber<'TestTimeFrame'>;
    isCollectingStats: boolean;
    records: AggregatedStats[];
    latencyRecords: LatencyInfo[];
    constructor();
    /**
     * Make the elements for the session test: e.g. button and test time input.
     */
    get rootElement(): HTMLElement;
    get latencyTestButton(): HTMLInputElement;
    handleStats(stats: AggregatedStats): void;
    handleLatencyInfo(latencyInfo: LatencyInfo): void;
    private onCollectingFinished;
    private generateStatsCsv;
    private generateLatencyCsv;
}
