let context: AudioContext | undefined;
/** Host UI capability only. This reports scheduled WebAudio playback, not an
 * audible physical speaker or payment authorization. Never runs for operations. */
export async function playSpendSound(automatic: boolean): Promise<void> {
  if (typeof globalThis.AudioContext !== "function") throw Error("audio-api-unavailable");
  context ??= new AudioContext();
  const active = context;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      active.resume(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("audio-permission-unavailable")), 1500); }),
    ]);
    if (active.state !== "running") throw Error("audio-permission-unavailable");
    const gain = active.createGain();
    gain.gain.value = 0.12;
    gain.connect(active.destination);
    const oscillator = active.createOscillator();
    oscillator.type = "sine";
    const now = active.currentTime;
    oscillator.frequency.setValueAtTime(automatic ? 880 : 330, now);
    if (!automatic) oscillator.frequency.setValueAtTime(440, now + 0.12);
    oscillator.connect(gain);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(now);
    oscillator.stop(now + (automatic ? 0.12 : 0.28));
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
