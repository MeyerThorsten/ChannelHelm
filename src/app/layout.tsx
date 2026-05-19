import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'ChannelHelm',
  description: 'Local-first video-to-publishing command center',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
