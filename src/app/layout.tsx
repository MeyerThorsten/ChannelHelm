import { NavBar } from '@/components/NavBar';
import { Instrument_Serif, Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});
const instrument = Instrument_Serif({
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  variable: '--font-instrument',
  display: 'swap',
});

export const metadata = {
  title: 'ChannelHelm — Studio',
  description: 'Local-first video-to-publishing command center',
};

// Set the theme before paint to avoid a flash of the wrong theme (default: dark).
const THEME_INIT = `(function(){try{var t=localStorage.getItem('ch-theme')||'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: tiny pre-paint theme setter */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className={`${inter.variable} ${jetbrains.variable} ${instrument.variable}`}>
        <NavBar />
        {children}
      </body>
    </html>
  );
}
