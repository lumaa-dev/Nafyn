// thin wrapper over @simplewebauthn/server: derives rpID/origin from the request instead of a fixed env var,
// since Nafyn is self-hosted and can live on any domain the operator picks.
import type { H3Event } from "h3";
import {
    generateRegistrationOptions,
    generateAuthenticationOptions,
    verifyRegistrationResponse,
    verifyAuthenticationResponse
} from "@simplewebauthn/server";

export const RP_NAME = "Nafyn";

// WebAuthn's rpID must be the request's hostname with no scheme/port - verifyRegistrationResponse/
// verifyAuthenticationResponse both reject a mismatch, so this must stay in lockstep with originFromEvent()
// below (same host, this function just drops the scheme/port).
export function rpIdFromEvent(event: H3Event): string {
    const host = getRequestHost(event, { xForwardedHost: true });
    return host.split(":")[0]!;
}

// origin WebAuthn callers (the browser) report back must match this exactly, including scheme - getRequestURL
// already respects X-Forwarded-Proto/Host when Nitro trusts the proxy (see nitro.devProxy / NITRO_NO_SSL in
// h3), matching what the browser actually used to reach us.
export function originFromEvent(event: H3Event): string {
    const url = getRequestURL(event);
    return `${url.protocol}//${url.host}`;
}

export { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse };
