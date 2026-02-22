"use client";

import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [status, setStatus] = useState<string>("");

  async function handleSubmit() {
    if (!file) return setStatus("Escolha um vídeo primeiro.");
    if (!scheduledAt) return setStatus("Escolha a data/hora.");

    setStatus("Enviando vídeo...");

    const fd = new FormData();
    fd.append("file", file);

    const upRes = await fetch("/api/upload", { method: "POST", body: fd });
    const upJson = await upRes.json();

    if (!upJson.ok) {
      setStatus("Erro upload: " + upJson.error);
      return;
    }

    setStatus("Agendando...");

    const scRes = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_path: upJson.video_path,
        caption,
        scheduled_at: new Date(scheduledAt).toISOString(),
      }),
    });

    const scJson = await scRes.json();

    if (!scJson.ok) {
      setStatus("Erro schedule: " + scJson.error);
      return;
    }

    setStatus("✅ Agendado! Post ID: " + scJson.post_id);
  }

  return (
    <main className="min-h-screen p-8 flex items-center justify-center">
      <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-black/40 p-6">
        <h1 className="text-2xl font-semibold mb-4">Video Publisher (MVP)</h1>

        <label className="block text-sm mb-2">Vídeo</label>
        <input
          type="file"
          accept="video/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="mb-4 w-full"
        />

        <label className="block text-sm mb-2">Legenda</label>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          className="mb-4 w-full rounded-lg bg-black/20 border border-white/10 p-2"
          rows={4}
        />

        <label className="block text-sm mb-2">Agendar (data/hora)</label>
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          className="mb-4 w-full rounded-lg bg-black/20 border border-white/10 p-2"
        />

        <button
          onClick={handleSubmit}
          className="w-full rounded-xl bg-white text-black font-medium py-2"
        >
          Enviar e agendar
        </button>

        {status && (
          <p className="mt-4 text-sm opacity-90 whitespace-pre-wrap">{status}</p>
        )}
      </div>
    </main>
  );
}
