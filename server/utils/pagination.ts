import type { H3Event } from "h3";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export interface PaginationParams {
    page: number,
    limit: number,
    offset: number
}

export interface Paginated<T> {
    items: T[],
    page: number,
    limit: number,
    total: number,
    hasMore: boolean
}

// reads `?page=&limit=` off the query string, clamped to sane bounds (page >= 1, 1 <= limit <= MAX_PAGE_LIMIT)
export function parsePagination(event: H3Event, defaultLimit: number = DEFAULT_PAGE_LIMIT): PaginationParams {
    const query = getQuery(event);

    let page = Number(query.page);
    if (!Number.isFinite(page) || page < 1) page = 1;
    page = Math.floor(page);

    let limit = Number(query.limit);
    if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
    limit = Math.min(Math.floor(limit), MAX_PAGE_LIMIT);

    return { page, limit, offset: (page - 1) * limit };
}

export function paginated<T>(items: T[], total: number, { page, limit }: PaginationParams): Paginated<T> {
    return { items, page, limit, total, hasMore: page * limit < total };
}

// shared OpenAPI fragments for endpoints using the above
export const paginationQueryParams = [
    { name: "page", in: "query", required: false, description: "1-indexed page number, defaults to 1", schema: { type: "integer", minimum: 1, default: 1 } },
    { name: "limit", in: "query", required: false, description: `Items per page, defaults to ${DEFAULT_PAGE_LIMIT}, capped at ${MAX_PAGE_LIMIT}`, schema: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT } }
];

export function paginatedResponseSchema(itemsRef: string) {
    return {
        type: "object",
        required: ["items", "page", "limit", "total", "hasMore"],
        properties: {
            items: { type: "array", items: { $ref: itemsRef } },
            page: { type: "integer" },
            limit: { type: "integer" },
            total: { type: "integer", description: "Total number of items across every page" },
            hasMore: { type: "boolean", description: "Whether a further page exists" }
        }
    };
}
