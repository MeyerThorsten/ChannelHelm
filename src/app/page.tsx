export default function HomePage() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 640 }}>
      <h1 style={{ marginBottom: '0.5rem' }}>ChannelHelm</h1>
      <p style={{ color: '#555' }}>
        Local-first video-to-publishing command center. Dashboard arrives in Session 10.
      </p>
      <p style={{ marginTop: '1.5rem', fontSize: '0.875rem', color: '#888' }}>
        API: <code>/api/brands</code>, <code>/api/sources</code>, <code>/api/packages</code>,{' '}
        <code>/api/assets</code>. Auth: <code>Authorization: Bearer $LOCAL_BEARER_TOKEN</code>.
      </p>
    </main>
  );
}
