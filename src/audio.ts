// Simulación de base de datos de canciones
const fakeAudioDB: Record<string, string> = {
  default: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
};

export function getAudioUrl(trackId: string): string {
  return fakeAudioDB[trackId] || fakeAudioDB['default'];
}