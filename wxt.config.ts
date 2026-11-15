import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  manifest: {
    name: 'PLaMo Page Translator',
    description:
      'Translate web pages with a local PLaMo 3 Translate server. Translation-only, inline-safe.',
    permissions: ['storage', 'activeTab'],
    host_permissions: [
      '<all_urls>',
      'http://127.0.0.1/*',
      'https://generativelanguage.googleapis.com/*',
    ],
    browser_specific_settings: {
      gecko: {
        id: 'plamo-page-translator@local',
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['websiteContent'],
        },
      },
      gecko_android: {
        strict_min_version: '142.0',
      },
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    commands: {
      'toggle-translation': {
        suggested_key: { default: 'Alt+T' },
        description: 'Toggle page translation',
      },
    },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
  },
});
