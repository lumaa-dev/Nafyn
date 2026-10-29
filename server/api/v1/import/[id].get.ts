import { getImport } from "~~/server/core/imports";

defineRouteMeta({
    openAPI: {
        description: "One of the caller's playlist imports, with every track's outcome. Poll this while `status` is `running`",
        tags: ["import"],
        operationId: "getImport",
        parameters: [
            { name: "id", in: "path", required: true, description: "Import ID", schema: { type: "string" } }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            allOf: [
                                { $ref: "#/components/schemas/PlaylistImport" },
                                {
                                    type: "object",
                                    required: ["items"],
                                    properties: { items: { type: "array", items: { $ref: "#/components/schemas/PlaylistImportItem" } } }
                                }
                            ]
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No such import for this user", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const id = getRouterParam(event, "id") ?? "";
    // only the caller's own imports: another user's id is as unknown as a made-up one
    const job = /^[0-9a-f-]{36}$/i.test(id) ? await getImport(id, userId) : null;
    if (!job) throw createError({ statusCode: 404, message: "No such import" });
    return job;
});
