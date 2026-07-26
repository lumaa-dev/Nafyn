import { getUserById, updateUser } from "~~/server/core/users";
import type { DiscyUser } from "~~/server/entity/DiscyUser";

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") {
        throw createError({ statusCode: 400, statusMessage: "Must be a string or null" });
    }

    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
        throw createError({ statusCode: 400, statusMessage: `Must be ${maxLength} characters or fewer` });
    }

    return trimmed.length ? trimmed : null;
}

export default defineEventHandler(async (event) => {
    const { sub } = requireAuthToken(event);
    const body = await readBody(event);

    const changes: Partial<Pick<DiscyUser, "displayName" | "lastFm" | "discogs">> = {};

    if ("displayName" in body) {
        const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
        if (displayName.length < 1 || displayName.length > 20) {
            throw createError({ statusCode: 400, statusMessage: "displayName must be between 1 and 20 characters" });
        }
        changes.displayName = displayName;
    }

    if ("lastFm" in body) {
        changes.lastFm = normalizeOptionalText(body.lastFm, 50);
    }

    if ("discogs" in body) {
        changes.discogs = normalizeOptionalText(body.discogs, 50);
    }

    if (Object.keys(changes).length === 0) {
        throw createError({ statusCode: 400, statusMessage: "No changes provided" });
    }

    if (!getUserById(sub)) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    return updateUser(sub, changes);
});
