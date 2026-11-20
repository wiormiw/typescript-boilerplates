import type { Module } from '#src/bootstrap/types.ts';
import type { AuthModuleDeps } from '#src/modules/auth/auth.types.ts';
import { authRouter } from '#src/modules/auth/router/auth.router.ts';

export function createAuthModule(deps: AuthModuleDeps): Module {
	return { name: 'auth', routes: authRouter(deps) };
}
