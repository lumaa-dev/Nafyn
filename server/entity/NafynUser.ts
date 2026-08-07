import { Permission } from "./Permission";

export interface NafynUser {
    id: string,
    username: string,
    displayName: string | null,
    avatar: string | null,
    permissions: Permission[] | number,
    lastFm: string | null,
    discogs: string | null
}