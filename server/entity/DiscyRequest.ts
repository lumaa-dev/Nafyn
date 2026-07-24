import type { UUID } from "node:crypto";
import { DiscyUser } from "./DiscyUser";
import { MediaInfo } from "./media/MediaInfo";

export type RequestStatus = "searching" | "downloading" | "processing" | "completed" | "failed" | "waiting";

export interface DiscyRequest {
    id: UUID,
    musicbrainzId: UUID,
    info: MediaInfo | null,
    type: "album" | "track",
    status: RequestStatus,
    requestedBy: DiscyUser | UUID,
    createdAt: Date,
    updatedAt: Date
}