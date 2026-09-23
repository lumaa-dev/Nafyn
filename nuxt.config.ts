// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  // no home page yet - land on the tracks library instead
  routeRules: {
    '/': { redirect: '/l/tracks' }
  },

  app: {
    head: {
      title: 'Nafyn',
      link: [
        { rel: 'manifest', href: '/manifest.json' }
      ],
      meta: [
        { name: 'theme-color', content: '#000000' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
        { name: 'apple-mobile-web-app-title', content: 'Nafyn' }
      ]
    }
  },

  runtimeConfig: {
    jwtSecret: process.env.JWT_SECRET || '',

    soulseekUsername: process.env.SOULSEEK_USERNAME || 'slskd',
    soulseekPassword: process.env.SOULSEEK_PASSWORD || 'slskd',
    soulseekHost: process.env.SOULSEEK_HOST || 'http://localhost:5030/',
    soulseekDownloadsPath: process.env.SOULSEEK_DOWNLOADS_PATH || '/music',

    domainsWhitelist: process.env.DOMAINS_WHITELIST || '',

    acoustidApiKey: process.env.ACOUSTID_API_KEY || '',
    lastfmApiKey: process.env.LASTFM_API_KEY || '',

    // Settings -> Import: developer credentials per streaming service. A service whose credentials are
    // missing still shows up, just greyed out (see server/utils/transfer/providers/)
    transfer: {
      publicUrl: process.env.NAFYN_PUBLIC_URL || '',
      spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
      spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
      appleMusicTeamId: process.env.APPLE_MUSIC_TEAM_ID || '',
      appleMusicKeyId: process.env.APPLE_MUSIC_KEY_ID || '',
      appleMusicPrivateKey: process.env.APPLE_MUSIC_PRIVATE_KEY || '',
      deezerAppId: process.env.DEEZER_APP_ID || '',
      deezerAppSecret: process.env.DEEZER_APP_SECRET || '',
      soundcloudClientId: process.env.SOUNDCLOUD_CLIENT_ID || '',
      soundcloudClientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET || '',
      googleClientId: process.env.GOOGLE_CLIENT_ID || '',
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      tidalClientId: process.env.TIDAL_CLIENT_ID || '',
      tidalClientSecret: process.env.TIDAL_CLIENT_SECRET || '',
      amazonClientId: process.env.AMAZON_MUSIC_CLIENT_ID || '',
      amazonClientSecret: process.env.AMAZON_MUSIC_CLIENT_SECRET || '',
      amazonApiKey: process.env.AMAZON_MUSIC_API_KEY || '',
      napsterApiKey: process.env.NAPSTER_API_KEY || '',
      napsterApiSecret: process.env.NAPSTER_API_SECRET || ''
    }
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
      websocket: true,
      openAPI: true
    },
    openAPI: {
      production: "runtime",
      meta: {
        title: "Nafyn API",
        description: "Nafyn API to easily control Soulseek from any HTTP client, including the Nafyn web interface.",
        version: "1.0.0"
      },
      ui: {
        scalar: {
          theme: "nuxt"
        }
      }
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
      cookieKey: 'nafyn_locale',
      alwaysRedirect: false,
      fallbackLocale: 'en'
    }
  }
})