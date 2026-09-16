// Beeps generados en el momento con Web Audio API — no dependemos de
// archivos .mp3 externos, funciona apenas se carga la página.

function playTone(frequency: number, durationMs: number, type: OscillatorType = "sine") {
  try {
    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioContextClass();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + durationMs / 1000);
    oscillator.onended = () => ctx.close();
  } catch {
    // Si el navegador bloquea audio (falta interacción previa del usuario),
    // fallamos en silencio: el feedback visual sigue funcionando igual.
  }
}

export function playOkSound() {
  playTone(880, 120);
}

export function playErrorSound() {
  playTone(180, 250, "square");
}

export function playCompleteSound() {
  playTone(660, 100);
  setTimeout(() => playTone(880, 100), 120);
  setTimeout(() => playTone(1100, 180), 240);
}
