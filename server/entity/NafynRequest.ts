import type { UUID } from "node:crypto";
import type { NafynUser } from "./NafynUser";
import type { MediaInfo } from "./media/MediaInfo";

// "denied" is a manager refusing a waiting request; "failed" is the download pipeline giving up
export type RequestStatus = "searching" | "downloading" | "processing" | "completed" | "failed" | "waiting" | "denied";

// statuses in which the download pipeline is working on the request right now. Such a request can't be
// deleted by anybody - ADMIN included - because the pipeline would carry on and write into a row (and a
// library) that no longer exists.
export const ACTIVE_REQUEST_STATUSES: readonly RequestStatus[] = ["searching", "downloading", "processing"];

export function isRequestActive(status: RequestStatus): boolean {
    return ACTIVE_REQUEST_STATUSES.includes(status);
}

export interface NafynRequest {
    id: UUID,
    musicbrainzId: UUID,
    info: MediaInfo | null,
    type: "album" | "track",
    status: RequestStatus,
    requestedBy: NafynUser | UUID,
    createdAt: Date,
    updatedAt: Date
}