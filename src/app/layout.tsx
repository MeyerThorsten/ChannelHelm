import type { ReactNode } from 'react';

export const metadata = {
  title: 'ChannelHelm',
  description: 'Local-first video-to-publishing command center',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
