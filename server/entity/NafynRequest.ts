import type { UUID } from "node:crypto";
import { NafynUser } from "./NafynUser";
import { MediaInfo } from "./media/MediaInfo";

export type RequestStatus = "searching" | "downloading" | "processing" | "completed" | "failed" | "waiting";

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