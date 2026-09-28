import { VideoProviderLoader, type Src, type MediaContext } from 'vidstack';

// Vidstack's generic canPlayType gate can reject MOV/HEVC before a native
// video element even sees the bytes. Only our scoped, same-origin original
// endpoint may opt into a real native playback attempt.
export class ReelOriginalLoader extends VideoProviderLoader {
  override canPlay(source: Src): boolean {
    if (typeof source.src !== 'string' || !source.type.startsWith('video/')) return false;
    const url = new URL(source.src, window.location.href);
    return url.origin === window.location.origin && /^\/api\/reels\/\d+\/original$/.test(url.pathname);
  }

  override async load(context: MediaContext) {
    const provider = await super.load(context);
    const loadSource = provider.loadSource.bind(provider);
    provider.loadSource = async (source, preload) => {
      if (typeof source.src !== 'string') throw new Error('Expected scoped reel URL');
      // A <source type="video/quicktime"> can be skipped before any fetch.
      // Native video.src lets the browser inspect the response/bytes instead.
      await loadSource({ ...source, type: '?' }, preload);
      provider.currentSrc = { src: source.src, type: source.type };
    };
    return provider;
  }
}
