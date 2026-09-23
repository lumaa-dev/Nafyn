import type { TransferProviderId, TransferProviderStatus } from "~~/server/entity/Transfer";
import type { TransferProvider } from "../types";
import { spotifyProvider } from "./spotify";
import { appleProvider } from "./apple";
import { deezerProvider } from "./deezer";
import { soundcloudProvider } from "./soundcloud";
import { youtubeProvider } from "./youtube";
import { tidalProvider } from "./tidal";
import { amazonProvider } from "./amazon";
import { napsterProvider } from "./napster";

// display order in Settings -> Import
export const TRANSFER_PROVIDERS: TransferProvider[] = [
    spotifyProvider,
    appleProvider,
    deezerProvider,
    youtubeProvider,
    soundcloudProvider,
    tidalProvider,
    amazonProvider,
    napsterProvider
];

export function getTransferProvider(id: unknown): TransferProvider | null {
    return TRANSFER_PROVIDERS.find((p) => p.id === id) ?? null;
}

export function transferProviderStatuses(): TransferProviderStatus[] {
    return TRANSFER_PROVIDERS.map((p) => ({ id: p.id as TransferProviderId, configured: p.isConfigured(), authModes: p.authModes() }));
}
