import type { UUID } from "node:crypto";
import { NafynUser } from "./NafynUser";
import { MediaInfo } from "./media/MediaInfo";

// "denied" is a manager refusing a waiting request; "failed" is the download pipeline giving up
export type RequestStatus = "searching" | "downloading" | "processing" | "completed" | "failed" | "waiting" | "denied";

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