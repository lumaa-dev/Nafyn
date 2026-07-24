declare module "fpcalc" {
    export interface FpcalcResult {
        file: string,
        duration: number,
        fingerprint: string
    }

    export interface FpcalcOptions {
        length?: number,
        raw?: boolean,
        command?: string
    }

    function fpcalc(file: string, callback: (err: Error | null, result: FpcalcResult) => void): void;
    function fpcalc(file: string, options: FpcalcOptions, callback: (err: Error | null, result: FpcalcResult) => void): void;

    export default fpcalc;
}
