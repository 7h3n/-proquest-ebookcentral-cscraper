import { defineConfig } from 'wxt';

import sites from './components/sites';
import { stripCdnPlugin } from './components/stripCdnPlugin';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [stripCdnPlugin()],
  }),
  manifest: ({ browser }) => {
    // No listener blocks or changes requests, so 'webRequestBlocking' isn't needed (Chrome MV3 rejects it anyway)
    const permissions: string[] = ['storage', 'scripting', 'tabs', 'webRequest'];
    switch (browser) {
      case 'chrome':
        permissions.push('declarativeContent');
        break;
      case 'firefox':
        permissions.push('declarativeNetRequest');
        break;
    }
    return {
      permissions,
      host_permissions: sites.map((site) => site.urlScope),
      content_security_policy: {
        extension_pages: "script-src 'self'; object-src 'self';",
      },
    };
  },
});
