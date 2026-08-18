import bcrypt from "bcrypt";
import { createUser, isUsernameTaken, listUsers } from "../../../core/users";
import { consumeRateLimit, isWhitelisted } from "../../../utils/rateLimit";
import { signAuthToken } from "../../../utils/jwt";
import { Permission } from "../../../entity/Permission";
import { isRegistrationOpen } from "../../../core/appSettings";
import { validateRegisterToken, consumeRegisterToken } from "../../../core/registerTokens";
import { assertValidUsername } from "../../../utils/validation";

const MAX_ATTEMPTS = 3;
const WINDOW_MS = 60 * 60 * 1000;

const MIN_PASSWORD_LENGTH = 8;

defineRouteMeta({
    openAPI: {
        description: "Create a new user",
        tags: ["auth"],
        operationId: "registerUser",
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
                            },
                            token: {
                                type: "string",
                                description: "Required only when open registration is disabled"
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
                                    description: "The created user's token"
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
        $global: {
            components: {
                schemas: {
                    NafynUser: {
                        type: "object",
                        required: ["id", "username", "permissions"],
                        properties: {
                            id: {
                                type: "string",
                                description: "The user's identifier"
                            },
                            username: {
                                type: "string"
                            },
                            displayName: {
                                type: "string"
                            },
                            avatar: {
                                type: "string",
                                description: "The user's avatar URL"
                            },
                            permissions: {
                                type: ["array", "number"],
                                description: "The user's current permissions"
                            },
                            lastFm: {
                                type: "string"
                            },
                            discogs: {
                                type: "string"
                            }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const ip = getRequestIP(event, { xForwardedFor: true }) ?? "unknown";    
    if (!isWhitelisted(ip)) {
        const rateLimit = consumeRateLimit(`register:${ip}`, MAX_ATTEMPTS, WINDOW_MS);
    
        if (!rateLimit.allowed) {
            setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
            throw createError({ statusCode: 429, statusMessage: "Too many attempts, try again later" });
        }
    }

    const body = await readBody(event);
    const username: string = typeof body?.username === "string" ? body.username.trim() : "";
    const password: string = typeof body?.password === "string" ? body.password : "";

    const registerToken = typeof body?.token === "string" ? body.token : "";
    let tokenRow = null;
    if (!isRegistrationOpen()) {
        tokenRow = validateRegisterToken(registerToken);
        if (!tokenRow) {
            throw createError({ statusCode: 404, statusMessage: "Not found" });
        }
    }

    assertValidUsername(username);

    if (password.length < MIN_PASSWORD_LENGTH) {
        throw createError({ statusCode: 400, statusMessage: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    if (isUsernameTaken(username)) {
        throw createError({ statusCode: 409, statusMessage: "Username is already taken" });
    }

    let defaultPerms: Permission | Permission[] = listUsers().length <= 0 ? Permission.ADMIN : [Permission.REQUEST_TRACKS, Permission.REQUEST_ALBUMS];

    const passwordHash = bcrypt.hashSync(password, 12);

    const user = createUser({
        username,
        displayName: null,
        avatar: null,
        permissions: defaultPerms,
        lastFm: null,
        discogs: null
    }, passwordHash);

    if (tokenRow) {
        consumeRegisterToken(tokenRow.id);
    }

    const token = signAuthToken(user.id);

    return { user, token };
});
