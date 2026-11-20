import { getConnInfo } from '@hono/bun';
import type { Context } from 'hono';
import type { AppEnv } from '#src/shared/http/types.ts';

/**
 * The header better-auth reads the client address from (`advanced.ipAddress.ipAddressHeaders`).
 * Never trusted from the client: `withClientAddress` overwrites or removes it on every request.
 * better-auth's default, `x-forwarded-for`, is any client's to set, so with it a caller could
 * pick a new rate-limit bucket per request and choose the address recorded on its session.
 */
export const CLIENT_ADDRESS_HEADER = 'x-starter-client-address';

/**
 * The request with the socket's peer address in `CLIENT_ADDRESS_HEADER`, whatever the client sent.
 * The API listens directly, so the peer is the client. A proxy in front (Caddy, B10) will need its
 * address resolved from `x-forwarded-for` against a trusted-proxy list instead.
 */
export function withClientAddress<E extends AppEnv>(c: Context<E>): Request {
	const headers = new Headers(c.req.raw.headers);
	headers.delete(CLIENT_ADDRESS_HEADER);
	const address = peerAddress(c);
	if (address) headers.set(CLIENT_ADDRESS_HEADER, address);
	return new Request(c.req.raw, { headers });
}

/** The socket's peer, or undefined without a Bun server (`app.request` in tests). */
function peerAddress<E extends AppEnv>(c: Context<E>): string | undefined {
	try {
		return getConnInfo(c).remote.address;
	} catch {
		return undefined;
	}
}
