import { getRequestById } from "~~/server/core/requests";
import { getPermissionsById, getUserById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import type { NafynRequest } from "~~/server/entity/NafynRequest";

defineRouteMeta({
    openAPI: {
        description: "Get a single download request by ID. Only visible to the user who created it, or a MANAGE_REQUESTS user",
        tags: ["request"],
        operationId: "getRequest",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "Request ID",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NafynRequest" }
                    }
                }
            },
            "400": {
                description: "Missing request ID, or couldn't match token with user",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "No request with that ID, or not accessible to the requester",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
  const { sub: userId } = requireAuthToken(event);

  const user = await getUserById(userId);
  const reqId = getRouterParam(event, 'id');

  if (!user) {
    throw createError({ statusCode: 400, message: "Couldn't match token with user" })
  }

  if (!reqId) {
    throw createError({ statusCode: 400, message: "Missing request ID" })
  }

  const request: NafynRequest | null = await getRequestById(reqId);
  if (!request) {
    throw createError({ statusCode: 404, message: "No request with ID " + reqId })
  }

  // SECURITY: `getRequestById` resolves `requestedBy` into a full NafynUser whenever that account still
  // exists, so the old `request.requestedBy != userId` compared an object against a string and was
  // therefore *always* true - the ownership half of this check never fired, and any authenticated user
  // could read any other user's request by guessing/enumerating its ID. Resolve to the plain id first.
  const requestedById: string | undefined = typeof request.requestedBy === "string"
    ? request.requestedBy
    : request.requestedBy?.id;

  const inaccessible: boolean = requestedById !== userId && !hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_REQUESTS);
  if (inaccessible) {
    throw createError({ statusCode: 404, message: "No request with ID " + reqId })
  }

  return request;
})
