import type { H3Event } from "h3";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { getPermissionsById } from "~~/server/core/users";
import { getTransferJobRow, hasActiveTransferJob, type TransferJobRow } from "~~/server/core/transfer";

// importing is requesting in bulk: an account that may request neither tracks nor albums has nothing to import
export async function requireImportPermission(userId: string): Promise<number> {
    const permissions = await getPermissionsById(userId) ?? 0;
    if (!hasPermission(permissions, Permission.REQUEST_TRACKS) && !hasPermission(permissions, Permission.REQUEST_ALBUMS)) {
        throw createError({ statusCode: 403, statusMessage: "Unsufficient permissions" });
    }
    return permissions;
}

// one running import per account: they share a single download queue, and a second one would only wait behind the first
export async function requireNoActiveImport(userId: string): Promise<void> {
    if (await hasActiveTransferJob(userId)) {
        throw createError({ statusCode: 409, statusMessage: "An import is already running" });
    }
}

// 404 for someone else's job as well as a missing one, so job ids can't be probed
export async function requireOwnedTransferJob(event: H3Event, userId: string): Promise<TransferJobRow> {
    const id = getRouterParam(event, "id");
    const job = id ? await getTransferJobRow(id) : null;
    if (!job || job.userId !== userId) {
        throw createError({ statusCode: 404, statusMessage: "No import with that ID" });
    }
    return job;
}
