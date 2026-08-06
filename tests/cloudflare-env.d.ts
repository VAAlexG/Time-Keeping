import type { Env as TimekeeperEnv } from '../worker/env';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends TimekeeperEnv {
    TEST_MIGRATIONS: D1Migration[];
  }
}

declare global {
  namespace Cloudflare {
    interface Env extends TimekeeperEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
