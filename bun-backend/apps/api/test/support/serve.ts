/**
 * A real server on a free loopback port, for the few tests that need a socket (a peer address,
 * real connection handling). The test side's one counterpart to main.ts: the structure test lets
 * only these two start a server. Stop it with `server.stop(true)`.
 */
export const serveOnLoopback = (
	fetch: (request: Request, server: Bun.Server<undefined>) => Response | Promise<Response>,
) => Bun.serve({ port: 0, hostname: '127.0.0.1', fetch });
