import { requireAuthToken } from "~~/server/utils/requireAuth";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { listModels } from "~~/server/core/recOffline";

defineRouteMeta({
    openAPI: {
        description: "The bandit models (serving, retired, and every candidate the offline gate evaluated), newest first, with their offline evaluation reports (IPS, SNIPS, DM, DR and the gate's verdict). Requires ADMIN",
        tags: ["recommendations"],
        operationId: "getRecommendationModels",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: {
                                type: "object",
                                required: ["id", "level", "kind", "status", "served", "createdAt", "updatedAt"],
                                properties: {
                                    id: { type: "integer" },
                                    level: { type: "string", enum: ["shelf", "card"] },
                                    kind: { type: "string", enum: ["linucb", "neural_ts", "neural_ucb"] },
                                    status: { type: "string", enum: ["active", "candidate", "retired", "rejected"] },
                                    served: { type: "integer", description: "Pages served by this model" },
                                    metrics: { type: "object", nullable: true },
                                    createdAt: { type: "number" },
                                    updatedAt: { type: "number" }
                                }
                            }
                        }
                    }
                }
            },
            "401": { description: "Not authenticated, or not ADMIN", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    }
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.ADMIN)) {
        throw createError({ statusCode: 401, message: "Unsufficient permissions" });
    }
    return await listModels();
});
