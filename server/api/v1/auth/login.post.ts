import bcrypt from "bcrypt";
import { getUserByUsername, getPasswordHash } from "../../../core/users";
import { consumeRateLimit, isWhitelisted, resetRateLimit } from "../../../utils/rateLimit";
import { getClientIP } from "../../../utils/clientIp";
import { signAuthToken } from "../../../utils/jwt";

const MAX_ATTEMPTS = 5;
const MAX_ATTEMPTS_PER_IP = 20;
const WINDOW_MS = 15 * 60 * 1000;

// anti account-revealer
const DUMMY_HASH = bcrypt.hashSync("LumaaDev-Nafyn-Password", 12);

defineRouteMeta({
    openAPI: {
        description: "Log in as a user using their token",
        tags: ["auth"],
        operationId: "loginUser",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["username", "password"],
                        properties: {
                            username: {
                                type: "string"
                            },
                            password: {
                                type: "string"
                            }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            properties: {
                                user: {
                                    $ref: "#/components/schemas/NafynUser"
                                },
                                token: {
                                    type: "string",
                                    description: "The logged in user's token"
                                }
                            },
                            required: ["user", "token"]
                        }
                    }
                }
            },
            "400": {
                description: "Incorrect Request",
                content: {
                    "application/json": {
                        schema: {
                            $ref: "#/components/schemas/NuxtError"
                        }
                    }
                }
            },
            "429": {
                description: "Rate limit error",
                content: {
                    "application/json": {
                        schema: {
                            $ref: "#/components/schemas/NuxtError"
                        }
                    }
                }
            }
        },
    },
});

export default defineEventHandler(async (event) => {
    const body = await readBody(event);
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!username || !password) {
        throw createError({ statusCode: 400, statusMessage: "Missing username or password" });
    }
    
    const ip = getClientIP(event);
    // both an IP-only and an IP+username bucket: the second stops a slow grind against one account, the
    // first stops the same source spraying one password across many usernames (which would otherwise get a
    // fresh 5-attempt budget per username it guesses)
    const rateLimitKey = `login:${ip}:${username.toLowerCase()}`;
    const ipRateLimitKey = `login-ip:${ip}`;

    if (!await isWhitelisted(ip)) {
        const ipRateLimit = consumeRateLimit(ipRateLimitKey, MAX_ATTEMPTS_PER_IP, WINDOW_MS);
        if (!ipRateLimit.allowed) {
            setResponseHeader(event, "Retry-After", ipRateLimit.retryAfterSeconds);
            throw createError({ statusCode: 429, statusMessage: "Too many attempts, try again later" });
        }

        const rateLimit = consumeRateLimit(rateLimitKey, MAX_ATTEMPTS, WINDOW_MS);
    
        if (!rateLimit.allowed) {
            setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
            throw createError({ statusCode: 429, statusMessage: "Too many attempts, try again later" });
        }
    }

    const passwordHash = await getPasswordHash(username);

    // always run bcrypt.compare, even for an unknown username, so early/late response timing can't leak account existence
    const valid = await bcrypt.compare(password, passwordHash ?? DUMMY_HASH);

    if (!passwordHash || !valid) {
        throw createError({ statusCode: 401, statusMessage: "Invalid username or password" });
    }

    const user = await getUserByUsername(username);
    if (!user) {
        throw createError({ statusCode: 401, statusMessage: "Invalid username or password" });
    }

    resetRateLimit(rateLimitKey);
    resetRateLimit(ipRateLimitKey);

    const token = signAuthToken(user.id);

    return { user, token };
});
