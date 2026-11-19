export const masterKey = (videoId: string) => `uploads/${videoId}/master`;
export const hlsPrefix = (videoId: string) => `hls/${videoId}`;
export const masterManifestKey = (videoId: string) => `${hlsPrefix(videoId)}/master.m3u8`;
export const posterKey = (videoId: string) => `${hlsPrefix(videoId)}/poster.jpg`;