export function VideoPlayer({ src, poster }: { src: string | null; poster?: string | null }) {
  if (!src) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-xl border border-dashed border-zinc-300 text-sm text-zinc-500 dark:border-zinc-700">
        Video not available yet — ingest still running.
      </div>
    );
  }
  return (
    <video
      controls
      preload="metadata"
      poster={poster ?? undefined}
      className="aspect-video w-full rounded-xl border border-zinc-200 bg-black dark:border-zinc-800"
    >
      <source src={src} />
      <track kind="captions" />
      Your browser does not support the video tag.
    </video>
  );
}
