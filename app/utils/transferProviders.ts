// display metadata for the import sources in Settings -> Import.
//
// Logos are each service's official mark (app/assets/transfer/), used unmodified in the colour its brand
// guidelines allow on a dark background - TIDAL's mark in white, the others in their brand colour - and
// always next to the service's name. Amazon Music's mark is a wordmark that already spells the name, so it
// stands alone.
import type { TransferSourceId } from '~~/server/entity/Transfer';
import spotifyLogo from '~/assets/transfer/spotify.svg';
import appleLogo from '~/assets/transfer/apple.svg';
import deezerLogo from '~/assets/transfer/deezer.svg';
import youtubeLogo from '~/assets/transfer/youtube.svg';
import soundcloudLogo from '~/assets/transfer/soundcloud.svg';
import tidalLogo from '~/assets/transfer/tidal.svg';
import amazonLogo from '~/assets/transfer/amazon.svg';
import napsterLogo from '~/assets/transfer/napster.svg';

export interface TransferSourceMeta {
  logo: string | null,
  // the logo is a wordmark carrying the service's name itself
  wordmark: boolean
}

export const TRANSFER_SOURCE_META: Record<TransferSourceId, TransferSourceMeta> = {
  spotify: { logo: spotifyLogo, wordmark: false },
  apple: { logo: appleLogo, wordmark: false },
  deezer: { logo: deezerLogo, wordmark: false },
  youtube: { logo: youtubeLogo, wordmark: false },
  soundcloud: { logo: soundcloudLogo, wordmark: false },
  tidal: { logo: tidalLogo, wordmark: false },
  amazon: { logo: amazonLogo, wordmark: true },
  napster: { logo: napsterLogo, wordmark: false },
  file: { logo: null, wordmark: false }
};

// Apple's MusicKit on the Web is the only way to obtain an Apple Music user token, so it is loaded (from
// Apple's CDN, on demand) just for the sign-in prompt; the library itself is read server-side over HTTP
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadMusicKit(): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.MusicKit) return Promise.resolve(w.MusicKit);

  return new Promise((resolve, reject) => {
    document.addEventListener('musickitloaded', () => resolve(w.MusicKit), { once: true });
    const script = document.createElement('script');
    script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
    script.async = true;
    script.onerror = () => reject(new Error('MusicKit could not be loaded'));
    document.head.appendChild(script);
  });
}

export function transferErrorMessage(e: unknown, fallback: string): string {
  return (e as { data?: { statusMessage?: string } })?.data?.statusMessage ?? fallback;
}
