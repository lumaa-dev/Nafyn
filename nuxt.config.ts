// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  runtimeConfig: {
    jwtSecret: process.env.JWT_SECRET || '',

    soulseekUsername: process.env.SOULSEEK_USERNAME || 'slskd',
    soulseekPassword: process.env.SOULSEEK_PASSWORD || 'slskd',
    soulseekHost: process.env.SOULSEEK_HOST || 'http://localhost:5030/',
    soulseekDownloadsPath: process.env.SOULSEEK_DOWNLOADS_PATH || '/music',

    domainsWhitelist: process.env.DOMAINS_WHITELIST || '',

    acoustidApiKey: process.env.ACOUSTID_API_KEY || ''
  },

  vite: {
    optimizeDeps: {
      include: [
        '@vue/devtools-core',
        '@vue/devtools-kit',
      ]
    }
  },

  nitro: {
    experimental: {
      websocket: true
    }
  },

  modules: [
    '@nuxt/eslint',
    '@nuxt/content',
    '@nuxtjs/color-mode',
    '@nuxtjs/device',
    '@nuxtjs/i18n',
    '@nuxt/image'
  ],

  i18n: {
    locales: [
      { code: 'en', language: 'en-US', file: 'en.json' },
      { code: 'fr', language: 'fr-FR', file: 'fr.json' }
    ],
    defaultLocale: 'en',
    langDir: 'locales',
    strategy: 'no_prefix',
    // no locale switcher yet, so the whole UI just follows the browser's language
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'discy_locale',
      alwaysRedirect: false,
      fallbackLocale: 'en'
    }
  }
})